use crate::manager::recruit_agents_via_manager;
use crate::store::ChatroomStore;
use crate::types::*;
use chrono::Utc;
use futures::StreamExt;
use openresponses_rust::MessageContent;
use ragents_client::RagentsClient;
use ragents_protocol::*;
use rand::Rng;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone)]
struct DirectMentionState {
    from_human: bool,
    spoke: bool,
    nudged: bool,
}

#[derive(Debug, Default)]
struct RoomPeekState {
    /// Sorted queue of `(agent_id, roll)` waiting to peek with interjection permission (`roll >= mute_probability`)
    eligible_queue: VecDeque<(String, u8)>,
    /// Agents that rolled `< mute_probability` (or when `interject_enabled == false`) waiting for muted read-only sync
    muted_queue: VecDeque<(String, u8)>,
    /// Currently peeking agent ID in the sequential loop
    active_peeking_agent_id: Option<String>,
    /// Generation counter to cancel stale debounce timers when new messages arrive
    timer_generation: u64,
}

#[derive(Clone)]
pub struct RoomCoordinator {
    pub store: ChatroomStore,
    pub ragents_client: RagentsClient,
    pub callback_base_url: String,
    pub chatroom_wasm_path: PathBuf,
    pub compaction_wasm_path: Option<PathBuf>,
    pub room_event_tx: broadcast::Sender<ChatroomEvent>,
    pub inspector_event_tx: broadcast::Sender<SessionEventEnvelope>,
    direct_mentions: Arc<Mutex<HashMap<String, DirectMentionState>>>,
    room_peek_states: Arc<Mutex<HashMap<String, RoomPeekState>>>,
}

impl RoomCoordinator {
    pub fn new(
        store: ChatroomStore,
        ragents_client: RagentsClient,
        callback_base_url: String,
        chatroom_wasm_path: PathBuf,
        compaction_wasm_path: Option<PathBuf>,
    ) -> Self {
        let (room_event_tx, _) = broadcast::channel(1024);
        let (inspector_event_tx, _) = broadcast::channel(2048);
        Self {
            store,
            ragents_client,
            callback_base_url,
            chatroom_wasm_path,
            compaction_wasm_path,
            room_event_tx,
            inspector_event_tx,
            direct_mentions: Arc::new(Mutex::new(HashMap::new())),
            room_peek_states: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn subscribe_room_events(&self) -> broadcast::Receiver<ChatroomEvent> {
        self.room_event_tx.subscribe()
    }

    pub fn subscribe_inspector_events(&self) -> broadcast::Receiver<SessionEventEnvelope> {
        self.inspector_event_tx.subscribe()
    }

    pub fn emit_room_event(&self, event: ChatroomEvent) {
        let _ = self.room_event_tx.send(event);
    }

    pub fn spawn_background_watcher(&self, cancel: CancellationToken) {
        let coord = self.clone();
        tokio::spawn(async move {
            let mut after_rv = 0u64;
            loop {
                if cancel.is_cancelled() {
                    break;
                }
                match coord.ragents_client.watch_events(None, after_rv).await {
                    Ok(mut stream) => {
                        loop {
                            tokio::select! {
                                item = stream.next() => {
                                    match item {
                                        Some(Ok(env)) => {
                                            let rv = env.resource_version.value();
                                            if rv > after_rv {
                                                after_rv = rv;
                                            }
                                            let _ = coord.inspector_event_tx.send(env.clone());
                                            coord.handle_ragents_event(env).await;
                                        }
                                        Some(Err(_)) | None => break,
                                    }
                                }
                                _ = cancel.cancelled() => return,
                            }
                        }
                    }
                    Err(_) => {}
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(300)) => {}
                    _ = cancel.cancelled() => return,
                }
            }
        });
    }

    async fn handle_ragents_event(&self, env: SessionEventEnvelope) {
        match env.event {
            SessionEvent::ActivationScheduled { .. } | SessionEvent::ActivationStarted { .. } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    if let Ok(updated) = self.store.update_agent_runtime_state(
                        &agent.agent_id,
                        AgentRuntimeState::Thinking,
                        env.activation_id.clone(),
                    ) {
                        self.emit_room_event(ChatroomEvent::AgentUpdated {
                            room_id: updated.room_id.clone(),
                            agent: updated.clone().into(),
                        });
                        self.emit_room_event(ChatroomEvent::AgentActivity {
                            room_id: updated.room_id,
                            agent_id: updated.agent_id,
                            activity: "🚀 已调度至节点，准备启动回合...".to_string(),
                        });
                    }
                }
            }
            SessionEvent::TurnStarted => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    self.emit_room_event(ChatroomEvent::AgentActivity {
                        room_id: agent.room_id,
                        agent_id: agent.agent_id,
                        activity: "🧠 模型正在思考/推理中...".to_string(),
                    });
                }
            }
            SessionEvent::ModelReasoningDelta { .. } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    self.emit_room_event(ChatroomEvent::AgentActivity {
                        room_id: agent.room_id,
                        agent_id: agent.agent_id,
                        activity: "💭 正在输出思维链 (Reasoning)...".to_string(),
                    });
                }
            }
            SessionEvent::ModelTextDelta { .. } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    self.emit_room_event(ChatroomEvent::AgentActivity {
                        room_id: agent.room_id,
                        agent_id: agent.agent_id,
                        activity: "✍️ 正在生成内部响应...".to_string(),
                    });
                }
            }
            SessionEvent::ToolCallStarted { name, .. } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    self.emit_room_event(ChatroomEvent::AgentActivity {
                        room_id: agent.room_id,
                        agent_id: agent.agent_id,
                        activity: format!("🔧 正在调用工具: {name} ..."),
                    });
                }
            }
            SessionEvent::ToolCallFinished {
                name, duration_ms, ..
            } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    self.emit_room_event(ChatroomEvent::AgentActivity {
                        room_id: agent.room_id,
                        agent_id: agent.agent_id,
                        activity: format!("✅ 工具 {name} 执行完成 ({duration_ms}ms)"),
                    });
                }
            }
            SessionEvent::PermissionRequested { request } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    let act_id = env
                        .activation_id
                        .clone()
                        .unwrap_or_else(|| request.activation_id.clone());
                    if let Ok(updated) = self.store.update_agent_runtime_state(
                        &agent.agent_id,
                        AgentRuntimeState::WaitingPermission,
                        Some(act_id.clone()),
                    ) {
                        self.emit_room_event(ChatroomEvent::AgentUpdated {
                            room_id: updated.room_id.clone(),
                            agent: updated.clone().into(),
                        });
                        self.emit_room_event(ChatroomEvent::PermissionAlert {
                            room_id: updated.room_id,
                            agent_id: updated.agent_id,
                            agent_name: updated.name,
                            activation_id: act_id,
                            request,
                        });
                    }
                }
            }
            SessionEvent::PermissionResolved { .. } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    if let Ok(updated) = self.store.update_agent_runtime_state(
                        &agent.agent_id,
                        AgentRuntimeState::Thinking,
                        env.activation_id.clone().or(agent.active_activation_id),
                    ) {
                        self.emit_room_event(ChatroomEvent::AgentUpdated {
                            room_id: updated.room_id.clone(),
                            agent: updated.into(),
                        });
                    }
                }
            }
            SessionEvent::SessionCompacted {
                from_session_id,
                compaction_session_id,
                continued_session_id,
                continued_activation_id,
                compaction_generation,
                tokens_before,
                ..
            } => {
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&from_session_id) {
                    if let Ok(updated) = self.store.update_agent_compaction(
                        &agent.agent_id,
                        compaction_session_id,
                        continued_session_id,
                        continued_activation_id,
                        compaction_generation,
                        tokens_before,
                    ) {
                        self.emit_room_event(ChatroomEvent::AgentUpdated {
                            room_id: updated.room_id.clone(),
                            agent: updated.into(),
                        });
                    }
                }
            }
            SessionEvent::ActivationCompleted { .. }
            | SessionEvent::ActivationFailed { .. }
            | SessionEvent::ActivationCancelled
            | SessionEvent::ActivationInterrupted { .. } => {
                let is_completed_ok = matches!(env.event, SessionEvent::ActivationCompleted { .. });
                let fail_err = match &env.event {
                    SessionEvent::ActivationFailed { error } => Some(error.clone()),
                    _ => None,
                };
                if let Ok(Some(agent)) = self.store.get_agent_by_session(&env.session_id) {
                    if let Ok(updated) = self.store.update_agent_runtime_state(
                        &agent.agent_id,
                        AgentRuntimeState::Idle,
                        None,
                    ) {
                        self.emit_room_event(ChatroomEvent::AgentUpdated {
                            room_id: updated.room_id.clone(),
                            agent: updated.clone().into(),
                        });
                        if let Some(err_msg) = fail_err {
                            self.emit_room_event(ChatroomEvent::AgentActivity {
                                room_id: updated.room_id.clone(),
                                agent_id: updated.agent_id.clone(),
                                activity: format!("❌ 执行异常: {err_msg}"),
                            });
                            if let Ok((sys_msg, updated_room)) = self.store.append_message(
                                &updated.room_id,
                                SenderKind::System,
                                "system",
                                "System",
                                format!("⚠️ @{} 内部执行报错：{}", updated.name, err_msg),
                                vec![],
                                vec![],
                                None,
                                Some(env.session_id.clone()),
                                env.activation_id.clone(),
                            ) {
                                self.emit_room_event(ChatroomEvent::MessagePosted {
                                    room_id: updated.room_id.clone(),
                                    message: sys_msg,
                                });
                                self.emit_room_event(ChatroomEvent::RoomUpdated {
                                    room_id: updated.room_id.clone(),
                                    room: updated_room,
                                });
                            }
                        } else {
                            self.emit_room_event(ChatroomEvent::AgentActivity {
                                room_id: updated.room_id.clone(),
                                agent_id: updated.agent_id.clone(),
                                activity: String::new(),
                            });
                        }
                        self.on_agent_activation_finished(&updated, is_completed_ok)
                            .await;
                    }
                }
            }
            _ => {}
        }
    }

    async fn on_agent_activation_finished(&self, agent: &RoomAgent, completed_ok: bool) {
        // 1. Check Direct-@ Auto-Nudge: if agent was explicitly @mentioned by a Human, completed without error,
        //    and forgot to call `chatroom_speak`, send 1 lightweight reminder!
        //    (When @mentioned by another Agent, silent observation `Observed.` is allowed to avoid polite ack loops.)
        let should_nudge = {
            let mut dm_guard = self
                .direct_mentions
                .lock()
                .expect("direct_mentions mutex poisoned");
            if let Some(state) = dm_guard.get_mut(&agent.agent_id) {
                if completed_ok && state.from_human && !state.spoke && !state.nudged {
                    state.nudged = true;
                    true
                } else {
                    dm_guard.remove(&agent.agent_id);
                    false
                }
            } else {
                false
            }
        };

        if should_nudge {
            let nudge_text = format!(
                "[System Reminder for @{}]: You were explicitly @mentioned in the chatroom and finished your internal turn, \
                 but you did NOT call `chatroom_speak`. Nobody in the chatroom can see your internal output. \
                 Please call `chatroom_speak` now to post your reply or status update to the chatroom.",
                agent.name
            );
            let _ = self.store.prepare_agent_delivery(
                &agent.agent_id,
                agent.last_delivered_seq,
                agent.last_roster_version,
                true,
            );
            let _ = self
                .ragents_client
                .push_realtime_message(
                    &agent.active_session_id,
                    PushRealtimeMessageRequest::from_text(nudge_text),
                )
                .await;
            return;
        }

        // 2. Check if this agent was the active candidate in the room's sequential peek queue
        let advance_peek = {
            let mut peek_guard = self
                .room_peek_states
                .lock()
                .expect("room_peek_states mutex poisoned");
            if let Some(st) = peek_guard.get_mut(&agent.room_id) {
                if st.active_peeking_agent_id.as_deref() == Some(agent.agent_id.as_str()) {
                    st.active_peeking_agent_id = None;
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };

        if advance_peek {
            self.step_sequential_peek_queue(&agent.room_id).await;
        } else {
            self.schedule_room_peek_if_ready(&agent.room_id);
        }
    }

    pub async fn create_room_with_default_agent(
        &self,
        req: CreateRoomRequest,
    ) -> anyhow::Result<RoomDetailResponse> {
        let mgr = self.store.get_manager_settings()?;
        let room = self.store.create_room(&req.name, &req.description)?;

        let default_name = req
            .default_agent_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Assistant".to_string());
        let default_role = req
            .default_agent_role
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "全能 AI 研发助手".to_string());
        let default_persona = req
            .default_agent_persona
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                "You are a helpful, pragmatic software engineering and research assistant."
                    .to_string()
            });

        let agent = self
            .create_agent_in_room(
                &room.room_id,
                CreateAgentRequest {
                    name: default_name,
                    role_title: default_role,
                    avatar: "🤖".to_string(),
                    persona_prompt: default_persona,
                    model: req.default_agent_model.or(Some(mgr.default_agent_model)),
                    reasoning_effort: req.reasoning_effort.or(mgr.default_reasoning_effort),
                    reasoning_summary: req.reasoning_summary.or(mgr.default_reasoning_summary),
                    node_id: req.node_id.or(mgr.default_node_id),
                    workspace_path: req.workspace_path.or(mgr.default_workspace_root),
                },
                "system",
            )
            .await?;

        let updated_room = self.store.get_room(&room.room_id)?.unwrap_or(room);
        Ok(RoomDetailResponse {
            room: updated_room,
            agents: vec![agent.into()],
            messages: vec![],
        })
    }

    pub async fn create_agent_in_room(
        &self,
        room_id: &str,
        req: CreateAgentRequest,
        created_by: &str,
    ) -> anyhow::Result<RoomAgent> {
        let room = self
            .store
            .get_room(room_id)?
            .ok_or_else(|| anyhow::anyhow!("room {room_id} not found"))?;
        let mgr = self.store.get_manager_settings()?;

        let clean_name: String = req
            .name
            .trim()
            .trim_start_matches('@')
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if clean_name.is_empty() || clean_name.eq_ignore_ascii_case("Manager") {
            anyhow::bail!("Invalid or reserved agent name '{}'", req.name);
        }

        let agent_id = format!("agt_{}", Uuid::now_v7());
        let agent_secret_token = format!("agtok_{}{}", Uuid::now_v7(), Uuid::new_v4());
        let model_name = req
            .model
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(mgr.default_agent_model);
        let reasoning_effort = req
            .reasoning_effort
            .filter(|s| !s.trim().is_empty())
            .or(mgr.default_reasoning_effort);
        let reasoning_summary = req
            .reasoning_summary
            .filter(|s| !s.trim().is_empty())
            .or(mgr.default_reasoning_summary);
        let reasoning_cfg = build_reasoning_config(
            reasoning_effort.as_deref(),
            reasoning_summary.as_deref(),
        );

        let scheduling = match (
            req.node_id.filter(|s| !s.trim().is_empty()),
            req.workspace_path.filter(|s| !s.trim().is_empty()),
        ) {
            (Some(n), Some(w)) => {
                let p = Path::new(&w);
                let abs_w = if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    std::env::current_dir()?.join(p)
                };
                let _ = std::fs::create_dir_all(&abs_w);
                SchedulingMode::Pinned {
                    node_id: NodeId::new(n),
                    workspace_path: abs_w,
                }
            }
            _ => SchedulingMode::Floating {
                node_selector: BTreeMap::new(),
            },
        };

        let mut extensions = mgr.default_extensions;
        extensions.retain(|e| e.name != "chatroom");

        if let Some(ref compact_wasm) = self.compaction_wasm_path {
            if compact_wasm.exists() && !extensions.iter().any(|e| e.name == "compaction") {
                extensions.push(ExtensionSpec {
                    name: "compaction".to_string(),
                    path: compact_wasm.to_string_lossy().to_string(),
                    enabled: true,
                    config: serde_json::json!({
                        "enabled": true,
                        "trigger_tokens": 64000,
                        "keep_recent_tokens": 20000
                    }),
                    allowed_dirs: vec![],
                });
            }
        }

        let callback_url = format!(
            "{}/api/v1/internal/agent-speak",
            self.callback_base_url.trim_end_matches('/')
        );
        extensions.push(ExtensionSpec {
            name: "chatroom".to_string(),
            path: self.chatroom_wasm_path.to_string_lossy().to_string(),
            enabled: true,
            config: serde_json::json!({
                "chatroom_callback_url": callback_url,
                "room_id": room.room_id,
                "room_name": room.name,
                "agent_id": agent_id,
                "agent_name": clean_name,
                "agent_role": req.role_title,
                "agent_token": agent_secret_token,
            }),
            allowed_dirs: vec![],
        });

        let mut labels = BTreeMap::new();
        labels.insert("ragents.chat.room_id".to_string(), room.room_id.clone());
        labels.insert("ragents.chat.agent_id".to_string(), agent_id.clone());
        labels.insert("ragents.chat.agent_name".to_string(), clean_name.clone());

        let mut permissions = PermissionPolicyLayer::default();
        permissions.http_hosts = Some(RuleSet {
            deny: None,
            allow: Some(vec!["*".to_string()]),
            default: Some(DefaultPermissionDecision::Allow),
        });

        let created_sess = self
            .ragents_client
            .create_session(CreateSessionRequest {
                session_id: None,
                labels,
                spec: SessionSpec {
                    scheduling: scheduling.clone(),
                    sources: vec![],
                    producer: None,
                    desired_phase: DesiredSessionPhase::Open,
                    system_prompt: Some(req.persona_prompt.clone()),
                    model: Some(ModelRequestSpec {
                        name: model_name.clone(),
                        temperature: None,
                        max_output_tokens: None,
                        reasoning: reasoning_cfg,
                    }),
                    extensions,
                    permissions,
                },
                initial_activation: None,
            })
            .await?;

        let sess_id = SessionId::new(created_sess.session.metadata.id);
        let now = Utc::now();
        let agent = RoomAgent {
            agent_id,
            room_id: room.room_id,
            name: clean_name,
            role_title: req.role_title,
            avatar: if req.avatar.trim().is_empty() {
                "🤖".to_string()
            } else {
                req.avatar
            },
            persona_prompt: req.persona_prompt,
            model: model_name,
            reasoning_effort,
            reasoning_summary,
            scheduling,
            root_session_id: sess_id.clone(),
            active_session_id: sess_id.clone(),
            session_chain: vec![SessionChainEntry {
                generation: 0,
                working_session_id: sess_id,
                compaction_session_id: None,
                tokens_before: None,
                created_at: now,
            }],
            last_delivered_seq: room.last_msg_seq,
            last_roster_version: 0,
            allow_speak_in_turn: true,
            runtime_state: AgentRuntimeState::Idle,
            active_activation_id: None,
            agent_secret_token,
            created_by: created_by.to_string(),
            created_at: now,
        };

        let (inserted, updated_room) = self.store.insert_agent(agent)?;
        self.emit_room_event(ChatroomEvent::AgentUpdated {
            room_id: updated_room.room_id.clone(),
            agent: inserted.clone().into(),
        });
        self.emit_room_event(ChatroomEvent::RoomUpdated {
            room_id: updated_room.room_id.clone(),
            room: updated_room,
        });
        Ok(inserted)
    }

    pub async fn patch_agent_in_room(
        &self,
        room_id: &str,
        agent_id: &str,
        patch: PatchAgentRequest,
    ) -> anyhow::Result<RoomAgent> {
        let existing = self
            .store
            .get_agent(agent_id)?
            .ok_or_else(|| anyhow::anyhow!("agent {agent_id} not found"))?;
        if existing.room_id != room_id {
            anyhow::bail!("agent {agent_id} does not belong to room {room_id}");
        }

        let updated = self
            .store
            .update_agent_model_and_reasoning(agent_id, patch)?;
        let reasoning_cfg = build_reasoning_config(
            updated.reasoning_effort.as_deref(),
            updated.reasoning_summary.as_deref(),
        );
        let _ = self
            .ragents_client
            .patch_session(
                &updated.active_session_id,
                PatchSessionSpecRequest {
                    desired_phase: None,
                    system_prompt: None,
                    model: Some(ModelRequestSpec {
                        name: updated.model.clone(),
                        temperature: None,
                        max_output_tokens: None,
                        reasoning: reasoning_cfg,
                    }),
                    extensions: None,
                    permissions: None,
                },
            )
            .await;

        self.emit_room_event(ChatroomEvent::AgentUpdated {
            room_id: room_id.to_string(),
            agent: updated.clone().into(),
        });
        Ok(updated)
    }

    pub async fn remove_agent_from_room(
        &self,
        room_id: &str,
        agent_id: &str,
    ) -> anyhow::Result<()> {
        let removed = self.store.remove_agent(room_id, agent_id)?;
        let _ = self
            .ragents_client
            .patch_session(
                &removed.active_session_id,
                PatchSessionSpecRequest {
                    desired_phase: Some(DesiredSessionPhase::Closed),
                    system_prompt: None,
                    model: None,
                    extensions: None,
                    permissions: None,
                },
            )
            .await;
        self.emit_room_event(ChatroomEvent::AgentRemoved {
            room_id: room_id.to_string(),
            agent_id: agent_id.to_string(),
        });
        if let Ok(Some(room)) = self.store.get_room(room_id) {
            self.emit_room_event(ChatroomEvent::RoomUpdated {
                room_id: room_id.to_string(),
                room,
            });
        }
        Ok(())
    }

    pub async fn delete_room_and_sessions(&self, room_id: &str) -> anyhow::Result<()> {
        let agents = self.store.delete_room(room_id)?;
        for agent in agents {
            let _ = self
                .ragents_client
                .patch_session(
                    &agent.active_session_id,
                    PatchSessionSpecRequest {
                        desired_phase: Some(DesiredSessionPhase::Closed),
                        system_prompt: None,
                        model: None,
                        extensions: None,
                        permissions: None,
                    },
                )
                .await;
        }
        Ok(())
    }

    pub async fn post_human_message(
        &self,
        room_id: &str,
        req: PostMessageRequest,
    ) -> anyhow::Result<RoomMessage> {
        let agents = self.store.list_room_agents(room_id)?;
        let mut mentions = parse_mentions(&req.content, &req.mentions, &agents);

        // Single-chat rule: if the room has only 1 agent and the human didn't explicitly @Manager or @Agent,
        // automatically @ that sole agent!
        if mentions.is_empty() && agents.len() == 1 {
            mentions.push(agents[0].name.clone());
        }

        let visible_to = resolve_explicit_mentions(&req.visible_to, &agents, None);
        let (msg, updated_room) = self.store.append_message(
            room_id,
            SenderKind::Human,
            "human",
            if req.sender_name.trim().is_empty() {
                "Human"
            } else {
                req.sender_name.trim()
            },
            req.content,
            mentions,
            visible_to,
            req.reply_to_seq,
            None,
            None,
        )?;

        self.emit_room_event(ChatroomEvent::MessagePosted {
            room_id: room_id.to_string(),
            message: msg.clone(),
        });
        self.emit_room_event(ChatroomEvent::RoomUpdated {
            room_id: room_id.to_string(),
            room: updated_room,
        });

        self.dispatch_after_message(msg.clone()).await;
        Ok(msg)
    }

    pub async fn handle_internal_agent_speak(
        &self,
        bearer_token: Option<&str>,
        req: InternalAgentSpeakRequest,
    ) -> Result<RoomMessage, (u16, String)> {
        let agent = self
            .store
            .get_agent(&req.agent_id)
            .map_err(|e| (500, e.to_string()))?
            .ok_or_else(|| (404, format!("agent {} not found", req.agent_id)))?;

        if agent.room_id != req.room_id {
            return Err((403, "agent does not belong to target room".to_string()));
        }

        let provided = bearer_token.unwrap_or("");
        if !constant_time_eq(provided, &agent.agent_secret_token) {
            return Err((401, "invalid agent_secret_token".to_string()));
        }

        if !agent.allow_speak_in_turn {
            return Err((
                403,
                "Permission denied: You are muted for this peek turn (read-only observation)."
                    .to_string(),
            ));
        }

        let agents = self
            .store
            .list_room_agents(&req.room_id)
            .map_err(|e| (500, e.to_string()))?;
        let mentions = resolve_explicit_mentions(&req.mentions, &agents, Some(&agent.name));
        let mut visible_to = resolve_explicit_mentions(&req.visible_to, &agents, None);
        // If `visible_to` is specified, ensure any explicitly @mentioned target can also see the message
        if !visible_to.is_empty() {
            for m in &mentions {
                if !visible_to.iter().any(|v| v.eq_ignore_ascii_case(m)) {
                    visible_to.push(m.clone());
                }
            }
        }
        let cleaned_content = strip_leading_redundant_mentions(&req.content, &mentions);

        // Mark that this agent has spoken in its current turn
        {
            let mut dm_guard = self
                .direct_mentions
                .lock()
                .expect("direct_mentions mutex poisoned");
            if let Some(st) = dm_guard.get_mut(&agent.agent_id) {
                st.spoke = true;
            }
        }

        // Interrupt any ongoing sequential peek queue for this room because a new message just arrived!
        {
            let mut peek_guard = self
                .room_peek_states
                .lock()
                .expect("room_peek_states mutex poisoned");
            if let Some(st) = peek_guard.get_mut(&req.room_id) {
                st.eligible_queue.clear();
                st.muted_queue.clear();
                st.active_peeking_agent_id = None;
                st.timer_generation += 1;
            }
        }

        let (msg, updated_room) = self
            .store
            .append_message(
                &req.room_id,
                SenderKind::Agent,
                &agent.agent_id,
                &agent.name,
                cleaned_content,
                mentions,
                visible_to,
                req.reply_to_seq,
                Some(agent.active_session_id),
                agent.active_activation_id,
            )
            .map_err(|e| (500, e.to_string()))?;

        self.emit_room_event(ChatroomEvent::MessagePosted {
            room_id: req.room_id.clone(),
            message: msg.clone(),
        });
        self.emit_room_event(ChatroomEvent::RoomUpdated {
            room_id: req.room_id.clone(),
            room: updated_room,
        });

        let coord = self.clone();
        let msg_clone = msg.clone();
        tokio::spawn(async move {
            coord.dispatch_after_message(msg_clone).await;
        });

        Ok(msg)
    }

    pub fn dispatch_after_message<'a>(
        &'a self,
        msg: RoomMessage,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let Ok(Some(room)) = self.store.get_room(&msg.room_id) else {
                return;
            };
            let Ok(agents) = self.store.list_room_agents(&msg.room_id) else {
                return;
            };

            // Check relay depth guard when an Agent sends a message (0 means unlimited)
            if msg.sender_kind == SenderKind::Agent
                && room.max_agent_relay_depth > 0
                && room.consecutive_agent_msgs >= room.max_agent_relay_depth
            {
                if let Ok((sys_msg, updated_room)) = self.store.append_message(
                    &room.room_id,
                    SenderKind::System,
                    "system",
                    "System",
                    format!(
                        "群内 Agent 已连续发言达到上限 ({} 轮)，已自动暂停接力。人类发言或点击“继续讨论”即可恢复。",
                        room.max_agent_relay_depth
                    ),
                    vec![],
                    vec![],
                    None,
                    None,
                    None,
                ) {
                    self.emit_room_event(ChatroomEvent::MessagePosted {
                        room_id: room.room_id.clone(),
                        message: sys_msg,
                    });
                    self.emit_room_event(ChatroomEvent::RoomUpdated {
                        room_id: room.room_id.clone(),
                        room: updated_room,
                    });
                }
                return;
            }

            // 1. Check if `@Manager` was mentioned
            if msg
                .mentions
                .iter()
                .any(|m| m.eq_ignore_ascii_case("Manager"))
            {
                let coord = self.clone();
                let room_id = room.room_id.clone();
                let req_text = msg.content.clone();
                let caller_agent = if msg.sender_kind == SenderKind::Agent {
                    Some(msg.sender_name.clone())
                } else {
                    None
                };
                tokio::spawn(async move {
                    let _ = recruit_agents_via_manager(
                        &coord,
                        &room_id,
                        &req_text,
                        caller_agent.as_deref(),
                    )
                    .await;
                });
            }

            // 2. Wake up any explicitly @mentioned RoomAgents immediately via `push_realtime_message`
            let mut mentioned_agent_ids = HashSet::new();
            let from_human = msg.sender_kind == SenderKind::Human;
            for mention_name in &msg.mentions {
                if let Some(target_agent) = agents
                    .iter()
                    .find(|a| a.name.eq_ignore_ascii_case(mention_name))
                {
                    if target_agent.agent_id == msg.sender_id {
                        continue;
                    }
                    mentioned_agent_ids.insert(target_agent.agent_id.clone());
                    let _ = self
                        .deliver_direct_mention_to_agent(&room, &agents, target_agent, from_human)
                        .await;
                }
            }

            // 3. If no agents were explicitly @mentioned (or after they finish), schedule the room's Peek & Interjection check
            if mentioned_agent_ids.is_empty() {
                self.schedule_room_peek_if_ready(&room.room_id);
            }
        })
    }

    async fn deliver_direct_mention_to_agent(
        &self,
        room: &Room,
        all_agents: &[RoomAgent],
        target_agent: &RoomAgent,
        from_human: bool,
    ) -> anyhow::Result<()> {
        let unread = self.store.list_room_messages_for_agent(
            &room.room_id,
            target_agent.last_delivered_seq,
            &target_agent.name,
        )?;
        if unread.is_empty() {
            return Ok(());
        }

        let max_seq = room.last_msg_seq;
        let formatted = format_delivery_payload(
            room,
            all_agents,
            target_agent,
            &unread,
            DeliveryMode::DirectMention,
        );

        let updated_agent = self.store.prepare_agent_delivery(
            &target_agent.agent_id,
            max_seq,
            room.roster_version,
            true,
        )?;

        {
            let mut dm_guard = self
                .direct_mentions
                .lock()
                .expect("direct_mentions mutex poisoned");
            dm_guard.insert(
                target_agent.agent_id.clone(),
                DirectMentionState {
                    from_human,
                    spoke: false,
                    nudged: false,
                },
            );
        }

        let resp = self
            .ragents_client
            .push_realtime_message(
                &updated_agent.active_session_id,
                PushRealtimeMessageRequest {
                    content: vec![MessageContent::InputText { text: formatted }],
                },
            )
            .await?;

        if let Some(spawned_act_id) = resp.spawned_activation_id {
            if let Ok(thinking_agent) = self.store.update_agent_runtime_state(
                &target_agent.agent_id,
                AgentRuntimeState::Thinking,
                Some(spawned_act_id),
            ) {
                self.emit_room_event(ChatroomEvent::AgentUpdated {
                    room_id: room.room_id.clone(),
                    agent: thinking_agent.into(),
                });
            }
        }
        Ok(())
    }

    pub fn schedule_room_peek_if_ready(&self, room_id: &str) {
        let Ok(Some(room)) = self.store.get_room(room_id) else {
            return;
        };
        if !room.peek_enabled
            || (room.max_agent_relay_depth > 0
                && room.consecutive_agent_msgs >= room.max_agent_relay_depth)
        {
            return;
        }

        let my_gen = {
            let mut guard = self
                .room_peek_states
                .lock()
                .expect("room_peek_states mutex poisoned");
            let st = guard.entry(room_id.to_string()).or_default();
            if st.active_peeking_agent_id.is_some() || !st.eligible_queue.is_empty() {
                return;
            }
            st.timer_generation += 1;
            st.timer_generation
        };

        let delay_ms = (room.peek_idle_secs * 1000).max(200);
        let coord = self.clone();
        let room_id_owned = room_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let still_valid = {
                let guard = coord
                    .room_peek_states
                    .lock()
                    .expect("room_peek_states mutex poisoned");
                guard
                    .get(&room_id_owned)
                    .map(|st| st.timer_generation == my_gen && st.active_peeking_agent_id.is_none())
                    .unwrap_or(false)
            };
            if still_valid {
                coord.start_peek_and_interject_round(&room_id_owned).await;
            }
        });
    }

    async fn start_peek_and_interject_round(&self, room_id: &str) {
        let Ok(Some(room)) = self.store.get_room(room_id) else {
            return;
        };
        if !room.peek_enabled
            || (room.max_agent_relay_depth > 0
                && room.consecutive_agent_msgs >= room.max_agent_relay_depth)
        {
            return;
        }

        let Ok(agents) = self.store.list_room_agents(room_id) else {
            return;
        };

        // Wait until all agents in the room are Idle before starting a Peek & Interject round
        if agents
            .iter()
            .any(|a| a.runtime_state != AgentRuntimeState::Idle)
        {
            return;
        }

        // Find all agents that have unread messages meeting `peek_msg_interval`
        let candidates: Vec<&RoomAgent> = agents
            .iter()
            .filter(|a| {
                let unread_count = room.last_msg_seq.saturating_sub(a.last_delivered_seq);
                unread_count >= u64::from(room.peek_msg_interval.max(1))
            })
            .collect();

        if candidates.is_empty() {
            return;
        }

        // Roll 0..=100 for each candidate agent, filter by `mute_probability`, and sort eligible descending!
        let mut eligible = Vec::new();
        let mut muted = Vec::new();
        {
            let mut rng = rand::thread_rng();
            for ag in candidates {
                let roll: u8 = rng.gen_range(0..=100);
                if room.interject_enabled && roll >= room.mute_probability {
                    eligible.push((ag.agent_id.clone(), roll));
                } else {
                    muted.push((ag.agent_id.clone(), roll));
                }
            }
        }
        eligible.sort_by(|a, b| b.1.cmp(&a.1));

        {
            let mut guard = self
                .room_peek_states
                .lock()
                .expect("room_peek_states mutex poisoned");
            let st = guard.entry(room_id.to_string()).or_default();
            st.eligible_queue = eligible.into_iter().collect();
            st.muted_queue = muted.into_iter().collect();
            st.active_peeking_agent_id = None;
        }

        self.step_sequential_peek_queue(room_id).await;
    }

    fn step_sequential_peek_queue<'a>(
        &'a self,
        room_id: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let Ok(Some(room)) = self.store.get_room(room_id) else {
                return;
            };
            if !room.peek_enabled
                || (room.max_agent_relay_depth > 0
                    && room.consecutive_agent_msgs >= room.max_agent_relay_depth)
            {
                return;
            }
            let Ok(all_agents) = self.store.list_room_agents(room_id) else {
                return;
            };

            let next_pick: Option<(String, u8, bool)> = {
                let mut guard = self
                    .room_peek_states
                    .lock()
                    .expect("room_peek_states mutex poisoned");
                let Some(st) = guard.get_mut(room_id) else {
                    return;
                };
                if st.active_peeking_agent_id.is_some() {
                    return;
                }
                if let Some((aid, roll)) = st.eligible_queue.pop_front() {
                    st.active_peeking_agent_id = Some(aid.clone());
                    Some((aid, roll, true))
                } else if let Some((aid, roll)) = st.muted_queue.pop_front() {
                    st.active_peeking_agent_id = Some(aid.clone());
                    Some((aid, roll, false))
                } else {
                    None
                }
            };

            let Some((agent_id, roll, allow_speak)) = next_pick else {
                return;
            };

            let Some(target_agent) = all_agents.iter().find(|a| a.agent_id == agent_id) else {
                {
                    let mut guard = self
                        .room_peek_states
                        .lock()
                        .expect("room_peek_states mutex poisoned");
                    if let Some(st) = guard.get_mut(room_id) {
                        st.active_peeking_agent_id = None;
                    }
                }
                self.step_sequential_peek_queue(room_id).await;
                return;
            };

            let Ok(unread) = self.store.list_room_messages_for_agent(
                room_id,
                target_agent.last_delivered_seq,
                &target_agent.name,
            ) else {
                return;
            };
            if unread.is_empty() {
                let _ = self.store.prepare_agent_delivery(
                    &target_agent.agent_id,
                    room.last_msg_seq,
                    target_agent.last_roster_version,
                    true,
                );
                {
                    let mut guard = self
                        .room_peek_states
                        .lock()
                        .expect("room_peek_states mutex poisoned");
                    if let Some(st) = guard.get_mut(room_id) {
                        st.active_peeking_agent_id = None;
                    }
                }
                self.step_sequential_peek_queue(room_id).await;
                return;
            }

            let max_seq = room.last_msg_seq;
            let mode = if allow_speak {
                DeliveryMode::PeekAllowed { roll }
            } else {
                DeliveryMode::PeekMuted { roll }
            };
            let formatted =
                format_delivery_payload(&room, &all_agents, target_agent, &unread, mode);

            let Ok(updated_agent) = self.store.prepare_agent_delivery(
                &target_agent.agent_id,
                max_seq,
                room.roster_version,
                allow_speak,
            ) else {
                return;
            };

            self.emit_room_event(ChatroomEvent::PeekRoundStatus {
                room_id: room_id.to_string(),
                status: format!(
                    "@{} 正在窥屏 (roll={}, {})",
                    updated_agent.name,
                    roll,
                    if allow_speak {
                        "可插嘴"
                    } else {
                        "本轮禁言只读"
                    }
                ),
            });

            if let Ok(resp) = self
                .ragents_client
                .push_realtime_message(
                    &updated_agent.active_session_id,
                    PushRealtimeMessageRequest {
                        content: vec![MessageContent::InputText { text: formatted }],
                    },
                )
                .await
            {
                if let Some(spawned_act_id) = resp.spawned_activation_id {
                    if let Ok(thinking_agent) = self.store.update_agent_runtime_state(
                        &target_agent.agent_id,
                        AgentRuntimeState::Thinking,
                        Some(spawned_act_id),
                    ) {
                        self.emit_room_event(ChatroomEvent::AgentUpdated {
                            room_id: room_id.to_string(),
                            agent: thinking_agent.into(),
                        });
                    }
                }
            } else {
                let mut guard = self
                    .room_peek_states
                    .lock()
                    .expect("room_peek_states mutex poisoned");
                if let Some(st) = guard.get_mut(room_id) {
                    st.active_peeking_agent_id = None;
                }
            }
        })
    }
}

enum DeliveryMode {
    DirectMention,
    PeekAllowed { roll: u8 },
    PeekMuted { roll: u8 },
}

fn format_delivery_payload(
    room: &Room,
    all_agents: &[RoomAgent],
    target_agent: &RoomAgent,
    unread_messages: &[RoomMessage],
    mode: DeliveryMode,
) -> String {
    let mut out = String::new();

    // Only include the room roster header when the room's `roster_version` has changed since last sync
    if target_agent.last_roster_version < room.roster_version {
        let mut members = vec![
            "Human (人类用户)".to_string(),
            "@Manager (聊天室管家)".to_string(),
        ];
        for (idx, ag) in all_agents.iter().enumerate() {
            if idx == 0 && all_agents.len() > 1 {
                members.push(format!(
                    "@{} ({} [Default Room Lead / 默认主导统筹])",
                    ag.name, ag.role_title
                ));
            } else {
                members.push(format!("@{} ({})", ag.name, ag.role_title));
            }
        }
        out.push_str(&format!(
            "[Room Roster Updated (v{}): {}]\n\n",
            room.roster_version,
            members.join(", ")
        ));
    }

    match mode {
        DeliveryMode::DirectMention => {
            if unread_messages.len() > 1 {
                out.push_str(&format!(
                    "=== [Chatroom Unread Context | Room: {}] ===\n",
                    room.name
                ));
                for m in &unread_messages[..unread_messages.len() - 1] {
                    out.push_str(&format_single_room_message(m));
                    out.push('\n');
                }
                out.push('\n');
            }
            let last_msg = unread_messages.last().unwrap();
            out.push_str(&format!(
                "=== [Chatroom Direct Mention (@{}) | Action Required] ===\n",
                target_agent.name
            ));
            out.push_str("[Chatroom Speak Permission: ALLOWED]\n");
            out.push_str(&format_single_room_message(last_msg));
            if last_msg.sender_kind == SenderKind::Human {
                out.push_str(
                    "\n\n(Hint: Complete any private tool actions in your session, then you MUST call `chatroom_speak` to reply in the chatroom. Do NOT put other agents in `mentions` unless you explicitly need them to execute a task.)",
                );
            } else {
                out.push_str(
                    "\n\n(Hint: You were @mentioned by another participant. If you were assigned a specific task or question, complete your work and call `chatroom_speak` (contribute only incremental content—never repeat full summaries already posted). If the task is already complete or they were only thanking/signing off, DO NOT call `chatroom_speak`—finish silently with `Observed.`. Only put another agent in `mentions` if you require them to perform a follow-up task.)",
                );
            }
        }
        DeliveryMode::PeekAllowed { roll } => {
            out.push_str(&format!(
                "=== [Chatroom Unread Peek | Room: {} | Roll: {}] ===\n",
                room.name, roll
            ));
            out.push_str("[Chatroom Speak Permission: ALLOWED]\n");
            for m in unread_messages {
                out.push_str(&format_single_room_message(m));
                out.push('\n');
            }
            out.push_str(
                "\n(System Note: You were NOT directly @mentioned. You are peeking at unread chatroom messages while idle.\n\
                 - If you have valuable input, a correction, or domain insight to add, call `chatroom_speak` to chime in.\n\
                 - If no response is needed, DO NOT call `chatroom_speak` and simply finish your turn with `Observed.`.)",
            );
        }
        DeliveryMode::PeekMuted { roll } => {
            out.push_str(&format!(
                "=== [Chatroom Unread Peek | Room: {} | Roll: {} (Muted)] ===\n",
                room.name, roll
            ));
            out.push_str("[Chatroom Speak Permission: MUTED]\n");
            for m in unread_messages {
                out.push_str(&format_single_room_message(m));
                out.push('\n');
            }
            out.push_str(
                "\n(System Note: You are in read-only observation mode for this peek turn (`[Chatroom Speak Permission: MUTED]`). \
                 Absorb the context into your memory and finish your turn immediately with `Observed.`.)",
            );
        }
    }

    out
}

fn format_single_room_message(m: &RoomMessage) -> String {
    let time_str = m.created_at.format("%H:%M:%S");
    let reply_part = match m.reply_to_seq {
        Some(r) => format!(" (reply to #{r})"),
        None => String::new(),
    };
    let mention_part = if m.mentions.is_empty() {
        String::new()
    } else {
        let tags: Vec<String> = m.mentions.iter().map(|n| format!("@{n}")).collect();
        format!(" -> {}", tags.join(" "))
    };
    let visibility_part = if m.visible_to.is_empty() {
        String::new()
    } else {
        let mut vis_tags = vec![format!("@{}", m.sender_name)];
        for v in &m.visible_to {
            if !v.eq_ignore_ascii_case(&m.sender_name) {
                vis_tags.push(format!("@{v}"));
            }
        }
        format!(" [🔒 Private Whisper visible ONLY to: {}]", vis_tags.join(", "))
    };
    format!(
        "[#{} | {} | {}{}{}{}]: {}",
        m.msg_seq, time_str, m.sender_name, mention_part, visibility_part, reply_part, m.content
    )
}

pub fn resolve_explicit_mentions(
    explicit_mentions: &[String],
    room_agents: &[RoomAgent],
    exclude_self_name: Option<&str>,
) -> Vec<String> {
    let mut found = Vec::new();
    let mut push_unique = |canonical: String| {
        if let Some(self_name) = exclude_self_name {
            if canonical.eq_ignore_ascii_case(self_name) {
                return;
            }
        }
        if !found
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&canonical))
        {
            found.push(canonical);
        }
    };

    for exp in explicit_mentions {
        let cleaned = exp.trim().trim_start_matches('@');
        if cleaned.eq_ignore_ascii_case("Manager") {
            push_unique("Manager".to_string());
        } else if cleaned.eq_ignore_ascii_case("Human") {
            push_unique("Human".to_string());
        } else if let Some(ag) = room_agents
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(cleaned))
        {
            push_unique(ag.name.clone());
        }
    }

    found
}

pub fn strip_leading_redundant_mentions(content: &str, mentions: &[String]) -> String {
    if mentions.is_empty() {
        return content.to_string();
    }
    let mut rest = content.trim_start();
    loop {
        if !rest.starts_with('@') {
            break;
        }
        let after_at = &rest[1..];
        let mut matched_len = None;
        for m in mentions {
            if after_at.len() >= m.len() && after_at[..m.len()].eq_ignore_ascii_case(m) {
                let next_ch = after_at[m.len()..].chars().next();
                if next_ch
                    .map(|c| !c.is_alphanumeric() && c != '_' && c != '-')
                    .unwrap_or(true)
                {
                    matched_len = Some(m.len());
                    break;
                }
            }
        }
        if let Some(len) = matched_len {
            rest = after_at[len..].trim_start_matches(|c: char| {
                c.is_whitespace() || c == ',' || c == '，' || c == ':' || c == '：'
            });
        } else {
            break;
        }
    }
    if rest.is_empty() {
        content.to_string()
    } else {
        rest.to_string()
    }
}

pub fn parse_mentions(
    content: &str,
    explicit_mentions: &[String],
    room_agents: &[RoomAgent],
) -> Vec<String> {
    let mut found = Vec::new();
    let mut push_unique = |canonical: String| {
        if !found
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&canonical))
        {
            found.push(canonical);
        }
    };

    for exp in explicit_mentions {
        let cleaned = exp.trim().trim_start_matches('@');
        if cleaned.eq_ignore_ascii_case("Manager") {
            push_unique("Manager".to_string());
        } else if cleaned.eq_ignore_ascii_case("Human") {
            push_unique("Human".to_string());
        } else if let Some(ag) = room_agents
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(cleaned))
        {
            push_unique(ag.name.clone());
        }
    }

    for token in content.split_whitespace() {
        if let Some(after_at) = token.strip_prefix('@') {
            let cleaned =
                after_at.trim_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-');
            if cleaned.is_empty() {
                continue;
            }
            if cleaned.eq_ignore_ascii_case("Manager") {
                push_unique("Manager".to_string());
            } else if cleaned.eq_ignore_ascii_case("Human") {
                push_unique("Human".to_string());
            } else if let Some(ag) = room_agents
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case(cleaned))
            {
                push_unique(ag.name.clone());
            }
        }
    }

    found
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a_bytes.iter().zip(b_bytes.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
