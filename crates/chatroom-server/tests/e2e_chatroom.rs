use async_trait::async_trait;
use chatroom_server::*;
use openresponses_rust::{
    CreateResponseBody, FunctionCallStatus, Input, Item, MessageContent, MessageRole,
    ResponseResource,
};
use ragents_apiserver::{
    serve_tcp, ApiServerExtensions, ApiServerState, SqliteStore, StaticTokenAuthnPlugin,
    DEFAULT_LEASE_TTL_MS,
};
use ragents_client::RagentsClient;
use ragents_core::{make_openresponses_resource, CoreError, ModelBackend, ModelEndpointConfig};
use ragents_daemon::{
    default_allowed_workspace_dirs, parse_workspace_dirs_csv, AgentDaemon, DaemonConfig,
    ExecutorMode, LocalModelConfig,
};
use ragents_protocol::*;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

struct ChatroomTestModelBackend {
    seen_tools_by_prompt: Arc<Mutex<Vec<(String, Vec<String>)>>>,
    forgot_speak_once: Arc<AtomicUsize>,
}

#[async_trait]
impl ModelBackend for ChatroomTestModelBackend {
    async fn create_response(
        &self,
        _endpoint: &ModelEndpointConfig,
        request: CreateResponseBody,
    ) -> Result<ResponseResource, CoreError> {
        let mut all_user_texts = Vec::new();
        let mut last_item_is_tool_output = false;
        let mut last_tool_output_text = String::new();

        if let Some(Input::Items(ref items)) = request.input {
            for item in items {
                match item {
                    Item::Message { role, content, .. } if *role == MessageRole::User => {
                        let mut txt = String::new();
                        for part in content {
                            match part {
                                MessageContent::InputText { text }
                                | MessageContent::OutputText { text, .. }
                                | MessageContent::PlainText { text } => txt.push_str(text),
                                _ => {}
                            }
                        }
                        all_user_texts.push(txt);
                        last_item_is_tool_output = false;
                    }
                    Item::FunctionCallOutput { output, .. } => {
                        last_item_is_tool_output = true;
                        last_tool_output_text = format!("{output:?}");
                    }
                    _ => {}
                }
            }
        }

        let latest_user = all_user_texts.last().cloned().unwrap_or_default();
        let tool_names: Vec<String> = serde_json::to_value(&request.tools)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .map(|arr| {
                arr.into_iter()
                    .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        self.seen_tools_by_prompt
            .lock()
            .unwrap()
            .push((latest_user.clone(), tool_names.clone()));

        // 1. If this is the @Manager Agent Session (equipped with chatroom_add_agent, chatroom_remove_agent, chatroom_speak)
        if tool_names.iter().any(|t| t == "chatroom_add_agent") {
            if !last_item_is_tool_output {
                if latest_user.contains("REMOVE_SECAUDITOR") {
                    return Ok(make_openresponses_resource(
                        "resp_mgr_rm",
                        "gpt-4.1-mini",
                        vec![Item::FunctionCall {
                            id: Some("fc_mgr_rm".into()),
                            call_id: "call_mgr_rm_1".into(),
                            name: "chatroom_remove_agent".into(),
                            arguments: json!({
                                "name": "SecAuditor"
                            })
                            .to_string(),
                            status: Some(FunctionCallStatus::Completed),
                        }],
                        None,
                    ));
                }
                return Ok(make_openresponses_resource(
                    "resp_mgr_add",
                    "gpt-4.1-mini",
                    vec![Item::FunctionCall {
                        id: Some("fc_mgr_add".into()),
                        call_id: "call_mgr_add_1".into(),
                        name: "chatroom_add_agent".into(),
                        arguments: json!({
                            "name": "SecAuditor",
                            "role_title": "安全与权限审计专家",
                            "avatar": "🛡️",
                            "persona_prompt": "You are @SecAuditor, a security specialist."
                        })
                        .to_string(),
                        status: Some(FunctionCallStatus::Completed),
                    }],
                    None,
                ));
            } else if last_tool_output_text.contains("Agent added to chatroom") {
                return Ok(make_openresponses_resource(
                    "resp_mgr_speak",
                    "gpt-4.1-mini",
                    vec![Item::FunctionCall {
                        id: Some("fc_mgr_speak".into()),
                        call_id: "call_mgr_speak_1".into(),
                        name: "chatroom_speak".into(),
                        arguments: json!({
                            "content": "我已经为您招募了安全审计专家 @SecAuditor 入群！",
                            "mentions": ["Human"]
                        })
                        .to_string(),
                        status: Some(FunctionCallStatus::Completed),
                    }],
                    None,
                ));
            } else if last_tool_output_text.contains("Agent removed from chatroom") {
                return Ok(make_openresponses_resource(
                    "resp_mgr_rm_speak",
                    "gpt-4.1-mini",
                    vec![Item::FunctionCall {
                        id: Some("fc_mgr_rm_speak".into()),
                        call_id: "call_mgr_rm_speak_1".into(),
                        name: "chatroom_speak".into(),
                        arguments: json!({
                            "content": "已按您的要求将 @SecAuditor 移出本群。",
                            "mentions": ["Human"]
                        })
                        .to_string(),
                        status: Some(FunctionCallStatus::Completed),
                    }],
                    None,
                ));
            } else {
                return Ok(make_openresponses_resource(
                    "resp_mgr_done",
                    "gpt-4.1-mini",
                    vec![Item::assistant_message("Observed.")],
                    None,
                ));
            }
        }

        // 2. If the previous step was a `chatroom_speak` tool call output, finish the turn cleanly
        if last_item_is_tool_output {
            return Ok(make_openresponses_resource(
                "resp_done",
                "gpt-4.1-mini",
                vec![Item::assistant_message(
                    "Private inner note: finished speaking to chatroom.",
                )],
                None,
            ));
        }

        // 3. Test Direct-@ Forgotten-Speak Auto-Nudge:
        //    If user message contains `TEST_FORGET_SPEAK` and it's not yet the `[System Reminder`,
        //    finish without calling `chatroom_speak` the first time!
        if latest_user.contains("TEST_FORGET_SPEAK")
            && !latest_user.contains("[System Reminder")
            && self.forgot_speak_once.fetch_add(1, Ordering::SeqCst) == 0
        {
            return Ok(make_openresponses_resource(
                "resp_forgot",
                "gpt-4.1-mini",
                vec![Item::assistant_message(
                    "I thought about the answer privately but forgot to call chatroom_speak.",
                )],
                None,
            ));
        }

        // 4. If muted peek (`(Muted)]`) or no `chatroom_speak` tool available
        if latest_user.contains("(Muted)]")
            || !tool_names.iter().any(|t| t == "chatroom_speak")
        {
            return Ok(make_openresponses_resource(
                "resp_muted",
                "gpt-4.1-mini",
                vec![Item::assistant_message("Observed silently while muted.")],
                None,
            ));
        }

        // 5. If this is an allowed Peek (`[Chatroom Unread Peek`) and contains `TRIGGER_INTERJECT`,
        //    call `chatroom_speak` to interject!
        if latest_user.contains("[Chatroom Unread Peek") {
            if latest_user.contains("TRIGGER_INTERJECT") {
                return Ok(make_openresponses_resource(
                    "resp_interject",
                    "gpt-4.1-mini",
                    vec![Item::FunctionCall {
                        id: Some("fc_interject".into()),
                        call_id: "call_interject_1".into(),
                        name: "chatroom_speak".into(),
                        arguments: json!({
                            "content": "我作为群成员主动插嘴补充一点安全建议！",
                            "mentions": []
                        })
                        .to_string(),
                        status: Some(FunctionCallStatus::Completed),
                    }],
                    None,
                ));
            } else {
                return Ok(make_openresponses_resource(
                    "resp_obs",
                    "gpt-4.1-mini",
                    vec![Item::assistant_message("Observed.")],
                    None,
                ));
            }
        }

        // 6. Otherwise (Direct @ Mention or Auto-Nudge reminder): call `chatroom_speak`!
        let reply_text = if latest_user.contains("[System Reminder") {
            "抱歉刚才忘了调用发言工具，现在补上我的群聊回复！".to_string()
        } else {
            format!(
                "收到你的点名提问！这是我通过 chatroom_speak 发送到聊天室的正式回复（长消息流式测试 >4KB: {}）。",
                "A".repeat(8192)
            )
        };

        Ok(make_openresponses_resource(
            "resp_speak",
            "gpt-4.1-mini",
            vec![
                Item::assistant_message("INTERNAL_PRIVATE_THOUGHT_DO_NOT_LEAK"),
                Item::FunctionCall {
                    id: Some("fc_speak".into()),
                    call_id: "call_speak_1".into(),
                    name: "chatroom_speak".into(),
                    arguments: json!({
                        "content": reply_text,
                        "mentions": []
                    })
                    .to_string(),
                    status: Some(FunctionCallStatus::Completed),
                },
            ],
            None,
        ))
    }
}

fn chatroom_wasm_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/chatroom/target/wasm32-wasip2/release/ragent_chatroom_extension.wasm")
        .canonicalize()
        .expect("ragent_chatroom_extension.wasm must be built")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_end_to_end_chatroom_single_and_group_chat_peek_interject_and_inspector() {
    let cancel = CancellationToken::new();
    let tmp = tempfile::tempdir().expect("tempdir");

    // 1. Start `ragents-apiserver` protected by `StaticTokenAuthnPlugin`
    let ragents_token = "ragents-cluster-secret-token";
    let mut exts = ApiServerExtensions::new();
    exts.add_authn(Arc::new(StaticTokenAuthnPlugin::new(ragents_token)));

    let store = SqliteStore::open_in_memory().expect("in-memory ragents store");
    let apiserver_state = ApiServerState::new(store, DEFAULT_LEASE_TTL_MS).with_extensions(exts);
    let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_addr = serve_tcp(api_listener, apiserver_state, cancel.clone())
        .await
        .unwrap();
    let ragents_url = format!("http://{api_addr}");

    // 2. Start `ragents-daemon` connected to `ragents-apiserver` with `ExecutorMode::InProcess`
    let seen_tools = Arc::new(Mutex::new(Vec::new()));
    let forgot_speak_once = Arc::new(AtomicUsize::new(0));
    let model_backend = Arc::new(ChatroomTestModelBackend {
        seen_tools_by_prompt: seen_tools.clone(),
        forgot_speak_once: forgot_speak_once.clone(),
    });

    let mut models = BTreeMap::new();
    models.insert(
        "gpt-4.1-mini".to_string(),
        LocalModelConfig {
            base_url: "http://127.0.0.1:9/v1".to_string(),
            api_key: Some("sk-test".to_string()),
            api_key_env: None,
            extra_headers: BTreeMap::new(),
            default_temperature: Some(0.0),
            default_max_output_tokens: Some(1024),
        },
    );

    let daemon_cfg = DaemonConfig {
        node_id: NodeId::new("node-chat-test"),
        server_url: ragents_url.clone(),
        auth_token: Some(ragents_token.to_string()),
        executor_mode: ExecutorMode::InProcess,
        max_concurrent_runners: 8,
        max_turns: None,
        default_system_prompt: "You are a helpful agent.".to_string(),
        default_model: Some("gpt-4.1-mini".to_string()),
        temp_root_dir: tmp.path().join("daemon_tmp"),
        extensions_dir: chatroom_wasm_path().parent().unwrap().to_path_buf(),
        allowed_workspace_dirs: parse_workspace_dirs_csv("/a/b/c,/a/b/d"),
        labels: BTreeMap::new(),
        auto_discover_models: false,
        models,
        extensions: vec![],
        interceptors: vec![],
        default_permissions: PermissionPolicyLayer::default(),
    };
    let daemon = AgentDaemon::new(daemon_cfg).with_model_backend(model_backend);
    daemon.start(cancel.clone()).await.unwrap();

    // 3. Start `chatroom-server` protected by `chat_auth_token`
    let chat_auth_token = "chat-web-secret-888";
    let chat_store =
        ChatroomStore::open_in_memory("gpt-4.1-mini", vec![]).expect("chatroom in-memory store");
    let chat_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let chat_local_addr = chat_listener.local_addr().unwrap();
    let callback_base_url = format!("http://{chat_local_addr}");

    let ragents_client =
        RagentsClient::new(ragents_url).with_auth_token(Some(ragents_token.to_string()));
    let coordinator = RoomCoordinator::new(
        chat_store.clone(),
        ragents_client.clone(),
        callback_base_url.clone(),
    );
    let chat_state =
        ChatServerState::new(coordinator.clone(), Some(chat_auth_token.to_string()));
    let chat_addr = serve_chat_tcp(chat_listener, chat_state, cancel.clone())
        .await
        .unwrap();
    let chat_base = format!("http://{chat_addr}");
    let http = reqwest::Client::new();

    // 4. Verify Tier-1 Auth on `chatroom-server`: unauthenticated request returns 401
    let unauth_resp = http
        .get(format!("{chat_base}/api/v1/rooms"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth_resp.status().as_u16(), 401);

    // 5. Create a room with 1 default agent (`@Assistant`)
    let created_room: RoomDetailResponse = http
        .post(format!("{chat_base}/api/v1/rooms"))
        .bearer_auth(chat_auth_token)
        .json(&CreateRoomRequest {
            name: "研发协作室".to_string(),
            description: "测试单聊与群聊".to_string(),
            default_agent_name: Some("Assistant".to_string()),
            default_agent_role: Some("主力研发助手".to_string()),
            default_agent_persona: Some("You are @Assistant.".to_string()),
            default_agent_model: Some("gpt-4.1-mini".to_string()),
            reasoning_effort: Some("high".to_string()),
            reasoning_summary: Some("concise".to_string()),
            web_search: Some(true),
            node_id: None,
            workspace_path: None,
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let room_id = created_room.room.room_id.clone();
    assert_eq!(created_room.agents.len(), 1);
    let assistant_id = created_room.agents[0].agent_id.clone();

    // 6. Single-Chat Mode: Send a message without explicit `@` mentions.
    //    `chatroom-server` should auto-mention `@Assistant`, wake its Session, and `@Assistant`
    //    should call `chatroom_speak` via WASI 0.2 HTTP to post its reply!
    let human_msg: RoomMessage = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/messages"))
        .bearer_auth(chat_auth_token)
        .json(&PostMessageRequest {
            sender_name: "Alice".to_string(),
            content: "你好，请帮我看看架构设计！".to_string(),
            mentions: vec![],
            visible_to: vec![],
            reply_to_seq: None,
            is_realtime: false,
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Verify single-chat auto-mention
    assert_eq!(human_msg.mentions, vec!["Assistant".to_string()]);

    // Wait for `@Assistant` to reply in the chatroom via `chatroom_speak`
    let mut assistant_replied = false;
    for _ in 0..40 {
        let detail: RoomDetailResponse = http
            .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
            .bearer_auth(chat_auth_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if detail.messages.len() >= 2 {
            let reply = &detail.messages[1];
            assert_eq!(reply.sender_kind, SenderKind::Agent);
            assert_eq!(reply.sender_name, "Assistant");
            assert!(reply.content.contains("收到你的点名提问"));
            // Ensure private thoughts did NOT leak into the chatroom
            assert!(!reply.content.contains("INTERNAL_PRIVATE_THOUGHT_DO_NOT_LEAK"));
            assistant_replied = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(assistant_replied, "@Assistant should reply via chatroom_speak");

    // 7. Verify Read-Only Session Inspector CAN see `INTERNAL_PRIVATE_THOUGHT_DO_NOT_LEAK`
    let inspector: InspectorResponse = http
        .get(format!("{chat_base}/api/v1/agents/{assistant_id}/inspector"))
        .bearer_auth(chat_auth_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ctx_json = serde_json::to_string(&inspector.context).unwrap();
    assert!(
        ctx_json.contains("INTERNAL_PRIVATE_THOUGHT_DO_NOT_LEAK"),
        "Inspector must show private inner thoughts"
    );

    // 8. Test Direct-@ Forgotten-Speak Auto-Nudge:
    //    Send `TEST_FORGET_SPEAK` to `@Assistant`. On turn 1 it forgets to call `chatroom_speak`,
    //    then `RoomCoordinator` sends 1 `[System Reminder for @Assistant]` nudge and it replies!
    let _ = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/messages"))
        .bearer_auth(chat_auth_token)
        .json(&PostMessageRequest {
            sender_name: "Alice".to_string(),
            content: "TEST_FORGET_SPEAK 请回答这个问题".to_string(),
            mentions: vec!["Assistant".to_string()],
            visible_to: vec![],
            reply_to_seq: None,
            is_realtime: true,
        })
        .send()
        .await
        .unwrap();

    let mut nudge_succeeded = false;
    for _ in 0..50 {
        let detail: RoomDetailResponse = http
            .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
            .bearer_auth(chat_auth_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if detail
            .messages
            .iter()
            .any(|m| m.content.contains("抱歉刚才忘了调用发言工具"))
        {
            nudge_succeeded = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        nudge_succeeded,
        "Auto-nudge should remind silent @mentioned agent to speak"
    );

    // 9. Test `@Manager` Recruitment to upgrade from Single-Chat (1 Agent) to Group-Chat (2 Agents)
    let mgr_msg: RoomMessage = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/recruit"))
        .bearer_auth(chat_auth_token)
        .json(&RecruitAgentRequest {
            requirement: "请招募一个安全审计专家 SecAuditor".to_string(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(mgr_msg.sender_kind, SenderKind::Manager);
    assert!(mgr_msg.content.contains("@SecAuditor"));

    let detail_after_recruit: RoomDetailResponse = http
        .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
        .bearer_auth(chat_auth_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail_after_recruit.agents.len(), 2);
    assert!(detail_after_recruit
        .agents
        .iter()
        .any(|a| a.name == "SecAuditor"));

    // 10. Test Muted Peek (`mute_probability = 100`):
    //     Configure room with `peek_idle_secs = 1`, `mute_probability = 100`.
    //     When human posts a message without `@`, idle agents peek in MUTED mode (`chatroom_speak` stripped!).
    let _: Room = http
        .patch(format!("{chat_base}/api/v1/rooms/{room_id}"))
        .bearer_auth(chat_auth_token)
        .json(&PatchRoomRequest {
            peek_enabled: Some(true),
            peek_idle_secs: Some(1),
            peek_msg_interval: Some(1),
            interject_enabled: Some(true),
            mute_probability: Some(100),
            ..Default::default()
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Wait for agents to settle to Idle
    for _ in 0..30 {
        let d: RoomDetailResponse = http
            .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
            .bearer_auth(chat_auth_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if d.agents
            .iter()
            .all(|a| a.runtime_state == AgentRuntimeState::Idle)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    seen_tools.lock().unwrap().clear();

    let _ = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/messages"))
        .bearer_auth(chat_auth_token)
        .json(&PostMessageRequest {
            sender_name: "Alice".to_string(),
            content: "这是一条不点名任何人的群公告（测试全员禁言窥屏）".to_string(),
            mentions: vec![],
            visible_to: vec![],
            reply_to_seq: None,
            is_realtime: false,
        })
        .send()
        .await
        .unwrap();

    // Wait for muted peek turns to execute
    let mut saw_muted_peek_without_speak_tool = false;
    let mut saw_manager_msg_inside_peek_context = false;
    for _ in 0..40 {
        {
            let guard = seen_tools.lock().unwrap();
            for (prompt, tools) in guard.iter() {
                if prompt.contains("[Chatroom Unread Peek")
                    && prompt.contains("(Muted)]")
                {
                    assert!(
                        !tools.contains(&"chatroom_speak".to_string()),
                        "disabled_tools must strip chatroom_speak tool when muted!"
                    );
                    saw_muted_peek_without_speak_tool = true;
                    if prompt.contains("我已经为您招募了安全审计专家 @SecAuditor 入群！") {
                        saw_manager_msg_inside_peek_context = true;
                    }
                }
            }
        }
        if saw_muted_peek_without_speak_tool && saw_manager_msg_inside_peek_context {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        saw_muted_peek_without_speak_tool,
        "Muted peek must strip chatroom_speak tool via ActivationSpec.disabled_tools"
    );
    assert!(
        saw_manager_msg_inside_peek_context,
        "Manager messages must not trigger peek by themselves, but must be included when a peek occurs"
    );

    // 11. Test Sequential Peek & Active Interjection (`mute_probability = 0`):
    //     Now set `mute_probability = 0` and send `TRIGGER_INTERJECT` without `@` mentions.
    //     The highest-rolling idle agent will peek with `[Chatroom Speak Permission: ALLOWED]`
    //     and call `chatroom_speak` to interject into the chatroom!
    for _ in 0..30 {
        let d: RoomDetailResponse = http
            .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
            .bearer_auth(chat_auth_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if d.agents
            .iter()
            .all(|a| a.runtime_state == AgentRuntimeState::Idle)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let _: Room = http
        .patch(format!("{chat_base}/api/v1/rooms/{room_id}"))
        .bearer_auth(chat_auth_token)
        .json(&PatchRoomRequest {
            mute_probability: Some(0),
            peek_idle_secs: Some(1),
            ..Default::default()
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let _ = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/messages"))
        .bearer_auth(chat_auth_token)
        .json(&PostMessageRequest {
            sender_name: "Alice".to_string(),
            content: "TRIGGER_INTERJECT 大家觉得这个方案有没有安全隐患？（未点名任何人的自由讨论）".to_string(),
            mentions: vec![],
            visible_to: vec![],
            reply_to_seq: None,
            is_realtime: false,
        })
        .send()
        .await
        .unwrap();

    let mut interjected = false;
    for _ in 0..50 {
        let detail: RoomDetailResponse = http
            .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
            .bearer_auth(chat_auth_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if detail
            .messages
            .iter()
            .any(|m| m.content.contains("主动插嘴补充一点安全建议"))
        {
            interjected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        interjected,
        "Peeking agent with roll >= mute_probability should actively interject via chatroom_speak"
    );

    // 12. Test `@Manager` Agent removal via `chatroom_remove_agent` -> `chatroom_speak` and verify @Manager Inspector
    let mgr_rm_msg: RoomMessage = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/recruit"))
        .bearer_auth(chat_auth_token)
        .json(&RecruitAgentRequest {
            requirement: "REMOVE_SECAUDITOR 请把 SecAuditor 移出群聊".to_string(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(mgr_rm_msg.sender_kind, SenderKind::Manager);
    assert!(mgr_rm_msg.content.contains("移出本群"));

    let detail_after_remove: RoomDetailResponse = http
        .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
        .bearer_auth(chat_auth_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail_after_remove.agents.len(), 1);
    assert!(detail_after_remove.manager_agent.is_some());

    let mgr_agent_id = detail_after_remove.manager_agent.unwrap().agent_id;
    let mgr_inspector: InspectorResponse = http
        .get(format!("{chat_base}/api/v1/agents/{mgr_agent_id}/inspector"))
        .bearer_auth(chat_auth_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mgr_ctx_json = serde_json::to_string(&mgr_inspector.context).unwrap();
    assert!(mgr_ctx_json.contains("chatroom_add_agent"));
    assert!(mgr_ctx_json.contains("chatroom_remove_agent"));

    // 13. Test `allowed_workspace_dirs` restriction when creating an Agent in the room:
    //     `/var/forbidden_ws` must be rejected (400), while a subdirectory under `/tmp` must succeed (201).
    let bad_ws_resp = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/agents"))
        .bearer_auth(chat_auth_token)
        .json(&CreateAgentRequest {
            name: "BadWsAgent".to_string(),
            role_title: "测试非法目录".to_string(),
            avatar: "🚫".to_string(),
            persona_prompt: "Test".to_string(),
            model: Some("gpt-4.1-mini".to_string()),
            reasoning_effort: None,
            reasoning_summary: None,
            web_search: None,
            node_id: None,
            workspace_path: Some("/var/forbidden_ws_dir".to_string()),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(bad_ws_resp.status().as_u16(), 400);

    let ok_ws_resp = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/agents"))
        .bearer_auth(chat_auth_token)
        .json(&CreateAgentRequest {
            name: "TmpWsAgent".to_string(),
            role_title: "测试合法/tmp目录".to_string(),
            avatar: "✅".to_string(),
            persona_prompt: "Test".to_string(),
            model: Some("gpt-4.1-mini".to_string()),
            reasoning_effort: None,
            reasoning_summary: None,
            web_search: None,
            node_id: None,
            workspace_path: Some("/tmp/allowed_tmp_ws_e2e_test".to_string()),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(ok_ws_resp.status().as_u16(), 201);

    // 14. Test `token_acl` extension: Admin issues a restricted user token (`alice`),
    //     verify sub-user identity (`@Alice`), node/workspace ACL, and non-admin restrictions.
    let create_user_resp: serde_json::Value = http
        .post(format!("{chat_base}/api/v1/ext/token_acl/users"))
        .bearer_auth(chat_auth_token)
        .json(&serde_json::json!({
            "username": "alice",
            "display_name": "Alice",
            "allowed_nodes": ["node-chat-test"],
            "node_workspace_prefixes": {
                "node-chat-test": ["/tmp"]
            },
            "max_approval_scope": "session"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let alice_token = create_user_resp["token"]
        .as_str()
        .expect("issued alice token")
        .to_string();
    assert!(alice_token.starts_with("rct_"));
    assert_eq!(create_user_resp["display_name"], "Alice");

    // Non-admin (`alice`) cannot create users or modify global @Manager settings
    let alice_create_user_resp = http
        .post(format!("{chat_base}/api/v1/ext/token_acl/users"))
        .bearer_auth(&alice_token)
        .json(&serde_json::json!({
            "username": "bob",
            "display_name": "Bob"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(alice_create_user_resp.status().as_u16(), 403);

    // Sub-user (`alice`) cannot create a room on an unauthorized node (`other-node`)
    let alice_forbidden_node_room = http
        .post(format!("{chat_base}/api/v1/rooms"))
        .bearer_auth(&alice_token)
        .json(&CreateRoomRequest {
            name: "Forbidden Node Room".to_string(),
            description: String::new(),
            default_agent_name: None,
            default_agent_role: None,
            default_agent_persona: None,
            default_agent_model: None,
            reasoning_effort: None,
            reasoning_summary: None,
            web_search: None,
            node_id: Some("other-node".to_string()),
            workspace_path: Some("/tmp".to_string()),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(alice_forbidden_node_room.status().as_u16(), 403);

    // Sub-user (`alice`) creates a pinned room under allowed node + `/tmp/allowed_tmp_ws_e2e_test`
    let alice_room: RoomDetailResponse = http
        .post(format!("{chat_base}/api/v1/rooms"))
        .bearer_auth(&alice_token)
        .json(&CreateRoomRequest {
            name: "Alice Pinned Workspace".to_string(),
            description: String::new(),
            default_agent_name: None,
            default_agent_role: None,
            default_agent_persona: None,
            default_agent_model: None,
            reasoning_effort: None,
            reasoning_summary: None,
            web_search: None,
            node_id: Some("node-chat-test".to_string()),
            workspace_path: Some("/tmp/allowed_tmp_ws_e2e_test".to_string()),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let alice_room_id = alice_room.room.room_id.clone();

    // 15. Test `workspace_fs` extension: upload image to bound temporary directory (`zone=tmp`),
    //     list `zone=tmp`, and download/preview via `/raw`.
    let fake_png_bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
    use base64::Engine as _;
    let b64_png = base64::engine::general_purpose::STANDARD.encode(fake_png_bytes);
    let upload_resp: serde_json::Value = http
        .post(format!(
            "{chat_base}/api/v1/ext/workspace_fs/rooms/{alice_room_id}/upload"
        ))
        .bearer_auth(&alice_token)
        .json(&serde_json::json!({
            "sub_dir": "uploads",
            "filename": "screenshot.png",
            "data_base64": b64_png,
            "dedupe": false
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(upload_resp["ok"], true);
    assert_eq!(upload_resp["is_image"], true);
    assert_eq!(
        upload_resp["agent_path"],
        ".ragents-tmp/uploads/screenshot.png"
    );

    // Verify listing `zone=tmp` shows `uploads/screenshot.png`
    let list_tmp_resp: serde_json::Value = http
        .get(format!(
            "{chat_base}/api/v1/ext/workspace_fs/rooms/{alice_room_id}/list?zone=tmp&path=uploads"
        ))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entries = list_tmp_resp["entries"].as_array().expect("entries array");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "screenshot.png");

    // Verify downloading/previewing via `/raw` returns exact PNG bytes and `image/png` Content-Type
    let raw_resp = http
        .get(format!(
            "{chat_base}/api/v1/ext/workspace_fs/rooms/{alice_room_id}/raw?zone=tmp&path=uploads/screenshot.png"
        ))
        .bearer_auth(&alice_token)
        .send()
        .await
        .unwrap();
    assert_eq!(raw_resp.status().as_u16(), 200);
    assert_eq!(
        raw_resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("image/png")
    );
    let downloaded_bytes = raw_resp.bytes().await.unwrap();
    assert_eq!(downloaded_bytes.as_ref(), fake_png_bytes);

    cancel.cancel();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_live_multi_agent_chatroom_when_env_present() {
    let Ok(base_url) = std::env::var("RAGENTS_BASE_URL") else {
        return;
    };
    let Ok(api_key) = std::env::var("RAGENTS_API_KEY") else {
        return;
    };
    let model_name =
        std::env::var("RAGENTS_MODEL").unwrap_or_else(|_| "gemini-3.8-flash".to_string());

    let cancel = CancellationToken::new();
    let tmp = tempfile::tempdir().expect("tempdir");

    // 1. Start `ragents-apiserver` protected by `StaticTokenAuthnPlugin`
    let ragents_token = "live-cluster-token-999";
    let mut exts = ApiServerExtensions::new();
    exts.add_authn(Arc::new(StaticTokenAuthnPlugin::new(ragents_token)));

    let store = SqliteStore::open_in_memory().expect("in-memory ragents store");
    let apiserver_state = ApiServerState::new(store, DEFAULT_LEASE_TTL_MS).with_extensions(exts);
    let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_addr = serve_tcp(api_listener, apiserver_state, cancel.clone())
        .await
        .unwrap();
    let ragents_url = format!("http://{api_addr}");

    // 2. Start `ragents-daemon` with real OpenResponses model backend
    let mut models = BTreeMap::new();
    models.insert(
        model_name.clone(),
        LocalModelConfig {
            base_url,
            api_key: Some(api_key),
            api_key_env: None,
            extra_headers: BTreeMap::new(),
            default_temperature: Some(0.2),
            default_max_output_tokens: Some(2048),
        },
    );

    let daemon_cfg = DaemonConfig {
        node_id: NodeId::new("node-live-chat"),
        server_url: ragents_url.clone(),
        auth_token: Some(ragents_token.to_string()),
        executor_mode: ExecutorMode::InProcess,
        max_concurrent_runners: 8,
        max_turns: None,
        default_system_prompt: "You are a helpful AI agent.".to_string(),
        default_model: Some(model_name.clone()),
        temp_root_dir: tmp.path().join("daemon_tmp"),
        extensions_dir: chatroom_wasm_path().parent().unwrap().to_path_buf(),
        allowed_workspace_dirs: default_allowed_workspace_dirs(),
        labels: BTreeMap::new(),
        auto_discover_models: true,
        models,
        extensions: vec![],
        interceptors: vec![],
        default_permissions: PermissionPolicyLayer::default(),
    };
    let daemon = AgentDaemon::new(daemon_cfg);
    daemon.start(cancel.clone()).await.unwrap();

    // 3. Start `chatroom-server`
    let chat_auth_token = "live-web-secret";
    let chat_store =
        ChatroomStore::open_in_memory(&model_name, vec![]).expect("chatroom in-memory store");
    let chat_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let chat_local_addr = chat_listener.local_addr().unwrap();
    let callback_base_url = format!("http://{chat_local_addr}");

    let ragents_client =
        RagentsClient::new(ragents_url).with_auth_token(Some(ragents_token.to_string()));
    let coordinator = RoomCoordinator::new(
        chat_store.clone(),
        ragents_client.clone(),
        callback_base_url.clone(),
    );
    let chat_state =
        ChatServerState::new(coordinator.clone(), Some(chat_auth_token.to_string()));
    let chat_addr = serve_chat_tcp(chat_listener, chat_state, cancel.clone())
        .await
        .unwrap();
    let chat_base = format!("http://{chat_addr}");
    let http = reqwest::Client::new();

    // 4. Create room with 1 default agent (`@Architect`)
    let created_room: RoomDetailResponse = http
        .post(format!("{chat_base}/api/v1/rooms"))
        .bearer_auth(chat_auth_token)
        .json(&CreateRoomRequest {
            name: "Live AI 架构讨论群".to_string(),
            description: "真实模型测试".to_string(),
            default_agent_name: Some("Architect".to_string()),
            default_agent_role: Some("分布式系统架构师".to_string()),
            default_agent_persona: Some(
                "You are @Architect, a concise distributed systems architect. Always reply in 1-2 sentences in Chinese."
                    .to_string(),
            ),
            default_agent_model: Some(model_name.clone()),
            reasoning_effort: Some("high".to_string()),
            reasoning_summary: Some("concise".to_string()),
            web_search: Some(true),
            node_id: None,
            workspace_path: None,
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let room_id = created_room.room.room_id.clone();

    // 5. Send a single-chat message (auto-@Architect)
    let _: RoomMessage = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/messages"))
        .bearer_auth(chat_auth_token)
        .json(&PostMessageRequest {
            sender_name: "Human".to_string(),
            content: "你好！请用一句话介绍你在分布式一致性方面的专长。".to_string(),
            mentions: vec![],
            visible_to: vec![],
            reply_to_seq: None,
            is_realtime: false,
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let mut architect_replied = false;
    for _ in 0..120 {
        let detail: RoomDetailResponse = http
            .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
            .bearer_auth(chat_auth_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if let Some(m) = detail
            .messages
            .iter()
            .find(|m| m.sender_name == "Architect")
        {
            println!("[Live Single-Chat] @Architect replied: {}", m.content);
            architect_replied = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(architect_replied, "Live @Architect must reply via chatroom_speak");

    // 6. Ask `@Manager` to recruit a Rust Engineer (`@RustDev`) into the room
    let mgr_msg: RoomMessage = http
        .post(format!("{chat_base}/api/v1/rooms/{room_id}/recruit"))
        .bearer_auth(chat_auth_token)
        .json(&RecruitAgentRequest {
            requirement: "请招募一位名叫 RustDev 的 Rust 性能优化专家，回答请简短控制在1-2句话。"
                .to_string(),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    println!("[Live @Manager]: {}", mgr_msg.content);

    let detail_after: RoomDetailResponse = http
        .get(format!("{chat_base}/api/v1/rooms/{room_id}"))
        .bearer_auth(chat_auth_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        detail_after.agents.len() >= 2,
        "Room should now have at least 2 agents after @Manager recruitment"
    );

    cancel.cancel();
}
