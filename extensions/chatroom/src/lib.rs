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
    chatroom_callback_url: String,
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
    is_muted_turn: bool,
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

fn extract_latest_user_text(items: &[Value]) -> String {
    for item in items.iter().rev() {
        if item.get("type").and_then(Value::as_str) == Some("message")
            && item.get("role").and_then(Value::as_str) == Some("user")
        {
            if let Some(arr) = item.get("content").and_then(Value::as_array) {
                let mut text = String::new();
                for block in arr {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        text.push_str(t);
                        text.push('\n');
                    }
                }
                return text;
            }
        }
    }
    String::new()
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
                    hook: "context.project.prepare",
                    kind: "transform",
                    priority: 50,
                    failure: "ignore",
                },
                Subscription {
                    hook: "model.request.prepare",
                    kind: "transform",
                    priority: 50,
                    failure: "ignore",
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
        *guard = Some(PluginRuntimeState {
            config: cfg,
            is_muted_turn: false,
        });
        Ok(())
    }

    fn invoke(request_json: String) -> Result<String, String> {
        let req: HookRequest = serde_json::from_str(&request_json).map_err(|e| e.to_string())?;
        match req.hook.as_str() {
            "agent.prepare" => {
                let mut draft = req.payload;
                let cfg = STATE
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|s| s.config.clone()))
                    .unwrap_or_default();

                let protocol_prompt = format!(
                    "\n\n<chatroom_protocol>\n\
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
   - If a task requires a new specialist Agent not yet in the room, call `chatroom_speak` with `mentions: [\"Manager\"]` and describe the needed role, model, and skills.\n\
5. PRIVATE WHISPERS & VISIBILITY ISOLATION (`visible_to`):\n\
   - By default (`visible_to` omitted or empty `[]`), your `chatroom_speak` message is public to everyone in the room.\n\
   - If you need to send a secret/private message (e.g. secret role assignment, night-phase action in Werewolf, or private backchannel), pass `visible_to: [\"TargetAgentName\"]` in `chatroom_speak`. Only the participants listed in `visible_to` (plus yourself and @Human observer) can see that message; all other Agents are physically blinded from reading it.\n\
   - When replying to a `[🔒 Private Whisper ...]` message that must remain secret, remember to also set `visible_to` (e.g. `visible_to: [\"Judge\"]`) so your reply stays private!\n\
6. WHEN PEEKING AT UNREAD MESSAGES WHILE IDLE (`[Chatroom Unread Peek]`):\n\
   - Chime in (`chatroom_speak`) ONLY if you spot an error, a critical blind spot, or high-value domain expertise that nobody else has covered.\n\
   - Otherwise (or if `[Chatroom Speak Permission: MUTED]` is active), DO NOT call `chatroom_speak` and finish with `Observed.`.\n\
</chatroom_protocol>",
                    room_name = if cfg.room_name.is_empty() {
                        "General"
                    } else {
                        &cfg.room_name
                    },
                    agent_name = if cfg.agent_name.is_empty() {
                        "Assistant"
                    } else {
                        &cfg.agent_name
                    },
                    agent_role = if cfg.agent_role.is_empty() {
                        "AI Agent"
                    } else {
                        &cfg.agent_role
                    },
                );

                if let Some(sys) = draft
                    .get("system_prompt")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    draft["system_prompt"] = Value::String(format!("{sys}{protocol_prompt}"));
                }

                if let Some(tools) = draft.get_mut("tools").and_then(Value::as_array_mut) {
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
                }

                Ok(json!({ "action": "continue", "payload": draft }).to_string())
            }
            "context.project.prepare" => {
                if let Some(items) = req.payload.as_array() {
                    let latest_user = extract_latest_user_text(items);
                    let muted = latest_user.contains("[Chatroom Speak Permission: MUTED]");
                    if let Ok(mut guard) = STATE.lock() {
                        if let Some(ref mut st) = *guard {
                            st.is_muted_turn = muted;
                        }
                    }
                }
                Ok(json!({ "action": "unchanged" }).to_string())
            }
            "model.request.prepare" => {
                let is_muted = STATE
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().map(|s| s.is_muted_turn))
                    .unwrap_or(false);
                if !is_muted {
                    return Ok(json!({ "action": "unchanged" }).to_string());
                }
                let mut model_req = req.payload;
                if let Some(tools) = model_req.get_mut("tools").and_then(Value::as_array_mut) {
                    tools.retain(|t| t.get("name").and_then(Value::as_str) != Some("chatroom_speak"));
                }
                Ok(json!({ "action": "continue", "payload": model_req }).to_string())
            }
            "tools.call" => {
                let call: ToolCallRequest =
                    serde_json::from_value(req.payload).map_err(|e| e.to_string())?;
                if call.name != "chatroom_speak" {
                    return Err(format!("unknown tool: {}", call.name));
                }

                let (cfg, is_muted) = {
                    let guard = STATE.lock().map_err(|e| e.to_string())?;
                    let st = guard.as_ref().ok_or("chatroom extension not initialized")?;
                    (st.config.clone(), st.is_muted_turn)
                };

                if is_muted {
                    let res = ToolResult {
                        success: false,
                        output: "Permission denied: You are muted for this peek turn (read-only observation).".to_string(),
                        error: Some("muted_in_turn".to_string()),
                    };
                    return Ok(json!({ "action": "continue", "payload": res }).to_string());
                }

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
            other => Err(format!("unsupported hook: {other}")),
        }
    }

    fn shutdown() {}
}

export!(ChatroomExtension);
