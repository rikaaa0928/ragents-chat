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
    workspace_path: Option<String>,
    #[serde(default)]
    room_tmp_dir: String,
    #[serde(default)]
    agent_id: String,
    #[serde(default)]
    agent_name: String,
    #[serde(default)]
    agent_role: String,
    #[serde(default)]
    agent_token: String,
    #[serde(default)]
    node_temp_root_dir: String,
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
                Subscription {
                    hook: "node.call",
                    kind: "action",
                    priority: 100,
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
                let room_tmp_dir = if !cfg.room_tmp_dir.trim().is_empty() {
                    cfg.room_tmp_dir.trim().to_string()
                } else if !cfg.room_id.trim().is_empty() {
                    format!("/tmp/ragents/rooms/{}", cfg.room_id.trim())
                } else {
                    "/tmp/ragents/rooms/default".to_string()
                };
                let directory_layout_section = if let Some(ws_path) = cfg
                    .workspace_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    format!(
                        "7. WORKSPACE & 3-TIER DIRECTORY LAYOUT (PINNED WORKSPACE MODE):\n\
   - Project Working Directory (`.` / `cwd`): `{ws_path}`\n\
     Your bound project workspace and current working directory. Read and edit project source code here. Visible to @Human in the UI File Panel (\"工作目录\" tab).\n\
   - Room Shared Temporary Directory: `{room_tmp_dir}`\n\
     Shared across @Human and all Agents in this chatroom (`\"{room_name}\"`). Files uploaded or pasted by @Human (`{room_tmp_dir}/uploads/...`) land here, and any temporary files/artifacts you want to share with @Human or other Agents in this room should be placed here. Visible to @Human in the UI File Panel (\"房间临时目录\" tab).\n\
   - Agent Private Session Temporary Directory (`$TMPDIR`):\n\
     Private to your own Agent Session only (not shown in the UI File Panel). Use `$TMPDIR` for your own private scratch files or intermediate build caches.\n"
                    )
                } else {
                    format!(
                        "7. WORKSPACE & DIRECTORY LAYOUT (FLOATING ROOM MODE):\n\
   - Current Working Directory & Room Shared Temporary Directory (`.` / `cwd`): `{room_tmp_dir}`\n\
     Because this room has no bound external project workspace, your current working directory (`.`) IS the Room Shared Temporary Directory (`{room_tmp_dir}`).\n\
     All Agents in this room share `{room_tmp_dir}`, and @Human can directly browse, preview, download, and upload files (`uploads/...`) in `{room_tmp_dir}` via the UI File Panel.\n\
     Save any scripts, documents, images, or deliverables intended for @Human or teammates directly inside `.` (`{room_tmp_dir}`).\n\
   - Agent Private Session Temporary Directory (`$TMPDIR`):\n\
     Private to your own Agent Session only (not shown in the UI File Panel). Use `$TMPDIR` only for private scratch/cache files that @Human does not need to inspect.\n"
                    )
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
   - When directly @mentioned by @Human: complete any private tool actions in your session first, then you MUST call `chatroom_speak` to reply in the chatroom. Do NOT put other agents in `mentions` unless you explicitly need them to execute a task. After calling `chatroom_speak`, finish your internal turn with a brief natural takeaway note.\n\
   - When @mentioned by another participant: if you were assigned a specific task or question, complete your work and call `chatroom_speak` (contribute only incremental content—never repeat full summaries already posted). If the task is already complete or they were only thanking/signing off, DO NOT call `chatroom_speak`—finish silently with a brief private note or takeaway summary. Only put another agent in `mentions` if you require them to perform a follow-up task.\n\
2. STRICT @MENTION DISCIPLINE (ONLY @ WHEN ASSIGNING A TASK):\n\
   - Passing an Agent's name in `mentions` (e.g. `[\"OptionStrategist\"]`) immediately wakes that Agent up to execute a new turn.\n\
   - ONLY put an Agent in `mentions` when you are explicitly asking that Agent to perform a task or answer a question.\n\
   - NEVER put other Agents in `mentions` when delivering a final summary to @Human, or when merely referencing, thanking, or agreeing with a teammate.\n\
   - Do NOT repeat `@Name` at the beginning of `content` if `Name` is already in `mentions` (the UI automatically renders `mentions` badges).\n\
3. NO MEANINGLESS ACKS, SIGN-OFFS, OR REPETITIVE SUMMARIES:\n\
   - NEVER post pure acknowledgments, sign-offs, or polite echoes (e.g., \"确认无误 ✅\", \"收到，进入待命状态\", \"完全同意 @xxx 的方案\").\n\
   - Even if another Agent @mentioned you, if the task is already complete or you have no new substantive information to add, DO NOT call `chatroom_speak`—simply finish your internal turn with a brief private note or summary in your own words.\n\
   - After calling `chatroom_speak`, finish your internal turn naturally with a short private summary of what you did (never repeat fixed boilerplate words).\n\
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
   - Otherwise (or if `chatroom_speak` is disabled in Muted Observation Mode), DO NOT call `chatroom_speak` and finish with a brief private note or takeaway summary of the discussion.\n\
{directory_layout_section}</chatroom_protocol>"
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
            "node.call" => {
                let cfg = STATE
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|s| s.config.clone()))
                    .unwrap_or_default();
                let out = handle_node_fs_call(&cfg, req.payload);
                Ok(json!({ "action": "continue", "payload": out }).to_string())
            }
            other => Err(format!("unsupported hook: {other}")),
        }
    }

    fn shutdown() {}
}

const MAX_TEXT_PREVIEW_BYTES: usize = 512 * 1024;
const HTTP_UPLOAD_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct NodeFsCallPayload {
    op: String,
    #[serde(default)]
    zone: String,
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    tmp_dir: Option<String>,
    #[serde(default)]
    rel_path: String,
    #[serde(default)]
    max_bytes: Option<usize>,
    #[serde(default)]
    upload_url: Option<String>,
    #[serde(default)]
    upload_token: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    download_token: Option<String>,
    #[serde(default)]
    expected_size: Option<u64>,
}

#[derive(Debug, Serialize)]
struct FsEntryDto {
    name: String,
    rel_path: String,
    is_dir: bool,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<String>,
}

fn sanitize_rel_path(raw: &str) -> Result<std::path::PathBuf, String> {
    use std::path::{Component, Path, PathBuf};
    let trimmed = raw.trim().trim_start_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(PathBuf::new());
    }
    let mut clean = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(part) => clean.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(
                    "invalid relative path: path traversal ('..') is forbidden".to_string(),
                );
            }
        }
    }
    Ok(clean)
}

fn resolve_zone_root_info(
    cfg: &ChatroomPluginConfig,
    req: &NodeFsCallPayload,
) -> Result<(String, String), String> {
    if req.zone == "workspace" {
        let ws = req
            .workspace_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "Current room has no bound workspace_path (Floating mode only has temporary directory zone=tmp)"
                    .to_string()
            })?;
        Ok((ws.to_string(), String::new()))
    } else if let Some(tmp_str) = req.tmp_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let prefix = tmp_str.trim_end_matches('/').to_string();
        Ok((tmp_str.to_string(), prefix))
    } else if let Some(ws_str) = req
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let dir = format!("{}/.ragents-tmp", ws_str.trim_end_matches('/'));
        Ok((dir, ".ragents-tmp".to_string()))
    } else {
        let base = if cfg.node_temp_root_dir.trim().is_empty() {
            "/tmp/ragents"
        } else {
            cfg.node_temp_root_dir.trim().trim_end_matches('/')
        };
        let dir = format!("{base}/chatroom-tmp");
        Ok((dir.clone(), dir))
    }
}

fn handle_node_fs_call(cfg: &ChatroomPluginConfig, raw_payload: Value) -> Value {
    use std::io::Read;
    use std::path::{Path, PathBuf};

    let req: NodeFsCallPayload = match serde_json::from_value(raw_payload) {
        Ok(r) => r,
        Err(e) => {
            return json!({
                "ok": false,
                "error": format!("invalid node_fs payload: {e}"),
            });
        }
    };

    let (root_dir_str, agent_prefix) = match resolve_zone_root_info(cfg, &req) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "error": err,
            });
        }
    };

    let clean_rel = match sanitize_rel_path(&req.rel_path) {
        Ok(p) => p,
        Err(err) => {
            return json!({
                "ok": false,
                "error": err,
                "root_dir": root_dir_str,
            });
        }
    };

    let clean_rel_str = clean_rel.to_string_lossy().replace('\\', "/");
    let agent_path = if agent_prefix.is_empty() {
        if clean_rel_str.is_empty() {
            ".".to_string()
        } else {
            clean_rel_str.clone()
        }
    } else if clean_rel_str.is_empty() {
        agent_prefix.clone()
    } else {
        format!("{agent_prefix}/{clean_rel_str}")
    };

    // Since `ragents-daemon` sets `primary_root` to `root_dir_str`, "." in WASI is `root_dir_str`.
    let target_path = if clean_rel.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        Path::new(".").join(&clean_rel)
    };

    if req.zone != "workspace" {
        let _ = std::fs::create_dir_all(".");
    }

    match req.op.as_str() {
        "list_dir" => {
            if !target_path.exists() {
                if req.zone != "workspace" && clean_rel.as_os_str().is_empty() {
                    let _ = std::fs::create_dir_all(&target_path);
                } else {
                    return json!({
                        "ok": false,
                        "error": format!("directory does not exist: {}", clean_rel_str),
                        "root_dir": root_dir_str,
                        "resolved_rel_path": clean_rel_str,
                        "agent_path": agent_path,
                    });
                }
            }
            if !target_path.is_dir() {
                return json!({
                    "ok": false,
                    "error": format!("not a directory: {}", clean_rel_str),
                    "root_dir": root_dir_str,
                    "resolved_rel_path": clean_rel_str,
                    "agent_path": agent_path,
                });
            }

            let read_dir = match std::fs::read_dir(&target_path) {
                Ok(rd) => rd,
                Err(e) => {
                    return json!({
                        "ok": false,
                        "error": format!("failed to read directory: {e}"),
                        "root_dir": root_dir_str,
                        "resolved_rel_path": clean_rel_str,
                        "agent_path": agent_path,
                    });
                }
            };

            let mut entries = Vec::new();
            for item in read_dir.flatten() {
                let name = item.file_name().to_string_lossy().to_string();
                if name == "." || name == ".." {
                    continue;
                }
                let Ok(meta) = item.metadata() else {
                    continue;
                };
                let is_dir = meta.is_dir();
                let size = if is_dir { 0 } else { meta.len() };
                let entry_rel = if clean_rel_str.is_empty() {
                    name.clone()
                } else {
                    format!("{clean_rel_str}/{name}")
                };
                entries.push(FsEntryDto {
                    name,
                    rel_path: entry_rel,
                    is_dir,
                    size,
                    modified_at: None,
                });
            }

            entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });

            json!({
                "ok": true,
                "root_dir": root_dir_str,
                "resolved_rel_path": clean_rel_str,
                "agent_path": agent_path,
                "entries": entries,
            })
        }
        "stat_file" => {
            if !target_path.exists() || !target_path.is_file() {
                return json!({
                    "ok": false,
                    "error": format!("file not found: {}", clean_rel_str),
                    "root_dir": root_dir_str,
                    "resolved_rel_path": clean_rel_str,
                    "agent_path": agent_path,
                });
            }
            let meta = match std::fs::metadata(&target_path) {
                Ok(m) => m,
                Err(e) => {
                    return json!({
                        "ok": false,
                        "error": format!("failed to stat file: {e}"),
                        "root_dir": root_dir_str,
                        "resolved_rel_path": clean_rel_str,
                        "agent_path": agent_path,
                    });
                }
            };
            let total_size = meta.len();
            let mut head = [0u8; 64];
            let head_n = std::fs::File::open(&target_path)
                .and_then(|mut f| f.read(&mut head))
                .unwrap_or(0);
            let mime_type = detect_mime_type(&clean_rel, &head[..head_n]);
            json!({
                "ok": true,
                "root_dir": root_dir_str,
                "resolved_rel_path": clean_rel_str,
                "agent_path": agent_path,
                "size": total_size,
                "mime_type": mime_type,
            })
        }
        "read_file" => {
            if !target_path.exists() || !target_path.is_file() {
                return json!({
                    "ok": false,
                    "error": format!("file not found: {}", clean_rel_str),
                    "root_dir": root_dir_str,
                    "resolved_rel_path": clean_rel_str,
                    "agent_path": agent_path,
                });
            }
            let meta = match std::fs::metadata(&target_path) {
                Ok(m) => m,
                Err(e) => {
                    return json!({
                        "ok": false,
                        "error": format!("failed to stat file: {e}"),
                        "root_dir": root_dir_str,
                        "resolved_rel_path": clean_rel_str,
                        "agent_path": agent_path,
                    });
                }
            };
            let total_size = meta.len();
            let limit = req
                .max_bytes
                .unwrap_or(MAX_TEXT_PREVIEW_BYTES)
                .min(MAX_TEXT_PREVIEW_BYTES);
            let file = match std::fs::File::open(&target_path) {
                Ok(f) => f,
                Err(e) => {
                    return json!({
                        "ok": false,
                        "error": format!("failed to open file: {e}"),
                        "root_dir": root_dir_str,
                        "resolved_rel_path": clean_rel_str,
                        "agent_path": agent_path,
                    });
                }
            };
            let mut buf = Vec::new();
            if let Err(e) = file.take(limit as u64).read_to_end(&mut buf) {
                return json!({
                    "ok": false,
                    "error": format!("failed to read file: {e}"),
                    "root_dir": root_dir_str,
                    "resolved_rel_path": clean_rel_str,
                    "agent_path": agent_path,
                });
            }
            let truncated = (buf.len() as u64) < total_size;
            let mime_type = detect_mime_type(&clean_rel, &buf);
            let is_text = is_likely_utf8_text(&buf);
            let text_preview = if is_text {
                Some(String::from_utf8_lossy(&buf).into_owned())
            } else {
                None
            };
            json!({
                "ok": true,
                "root_dir": root_dir_str,
                "resolved_rel_path": clean_rel_str,
                "agent_path": agent_path,
                "size": total_size,
                "mime_type": mime_type,
                "is_text": is_text,
                "text_preview": text_preview,
                "truncated": truncated,
            })
        }
        "upload_to_http" => {
            let Some(upload_url) = req.upload_url.as_deref().filter(|s| !s.is_empty()) else {
                return json!({ "ok": false, "error": "missing upload_url" });
            };
            if !target_path.exists() || !target_path.is_file() {
                return json!({
                    "ok": false,
                    "error": format!("file not found: {}", clean_rel_str),
                });
            }
            let total_size = match std::fs::metadata(&target_path) {
                Ok(m) => m.len(),
                Err(e) => return json!({ "ok": false, "error": e.to_string() }),
            };
            let tok = req.upload_token.as_deref().unwrap_or("");

            if total_size <= HTTP_UPLOAD_CHUNK_BYTES {
                let mut ok = false;
                let mut last_err = String::new();
                for _ in 0..3 {
                    match wasi_put_file_range(&target_path, 0, total_size, upload_url, tok) {
                        Ok(()) => {
                            ok = true;
                            break;
                        }
                        Err(e) => last_err = e,
                    }
                }
                if !ok {
                    let _ = wasi_post_empty(&format!("{upload_url}?failed=1"), "x-upload-token", tok, b"");
                    return json!({ "ok": false, "error": last_err });
                }
            } else {
                let mut offset = 0u64;
                while offset < total_size {
                    let len = (total_size - offset).min(HTTP_UPLOAD_CHUNK_BYTES);
                    let chunk_url = format!("{upload_url}?offset={offset}");
                    let mut chunk_ok = false;
                    let mut last_err = String::new();
                    for _ in 0..3 {
                        match wasi_put_file_range(&target_path, offset, len, &chunk_url, tok) {
                            Ok(()) => {
                                chunk_ok = true;
                                break;
                            }
                            Err(e) => last_err = e,
                        }
                    }
                    if !chunk_ok {
                        let _ = wasi_post_empty(&format!("{upload_url}?failed=1"), "x-upload-token", tok, b"");
                        return json!({ "ok": false, "error": last_err });
                    }
                    offset += len;
                }
                if let Err(e) = wasi_post_empty(&format!("{upload_url}?complete=1"), "x-upload-token", tok, b"") {
                    return json!({ "ok": false, "error": e });
                }
            }

            json!({
                "ok": true,
                "size": total_size,
                "resolved_rel_path": clean_rel_str,
                "agent_path": agent_path,
            })
        }
        "download_from_http" => {
            if req.zone == "workspace" {
                return json!({
                    "ok": false,
                    "error": "download_from_http is only permitted in zone=tmp",
                });
            }
            let Some(download_url) = req.download_url.as_deref().filter(|s| !s.is_empty()) else {
                return json!({ "ok": false, "error": "missing download_url" });
            };
            let tok = req.download_token.as_deref().unwrap_or("");
            if let Some(parent) = target_path.parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        return json!({ "ok": false, "error": format!("failed to create parent dir: {e}") });
                    }
                }
            }

            let part_path = PathBuf::from(format!("{}.part", target_path.to_string_lossy()));
            let mut success = false;
            let mut last_err = String::new();

            for _ in 0..3 {
                match wasi_download_to_file(download_url, tok, &part_path, req.expected_size) {
                    Ok(()) => {
                        if let Err(e) = std::fs::rename(&part_path, &target_path) {
                            last_err = format!("rename failed: {e}");
                            let _ = std::fs::remove_file(&part_path);
                            break;
                        }
                        success = true;
                        break;
                    }
                    Err(e) => {
                        last_err = e;
                        let _ = std::fs::remove_file(&part_path);
                    }
                }
            }

            if success {
                let _ = wasi_post_empty(
                    &format!("{download_url}?complete=1"),
                    "x-distribute-token",
                    tok,
                    b"",
                );
                json!({
                    "ok": true,
                    "resolved_rel_path": clean_rel_str,
                    "agent_path": agent_path,
                    "size": req.expected_size,
                })
            } else {
                let _ = std::fs::remove_file(&part_path);
                let _ = wasi_post_empty(
                    &format!("{download_url}?failed=1"),
                    "x-distribute-token",
                    tok,
                    last_err.as_bytes(),
                );
                json!({
                    "ok": false,
                    "error": last_err,
                })
            }
        }
        other => json!({
            "ok": false,
            "error": format!("unknown node_fs op: {other}"),
        }),
    }
}

fn wasi_put_file_range(
    file_path: &std::path::Path,
    offset: u64,
    len: u64,
    url: &str,
    upload_token: &str,
) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(file_path).map_err(|e| e.to_string())?;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    }

    let (scheme, authority, path_with_query) = parse_http_url(url)?;
    let headers = Fields::new();
    headers
        .append("content-type", b"application/octet-stream")
        .map_err(|e| format!("{e:?}"))?;
    headers
        .append("content-length", len.to_string().as_bytes())
        .map_err(|e| format!("{e:?}"))?;
    if !upload_token.is_empty() {
        headers
            .append("x-upload-token", upload_token.as_bytes())
            .map_err(|e| format!("{e:?}"))?;
    }

    let req = OutgoingRequest::new(headers);
    req.set_method(&Method::Put).map_err(|_| "set_method failed".to_string())?;
    req.set_scheme(Some(&scheme)).map_err(|_| "set_scheme failed".to_string())?;
    req.set_authority(Some(&authority)).map_err(|_| "set_authority failed".to_string())?;
    req.set_path_with_query(Some(&path_with_query)).map_err(|_| "set_path failed".to_string())?;

    let outgoing_body = req.body().map_err(|_| "req.body failed".to_string())?;
    let future_resp = outgoing_handler::handle(req, None)
        .map_err(|e| format!("outgoing_handler::handle error: {e:?}"))?;

    {
        let out_stream = outgoing_body
            .write()
            .map_err(|_| "outgoing_body.write failed".to_string())?;
        let mut remaining = len;
        let mut buf = [0u8; 4096];
        while remaining > 0 {
            let to_read = (remaining as usize).min(buf.len());
            let n = file.read(&mut buf[..to_read]).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out_stream
                .blocking_write_and_flush(&buf[..n])
                .map_err(|e| format!("blocking_write_and_flush error: {e:?}"))?;
            remaining -= n as u64;
        }
    }
    OutgoingBody::finish(outgoing_body, None).map_err(|e| format!("finish body error: {e:?}"))?;

    let incoming_resp = loop {
        if let Some(res) = future_resp.get() {
            let inner = res.map_err(|_| "future_resp consumed".to_string())?;
            break inner.map_err(|e| format!("HTTP PUT failed: {e:?}"))?;
        }
        let pollable = future_resp.subscribe();
        pollable.block();
    };

    let status = incoming_resp.status();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP PUT returned status {status}"));
    }
    Ok(())
}

fn wasi_post_empty(
    url: &str,
    token_header: &str,
    token_val: &str,
    body_bytes: &[u8],
) -> Result<(), String> {
    let (scheme, authority, path_with_query) = parse_http_url(url)?;
    let headers = Fields::new();
    headers
        .append("content-length", body_bytes.len().to_string().as_bytes())
        .map_err(|e| format!("{e:?}"))?;
    if !token_val.is_empty() {
        headers
            .append(token_header, token_val.as_bytes())
            .map_err(|e| format!("{e:?}"))?;
    }

    let req = OutgoingRequest::new(headers);
    req.set_method(&Method::Post).map_err(|_| "set_method failed".to_string())?;
    req.set_scheme(Some(&scheme)).map_err(|_| "set_scheme failed".to_string())?;
    req.set_authority(Some(&authority)).map_err(|_| "set_authority failed".to_string())?;
    req.set_path_with_query(Some(&path_with_query)).map_err(|_| "set_path failed".to_string())?;

    let outgoing_body = req.body().map_err(|_| "req.body failed".to_string())?;
    let future_resp = outgoing_handler::handle(req, None)
        .map_err(|e| format!("outgoing_handler::handle error: {e:?}"))?;

    {
        let out_stream = outgoing_body
            .write()
            .map_err(|_| "outgoing_body.write failed".to_string())?;
        for chunk in body_bytes.chunks(4096) {
            out_stream
                .blocking_write_and_flush(chunk)
                .map_err(|e| format!("write error: {e:?}"))?;
        }
    }
    OutgoingBody::finish(outgoing_body, None).map_err(|e| format!("finish error: {e:?}"))?;

    let incoming_resp = loop {
        if let Some(res) = future_resp.get() {
            let inner = res.map_err(|_| "future_resp consumed".to_string())?;
            break inner.map_err(|e| format!("HTTP POST failed: {e:?}"))?;
        }
        let pollable = future_resp.subscribe();
        pollable.block();
    };
    let status = incoming_resp.status();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP POST returned status {status}"));
    }
    Ok(())
}

fn wasi_download_to_file(
    url: &str,
    distribute_token: &str,
    part_path: &std::path::Path,
    expected_size: Option<u64>,
) -> Result<(), String> {
    use std::io::Write;

    let (scheme, authority, path_with_query) = parse_http_url(url)?;
    let headers = Fields::new();
    if !distribute_token.is_empty() {
        headers
            .append("x-distribute-token", distribute_token.as_bytes())
            .map_err(|e| format!("{e:?}"))?;
    }

    let req = OutgoingRequest::new(headers);
    req.set_method(&Method::Get).map_err(|_| "set_method failed".to_string())?;
    req.set_scheme(Some(&scheme)).map_err(|_| "set_scheme failed".to_string())?;
    req.set_authority(Some(&authority)).map_err(|_| "set_authority failed".to_string())?;
    req.set_path_with_query(Some(&path_with_query)).map_err(|_| "set_path failed".to_string())?;

    let future_resp = outgoing_handler::handle(req, None)
        .map_err(|e| format!("outgoing_handler::handle error: {e:?}"))?;

    let incoming_resp = loop {
        if let Some(res) = future_resp.get() {
            let inner = res.map_err(|_| "future_resp consumed".to_string())?;
            break inner.map_err(|e| format!("HTTP GET failed: {e:?}"))?;
        }
        let pollable = future_resp.subscribe();
        pollable.block();
    };

    let status = incoming_resp.status();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP GET returned status {status}"));
    }

    let incoming_body = incoming_resp
        .consume()
        .map_err(|_| "failed to consume incoming body".to_string())?;
    let body_stream = incoming_body
        .stream()
        .map_err(|_| "failed to acquire incoming body stream".to_string())?;

    let mut file = std::fs::File::create(part_path).map_err(|e| e.to_string())?;
    let mut received = 0u64;
    loop {
        match body_stream.blocking_read(65536) {
            Ok(chunk) if chunk.is_empty() => break,
            Ok(chunk) => {
                file.write_all(&chunk).map_err(|e| e.to_string())?;
                received += chunk.len() as u64;
            }
            Err(wasi::io::streams::StreamError::Closed) => break,
            Err(e) => return Err(format!("stream read error: {e:?}")),
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    drop(body_stream);
    let _ = wasi::http::types::IncomingBody::finish(incoming_body);

    if let Some(exp) = expected_size {
        if received != exp {
            return Err(format!("size mismatch: received {received}, expected {exp}"));
        }
    }
    Ok(())
}

fn is_likely_utf8_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return false;
    }
    std::str::from_utf8(sample).is_ok()
}

fn detect_mime_type(path: &std::path::Path, bytes: &[u8]) -> String {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "image/png".to_string();
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg".to_string();
    }
    if bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP" {
        return "image/webp".to_string();
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return "image/gif".to_string();
    }
    if bytes.starts_with(b"%PDF-") {
        return "application/pdf".to_string();
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "ts" | "tsx" | "jsx" => "text/javascript; charset=utf-8",
        "rs" | "py" | "go" | "toml" | "yaml" | "yml" | "sh" | "txt" | "log" | "csv" | "sql" => {
            "text/plain; charset=utf-8"
        }
        _ => {
            if is_likely_utf8_text(bytes) {
                "text/plain; charset=utf-8"
            } else {
                "application/octet-stream"
            }
        }
    }
    .to_string()
}

export!(ChatroomExtension);
