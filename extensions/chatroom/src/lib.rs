use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use wasi::http::outgoing_handler;
use wasi::http::types::{Fields, Method, OutgoingBody, OutgoingRequest, Scheme};

wit_bindgen::generate!({
    path: "../../wit",
    world: "plugin",
});

#[derive(Debug, Clone, Default, Deserialize)]
struct ChatroomPluginConfig {
    #[serde(default)]
    is_manager: bool,
    #[serde(default)]
    chatroom_callback_url: String,
    #[serde(default)]
    chatroom_add_agent_url: String,
    #[serde(default)]
    chatroom_remove_agent_url: String,
    #[serde(default)]
    room_id: String,
    #[serde(default)]
    room_name: String,
    #[serde(default)]
    agent_id: String,
    #[serde(default)]
    agent_name: String,
    #[serde(default)]
    agent_role: String,
    #[serde(default)]
    agent_token: String,
}

#[derive(Debug, Default)]
struct PluginRuntimeState {
    config: ChatroomPluginConfig,
}

static STATE: Mutex<Option<PluginRuntimeState>> = Mutex::new(None);

#[derive(Serialize)]
struct Metadata<'a> {
    id: &'a str,
    version: &'a str,
    subscriptions: Vec<Subscription<'a>>,
}

#[derive(Serialize)]
struct Subscription<'a> {
    hook: &'a str,
    kind: &'a str,
    priority: i32,
    failure: &'a str,
}

#[derive(Deserialize)]
struct HookRequest {
    hook: String,
    payload: Value,
}

#[derive(Deserialize)]
struct ToolCallRequest {
    name: String,
    arguments: Value,
}

#[derive(Deserialize)]
struct SpeakArgs {
    content: String,
    #[serde(default)]
    mentions: Vec<String>,
    #[serde(default)]
    visible_to: Vec<String>,
    #[serde(default)]
    reply_to_seq: Option<u64>,
}

#[derive(Deserialize)]
struct AddAgentArgs {
    name: String,
    role_title: String,
    #[serde(default)]
    avatar: String,
    persona_prompt: String,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct RemoveAgentArgs {
    name: String,
}

#[derive(Serialize)]
struct ToolResult {
    success: bool,
    output: String,
    error: Option<String>,
}

fn parse_http_url(raw_url: &str) -> Result<(Scheme, String, String), String> {
    let (scheme, rest) = if let Some(r) = raw_url.strip_prefix("http://") {
        (Scheme::Http, r)
    } else if let Some(r) = raw_url.strip_prefix("https://") {
        (Scheme::Https, r)
    } else {
        return Err(format!("unsupported URL scheme in '{raw_url}'"));
    };

    let (authority, path_and_query) = match rest.find('/') {
        Some(idx) => (rest[..idx].to_string(), rest[idx..].to_string()),
        None => (rest.to_string(), "/".to_string()),
    };

    if authority.is_empty() {
        return Err(format!("empty authority in URL '{raw_url}'"));
    }

    Ok((scheme, authority, path_and_query))
}

fn post_json_via_wasi_http(url: &str, bearer_token: &str, body_bytes: &[u8]) -> Result<(u16, String), String> {
    let (scheme, authority, path_with_query) = parse_http_url(url)?;

    let headers = Fields::new();
    headers
        .append("content-type", b"application/json")
        .map_err(|e| format!("failed to set content-type header: {e:?}"))?;
    if !bearer_token.is_empty() {
        let auth_val = format!("Bearer {bearer_token}");
        headers
            .append("authorization", auth_val.as_bytes())
            .map_err(|e| format!("failed to set authorization header: {e:?}"))?;
    }

    let req = OutgoingRequest::new(headers);
    req.set_method(&Method::Post)
        .map_err(|_| "failed to set POST method".to_string())?;
    req.set_scheme(Some(&scheme))
        .map_err(|_| "failed to set URL scheme".to_string())?;
    req.set_authority(Some(&authority))
        .map_err(|_| "failed to set URL authority".to_string())?;
    req.set_path_with_query(Some(&path_with_query))
        .map_err(|_| "failed to set URL path".to_string())?;

    let outgoing_body = req
        .body()
        .map_err(|_| "failed to acquire request body".to_string())?;

    // IMPORTANT: Call `outgoing_handler::handle(req, None)` BEFORE writing chunks to `outgoing_body`.
    // In `wasmtime-wasi-http`, the body stream buffer is bounded (4KB), and nothing drains it
    // until `outgoing_handler::handle` spawns the background HTTP client task!
    let future_resp = outgoing_handler::handle(req, None)
        .map_err(|e| format!("wasi http outgoing_handler::handle error: {e:?}"))?;

    {
        let out_stream = outgoing_body
            .write()
            .map_err(|_| "failed to acquire request body stream".to_string())?;
        for chunk in body_bytes.chunks(4096) {
            out_stream
                .blocking_write_and_flush(chunk)
                .map_err(|e| format!("failed writing request body: {e:?}"))?;
        }
    }
    OutgoingBody::finish(outgoing_body, None)
        .map_err(|e| format!("failed finishing outgoing body: {e:?}"))?;

    let incoming_resp = loop {
        if let Some(res) = future_resp.get() {
            let inner = res.map_err(|_| "future_resp already consumed".to_string())?;
            break inner.map_err(|e| format!("HTTP request failed: {e:?}"))?;
        }
        let pollable = future_resp.subscribe();
        pollable.block();
    };

    let status = incoming_resp.status();
    let incoming_body = incoming_resp
        .consume()
        .map_err(|_| "failed to consume incoming body".to_string())?;
    let in_stream = incoming_body
        .stream()
        .map_err(|_| "failed to open incoming stream".to_string())?;

    let mut resp_bytes = Vec::new();
    loop {
        match in_stream.blocking_read(4096) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break;
                }
                resp_bytes.extend_from_slice(&chunk);
            }
            Err(wasi::io::streams::StreamError::Closed) => break,
            Err(e) => return Err(format!("error reading HTTP response body: {e:?}")),
        }
    }

    Ok((status, String::from_utf8_lossy(&resp_bytes).to_string()))
}

struct ChatroomExtension;

impl exports::ragent::extension::lifecycle::Guest for ChatroomExtension {
    fn metadata() -> String {
        serde_json::to_string(&Metadata {
            id: "chatroom",
            version: env!("CARGO_PKG_VERSION"),
            subscriptions: vec![
                Subscription {
                    hook: "agent.prepare",
                    kind: "transform",
                    priority: 80,
                    failure: "abort",
                },
                Subscription {
                    hook: "tools.call",
                    kind: "action",
                    priority: 90,
                    failure: "abort",
                },
            ],
        })
        .unwrap_or_default()
    }

    fn initialize(config_json: String) -> Result<(), String> {
        let cfg = if config_json.trim().is_empty() || config_json.trim() == "null" {
            ChatroomPluginConfig::default()
        } else {
            serde_json::from_str::<ChatroomPluginConfig>(&config_json)
                .map_err(|e| format!("invalid chatroom plugin config: {e}"))?
        };
        let mut guard = STATE.lock().map_err(|e| e.to_string())?;
        *guard = Some(PluginRuntimeState { config: cfg });
        Ok(())
    }

    fn invoke(request_json: String) -> Result<String, String> {
        let req: HookRequest = serde_json::from_str(&request_json).map_err(|e| e.to_string())?;
        match req.hook.as_str() {
            "agent.prepare" => {
                let cfg = STATE
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|s| s.config.clone()))
                    .unwrap_or_default();

                let room_name = if cfg.room_name.is_empty() {
                    "General"
                } else {
                    &cfg.room_name
                };
                let agent_name = if cfg.agent_name.is_empty() {
                    "Assistant"
                } else {
                    &cfg.agent_name
                };
                let agent_role = if cfg.agent_role.is_empty() {
                    "AI Agent"
                } else {
                    &cfg.agent_role
                };

                let protocol_prompt = if cfg.is_manager {
                    format!(
                        "<manager_protocol>\n\
You are @Manager ({agent_role}), the built-in Chatroom Butler & Specialist Recruiter for room \"{room_name}\".\n\
\n\
CRITICAL RULES FOR @MANAGER TOOL EXECUTION:\n\
1. ONE STEP AT A TIME (MODIFY ROSTER FIRST, SPEAK SECOND):\n\
   - When asked to recruit/add new specialist agents, call `chatroom_add_agent` for each required agent FIRST.\n\
   - When asked to remove/dismiss existing agents, call `chatroom_remove_agent` FIRST.\n\
   - Wait until all `chatroom_add_agent` / `chatroom_remove_agent` tool calls have succeeded and updated the room roster.\n\
   - ONLY AFTER all roster modifications are complete, call `chatroom_speak` ONCE to announce the roster update in the chatroom.\n\
2. LEAD-AGENT HANDOFF DISCIPLINE:\n\
   - When you call `chatroom_speak` after recruiting new specialist agents, put ONLY the Room Lead Coordinator (or the Agent who called you) in `mentions` (e.g. `mentions: [\"Assistant\"]`) so the Lead Agent can assign tasks in order.\n\
   - NEVER put all newly recruited agents in `mentions` simultaneously!\n\
   - If you only removed agents or answered a question from @Human without needing another Agent to act immediately, set `mentions: [\"Human\"]` or `[]`.\n\
3. PRIVATE INNER LOOP vs PUBLIC SPEECH:\n\
   - Normal assistant text output is private to your internal session. You MUST call `chatroom_speak` so your final reply appears in the chatroom.\n\
</manager_protocol>"
                    )
                } else {
                    format!(
                        "<chatroom_protocol>\n\
You are participating in the multi-participant AI chatroom \"{room_name}\" as @{agent_name} ({agent_role}).\n\
\n\
CRITICAL RULES FOR CHATROOM INTERACTION:\n\
1. PRIVATE INNER LOOP vs PUBLIC SPEECH:\n\
   - Everything you do inside your session (thinking, shell commands, reading/editing files, and normal assistant text responses) is 100% PRIVATE to your personal workspace.\n\
   - Nobody in the chatroom can see your normal assistant text output! To speak publicly, you MUST call `chatroom_speak`.\n\
2. STRICT @MENTION DISCIPLINE (ONLY @ WHEN ASSIGNING A TASK):\n\
   - Passing an Agent's name in `mentions` (e.g. `[\"OptionStrategist\"]`) immediately wakes that Agent up to execute a new turn.\n\
   - ONLY put an Agent in `mentions` when you are explicitly asking that Agent to perform a task or answer a question.\n\
   - NEVER put other Agents in `mentions` when delivering a final summary to @Human, or when merely referencing, thanking, or agreeing with a teammate.\n\
   - Do NOT repeat `@Name` at the beginning of `content` if `Name` is already in `mentions` (the UI automatically renders `mentions` badges).\n\
3. NO MEANINGLESS ACKS, SIGN-OFFS, OR REPETITIVE SUMMARIES:\n\
   - NEVER post pure acknowledgments, sign-offs, or polite echoes (e.g., \"确认无误 ✅\", \"收到，进入待命状态\", \"完全同意 @xxx 的方案\").\n\
   - Even if another Agent @mentioned you, if the task is already complete or you have no new substantive information to add, DO NOT call `chatroom_speak`—simply finish your internal turn with `Observed.`.\n\
   - All chatroom messages are visible to @Human and all members. Contribute ONLY incremental domain insights; NEVER copy-paste or re-summarize a full guide that was already posted in earlier messages unless @Human explicitly asks for a new revision.\n\
4. DEFAULT LEAD AGENT & @MANAGER RECRUITMENT:\n\
   - Unless @Human designates another lead, the FIRST Agent in the room roster (marked `[Default Room Lead]`) is the lead coordinator: responsible for decomposing tasks, delegating specific subtasks to specialists via `mentions`, and doing a single concise wrap-up (with `mentions: [\"Human\"]` ONLY) once specialists finish.\n\
   - If a task requires adding or removing a specialist Agent in the room, call `chatroom_speak` with `mentions: [\"Manager\"]` and describe the needed role, model, and skills.\n\
5. PRIVATE WHISPERS & VISIBILITY ISOLATION (`visible_to`):\n\
   - By default (`visible_to` omitted or empty `[]`), your `chatroom_speak` message is public to everyone in the room.\n\
   - If you need to send a secret/private message (e.g. secret role assignment, night-phase action in Werewolf, or private backchannel), pass `visible_to: [\"TargetAgentName\"]` in `chatroom_speak`. Only the participants listed in `visible_to` (plus yourself and @Human observer) can see that message; all other Agents are physically blinded from reading it.\n\
   - When replying to a `[🔒 Private Whisper ...]` message that must remain secret, remember to also set `visible_to` (e.g. `visible_to: [\"Judge\"]`) so your reply stays private!\n\
6. WHEN PEEKING AT UNREAD MESSAGES WHILE IDLE (`[Chatroom Unread Peek]`):\n\
   - Chime in (`chatroom_speak`) ONLY if you spot an error, a critical blind spot, or high-value domain expertise that nobody else has covered.\n\
   - Otherwise (or if `chatroom_speak` is disabled in Muted Observation Mode), DO NOT call `chatroom_speak` and finish with `Observed.`.\n\
</chatroom_protocol>"
                    )
                };

                let mut tools = Vec::new();
                if cfg.is_manager {
                    tools.push(json!({
                        "enabled": true,
                        "name": "chatroom_add_agent",
                        "description": "Recruit and add a new AI specialist agent into the current chatroom. Call this tool BEFORE calling chatroom_speak so the new agent is already seated in the room when you announce them.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "description": "Unique alphanumeric/Chinese handle without spaces or @ (e.g. 'Player1', 'SecAuditor', 'RustExpert')."
                                },
                                "role_title": {
                                    "type": "string",
                                    "description": "Concise role title (e.g. '安全与权限审计专家', '1号玩家·逻辑派')."
                                },
                                "avatar": {
                                    "type": "string",
                                    "description": "Single emoji representing this agent (e.g. '🛡️', '🦊', '🦉')."
                                },
                                "persona_prompt": {
                                    "type": "string",
                                    "description": "Detailed system prompt and behavioral rules for this agent."
                                },
                                "model": {
                                    "type": "string",
                                    "description": "Optional model identifier chosen from the cluster's Available Models."
                                }
                            },
                            "required": ["name", "role_title", "persona_prompt"]
                        }
                    }));
                    tools.push(json!({
                        "enabled": true,
                        "name": "chatroom_remove_agent",
                        "description": "Remove an existing AI agent from the current chatroom by name or agent_id. Call this tool BEFORE calling chatroom_speak.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "description": "Name (e.g. 'Player1') or agent_id of the agent to remove from the room."
                                }
                            },
                            "required": ["name"]
                        }
                    }));
                }

                tools.push(json!({
                    "enabled": true,
                    "name": "chatroom_speak",
                    "description": "Post a public message to the chatroom. Call this ONLY when you have substantive content to share. Do NOT call this for polite sign-offs ('收到', '已签收', '待命').",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "Message content to post publicly in the chatroom (Markdown supported). Do not prefix with redundant @Name tags already listed in `mentions`."
                            },
                            "mentions": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "ONLY include an Agent name here if you require that Agent to immediately execute a task or answer a question (e.g. ['Manager'] or ['Reviewer']). When replying to the user or delivering a final summary, use ['Human'] or []."
                            },
                            "visible_to": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Optional visibility whitelist for secret/private whispers (e.g. ['Player1'] or ['Judge', 'Player1']). If omitted or empty, everyone in the room can see the message. If non-empty, ONLY the listed participants (plus yourself and @Human observer) can see it."
                            },
                            "reply_to_seq": {
                                "type": "integer",
                                "description": "Optional message sequence number (#seq) you are replying to."
                            }
                        },
                        "required": ["content"]
                    }
                }));

                Ok(json!({
                    "action": "continue",
                    "payload": {
                        "append_system_prompt": protocol_prompt,
                        "tools": tools
                    }
                })
                .to_string())
            }
            "tools.call" => {
                let call: ToolCallRequest =
                    serde_json::from_value(req.payload).map_err(|e| e.to_string())?;

                let cfg = {
                    let guard = STATE.lock().map_err(|e| e.to_string())?;
                    let st = guard.as_ref().ok_or("chatroom extension not initialized")?;
                    st.config.clone()
                };

                match call.name.as_str() {
                    "chatroom_add_agent" => {
                        if !cfg.is_manager {
                            let res = ToolResult {
                                success: false,
                                output: "Permission denied: only @Manager can call chatroom_add_agent.".to_string(),
                                error: Some("permission_denied".to_string()),
                            };
                            return Ok(json!({ "action": "continue", "payload": res }).to_string());
                        }
                        let args: AddAgentArgs = match serde_json::from_value(call.arguments) {
                            Ok(a) => a,
                            Err(e) => {
                                let res = ToolResult {
                                    success: false,
                                    output: format!("Invalid arguments for chatroom_add_agent: {e}"),
                                    error: Some(e.to_string()),
                                };
                                return Ok(json!({ "action": "continue", "payload": res }).to_string());
                            }
                        };
                        let payload = json!({
                            "room_id": cfg.room_id,
                            "agent_id": cfg.agent_id,
                            "name": args.name,
                            "role_title": args.role_title,
                            "avatar": args.avatar,
                            "persona_prompt": args.persona_prompt,
                            "model": args.model,
                        });
                        let body_bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
                        let result = match post_json_via_wasi_http(
                            &cfg.chatroom_add_agent_url,
                            &cfg.agent_token,
                            &body_bytes,
                        ) {
                            Ok((status, resp_body)) if (200..300).contains(&status) => ToolResult {
                                success: true,
                                output: format!("Agent added to chatroom: {resp_body}"),
                                error: None,
                            },
                            Ok((status, resp_body)) => ToolResult {
                                success: false,
                                output: format!("Failed to add agent (HTTP {status}): {resp_body}"),
                                error: Some(format!("HTTP {status}: {resp_body}")),
                            },
                            Err(err) => ToolResult {
                                success: false,
                                output: format!("Failed to reach chatroom server: {err}"),
                                error: Some(err),
                            },
                        };
                        Ok(json!({ "action": "continue", "payload": result }).to_string())
                    }
                    "chatroom_remove_agent" => {
                        if !cfg.is_manager {
                            let res = ToolResult {
                                success: false,
                                output: "Permission denied: only @Manager can call chatroom_remove_agent.".to_string(),
                                error: Some("permission_denied".to_string()),
                            };
                            return Ok(json!({ "action": "continue", "payload": res }).to_string());
                        }
                        let args: RemoveAgentArgs = match serde_json::from_value(call.arguments) {
                            Ok(a) => a,
                            Err(e) => {
                                let res = ToolResult {
                                    success: false,
                                    output: format!("Invalid arguments for chatroom_remove_agent: {e}"),
                                    error: Some(e.to_string()),
                                };
                                return Ok(json!({ "action": "continue", "payload": res }).to_string());
                            }
                        };
                        let payload = json!({
                            "room_id": cfg.room_id,
                            "agent_id": cfg.agent_id,
                            "target_name": args.name,
                        });
                        let body_bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
                        let result = match post_json_via_wasi_http(
                            &cfg.chatroom_remove_agent_url,
                            &cfg.agent_token,
                            &body_bytes,
                        ) {
                            Ok((status, resp_body)) if (200..300).contains(&status) => ToolResult {
                                success: true,
                                output: format!("Agent removed from chatroom: {resp_body}"),
                                error: None,
                            },
                            Ok((status, resp_body)) => ToolResult {
                                success: false,
                                output: format!("Failed to remove agent (HTTP {status}): {resp_body}"),
                                error: Some(format!("HTTP {status}: {resp_body}")),
                            },
                            Err(err) => ToolResult {
                                success: false,
                                output: format!("Failed to reach chatroom server: {err}"),
                                error: Some(err),
                            },
                        };
                        Ok(json!({ "action": "continue", "payload": result }).to_string())
                    }
                    "chatroom_speak" => {
                        let args: SpeakArgs = match serde_json::from_value(call.arguments) {
                            Ok(a) => a,
                            Err(e) => {
                                let res = ToolResult {
                                    success: false,
                                    output: format!("Invalid arguments for chatroom_speak: {e}"),
                                    error: Some(e.to_string()),
                                };
                                return Ok(json!({ "action": "continue", "payload": res }).to_string());
                            }
                        };

                        let payload = json!({
                            "room_id": cfg.room_id,
                            "agent_id": cfg.agent_id,
                            "content": args.content,
                            "mentions": args.mentions,
                            "visible_to": args.visible_to,
                            "reply_to_seq": args.reply_to_seq,
                        });
                        let body_bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;

                        let result = match post_json_via_wasi_http(
                            &cfg.chatroom_callback_url,
                            &cfg.agent_token,
                            &body_bytes,
                        ) {
                            Ok((status, resp_body)) if (200..300).contains(&status) => ToolResult {
                                success: true,
                                output: format!("Message posted to chatroom: {resp_body}"),
                                error: None,
                            },
                            Ok((status, resp_body)) => ToolResult {
                                success: false,
                                output: format!(
                                    "Chatroom rejected message (HTTP {status}): {resp_body}"
                                ),
                                error: Some(format!("HTTP {status}: {resp_body}")),
                            },
                            Err(err) => ToolResult {
                                success: false,
                                output: format!("Failed to reach chatroom server: {err}"),
                                error: Some(err),
                            },
                        };

                        Ok(json!({ "action": "continue", "payload": result }).to_string())
                    }
                    other => Err(format!("unknown tool: {other}")),
                }
            }
            other => Err(format!("unsupported hook: {other}")),
        }
    }

    fn shutdown() {}
}

export!(ChatroomExtension);
