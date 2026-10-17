use crate::coordinator::RoomCoordinator;
use crate::types::{ChatroomEvent, CreateAgentRequest, RoomMessage, SenderKind};
use futures::StreamExt;
use openresponses_rust::{Item, MessageContent};
use ragents_protocol::*;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct ManagerLlmOutput {
    #[serde(default)]
    reply: String,
    #[serde(default)]
    new_agents: Vec<ManagerAgentBlueprint>,
}

#[derive(Debug, Deserialize)]
struct ManagerAgentBlueprint {
    name: String,
    role_title: String,
    #[serde(default = "default_emoji")]
    avatar: String,
    persona_prompt: String,
    #[serde(default)]
    model: Option<String>,
}

fn default_emoji() -> String {
    "🤖".to_string()
}

pub async fn recruit_agents_via_manager(
    coord: &RoomCoordinator,
    room_id: &str,
    user_requirement: &str,
    caller_agent_name: Option<&str>,
) -> anyhow::Result<RoomMessage> {
    let mgr_settings = coord.store.get_manager_settings()?;
    let room = coord
        .store
        .get_room(room_id)?
        .ok_or_else(|| anyhow::anyhow!("room {room_id} not found"))?;
    let existing_agents = coord.store.list_room_agents(room_id)?;
    let nodes = coord.ragents_client.list_nodes().await.unwrap_or_default();

    let lead_agent_before = caller_agent_name
        .map(str::to_string)
        .or_else(|| existing_agents.first().map(|a| a.name.clone()));

    let existing_summary: Vec<String> = existing_agents
        .iter()
        .enumerate()
        .map(|(idx, a)| {
            let role_tag = if idx == 0 {
                format!("{}, Default Room Lead", a.role_title)
            } else {
                a.role_title.clone()
            };
            format!("@{} ({}, model={})", a.name, role_tag, a.model)
        })
        .collect();
    let available_models: Vec<String> = nodes
        .iter()
        .flat_map(|n| n.status.supported_models.clone())
        .collect();

    let lead_hint = match &lead_agent_before {
        Some(lead) => format!(
            "Room Lead Coordinator: @{lead} (In your `reply`, introduce the new specialist(s) and hand off task coordination to @{lead} so @{lead} can assign specific tasks in order.)"
        ),
        None => "Room currently has no agents; the first recruited agent will become the Default Room Lead.".to_string(),
    };

    let prompt = format!(
        "Room Name: {}\n\
         Existing Agents in Room: {:?}\n\
         {}\n\
         Available Models on Cluster: {:?} (default: {})\n\
         User / Agent Request to @Manager:\n{}\n\n\
         Remember to output ONLY a valid JSON object with `reply` and `new_agents`.",
        room.name,
        existing_summary,
        lead_hint,
        available_models,
        mgr_settings.default_agent_model,
        user_requirement
    );

    let created = coord
        .ragents_client
        .create_session(CreateSessionRequest {
            session_id: None,
            labels: BTreeMap::from([(
                "ragents.chat.role".to_string(),
                "chatroom_manager".to_string(),
            )]),
            spec: SessionSpec {
                scheduling: SchedulingMode::Floating {
                    node_selector: BTreeMap::new(),
                },
                sources: vec![],
                producer: None,
                desired_phase: DesiredSessionPhase::Open,
                system_prompt: Some(mgr_settings.manager_system_prompt.clone()),
                model: Some(ModelRequestSpec::new(mgr_settings.manager_model.clone())),
                extensions: vec![],
                permissions: PermissionPolicyLayer::default(),
            },
            initial_activation: Some(InitialActivationRequest {
                input: vec![Item::user_message(prompt)],
                model_override: None,
            }),
        })
        .await?;

    let mgr_sess_id = SessionId::new(created.session.metadata.id);
    let mgr_act_id = ActivationId::new(
        created
            .initial_activation
            .ok_or_else(|| anyhow::anyhow!("missing manager initial activation"))?
            .metadata
            .id,
    );

    // Wait for the temporary Manager Session activation to complete
    let mut watch = coord
        .ragents_client
        .watch_events(Some(&mgr_sess_id), 0)
        .await?;
    let wait_res = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(Ok(env)) = watch.next().await {
            if env.activation_id.as_ref() == Some(&mgr_act_id) {
                match env.event {
                    SessionEvent::ActivationCompleted { .. } => return Ok(()),
                    SessionEvent::ActivationFailed { error } => {
                        return Err(anyhow::anyhow!("Manager LLM call failed: {error}"))
                    }
                    _ => {}
                }
            }
        }
        Err(anyhow::anyhow!("Manager event stream closed prematurely"))
    })
    .await;

    let ctx = coord
        .ragents_client
        .get_session_context(&mgr_sess_id)
        .await?;
    let _ = coord
        .ragents_client
        .patch_session(
            &mgr_sess_id,
            PatchSessionSpecRequest {
                desired_phase: Some(DesiredSessionPhase::Closed),
                system_prompt: None,
                model: None,
                extensions: None,
                permissions: None,
            },
        )
        .await;

    if let Err(e) = wait_res {
        anyhow::bail!("Manager timed out: {e}");
    }
    wait_res??;

    let raw_reply = ctx
        .effective_items
        .iter()
        .rev()
        .find_map(|item| {
            if let Item::Message { role, content, .. } = item {
                if format!("{role:?}").to_ascii_lowercase().contains("assistant") {
                    let mut t = String::new();
                    for part in content {
                        match part {
                            MessageContent::OutputText { text, .. }
                            | MessageContent::PlainText { text } => t.push_str(text),
                            _ => {}
                        }
                    }
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
            None
        })
        .unwrap_or_default();

    let parsed = parse_manager_json(&raw_reply);
    let mut recruited_names = Vec::new();

    for bp in parsed.new_agents {
        let model_to_use = bp
            .model
            .filter(|m| available_models.is_empty() || available_models.contains(m))
            .or_else(|| Some(mgr_settings.default_agent_model.clone()));

        if let Ok(created_ag) = coord
            .create_agent_in_room(
                room_id,
                CreateAgentRequest {
                    name: bp.name,
                    role_title: bp.role_title,
                    avatar: bp.avatar,
                    persona_prompt: bp.persona_prompt,
                    model: model_to_use,
                    reasoning_effort: mgr_settings.default_reasoning_effort.clone(),
                    reasoning_summary: mgr_settings.default_reasoning_summary.clone(),
                    node_id: mgr_settings.default_node_id.clone(),
                    workspace_path: mgr_settings.default_workspace_root.clone(),
                },
                "manager",
            )
            .await
        {
            recruited_names.push(created_ag.name);
        }
    }

    let final_reply = if !parsed.reply.trim().is_empty() {
        parsed.reply
    } else if !recruited_names.is_empty() {
        let tags: Vec<String> = recruited_names.iter().map(|n| format!("@{n}")).collect();
        format!("已为您招募并拉入新成员：{}。", tags.join("、"))
    } else {
        raw_reply
    };

    // Hand off coordination ONLY to the Lead Agent (either the caller agent or the first agent in the room),
    // rather than waking up all newly recruited specialists simultaneously.
    let handoff_lead = lead_agent_before.or_else(|| recruited_names.first().cloned());
    let mentions = match handoff_lead {
        Some(lead) => vec![lead],
        None => vec![],
    };

    let (mgr_msg, updated_room) = coord.store.append_message(
        room_id,
        SenderKind::Manager,
        "manager",
        "Manager",
        final_reply,
        mentions,
        None,
        Some(mgr_sess_id),
        Some(mgr_act_id),
    )?;

    coord.emit_room_event(ChatroomEvent::MessagePosted {
        room_id: room_id.to_string(),
        message: mgr_msg.clone(),
    });
    coord.emit_room_event(ChatroomEvent::RoomUpdated {
        room_id: room_id.to_string(),
        room: updated_room,
    });

    coord.dispatch_after_message(mgr_msg.clone()).await;
    Ok(mgr_msg)
}

fn parse_manager_json(raw: &str) -> ManagerLlmOutput {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|s| s.trim_end_matches("```").trim())
        .unwrap_or(trimmed);

    if let Ok(v) = serde_json::from_str::<ManagerLlmOutput>(stripped) {
        return v;
    }
    if let (Some(start), Some(end)) = (stripped.find('{'), stripped.rfind('}')) {
        if start < end {
            if let Ok(v) = serde_json::from_str::<ManagerLlmOutput>(&stripped[start..=end]) {
                return v;
            }
        }
    }
    ManagerLlmOutput {
        reply: raw.to_string(),
        new_agents: vec![],
    }
}
