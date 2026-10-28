use crate::coordinator::RoomCoordinator;
use crate::extensions::{ChatExtensionHost, ChatPrincipal, ExtensionManifestResponse};
use crate::manager::recruit_agents_via_manager;
use crate::types::*;
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        Html, IntoResponse, Response,
    },
    routing::{any, get, patch, post},
    Json, Router,
};
use futures::stream::Stream;
use ragents_protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashMap, convert::Infallible, net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const WEB_INDEX_HTML: &str = include_str!("../../../web/dist/index.html");
const AUTH_COOKIE_NAME: &str = "ragents_chat_token";

#[derive(Clone)]
pub struct ChatServerState {
    pub coordinator: RoomCoordinator,
    pub auth_token: Option<Arc<String>>,
    pub extensions: ChatExtensionHost,
}

impl ChatServerState {
    pub fn new(coordinator: RoomCoordinator, auth_token: Option<String>) -> Self {
        let extensions = ChatExtensionHost::new(coordinator.clone(), auth_token.clone());
        Self {
            coordinator,
            auth_token: auth_token.map(Arc::new),
            extensions,
        }
    }
}

pub fn build_chat_router(state: ChatServerState) -> Router {
    Router::new()
        .route("/", get(handle_index_html))
        .route("/api/v1/auth/status", get(handle_auth_status))
        .route("/api/v1/auth/login", post(handle_auth_login))
        .route("/api/v1/auth/logout", post(handle_auth_logout))
        .route("/api/v1/extensions/manifest", get(handle_extensions_manifest))
        .route(
            "/api/v1/ext/{plugin_id}/{*subpath}",
            any(handle_extension_gateway),
        )
        .route(
            "/api/v1/settings/manager",
            get(handle_get_manager_settings).put(handle_update_manager_settings),
        )
        .route(
            "/api/v1/rooms",
            get(handle_list_rooms).post(handle_create_room),
        )
        .route(
            "/api/v1/rooms/{room_id}",
            get(handle_get_room)
                .patch(handle_patch_room)
                .delete(handle_delete_room),
        )
        .route(
            "/api/v1/rooms/{room_id}/messages",
            post(handle_post_message),
        )
        .route(
            "/api/v1/rooms/{room_id}/resume-relay",
            post(handle_resume_relay),
        )
        .route("/api/v1/rooms/{room_id}/stream", get(handle_room_stream))
        .route(
            "/api/v1/rooms/{room_id}/agents",
            post(handle_create_agent),
        )
        .route(
            "/api/v1/rooms/{room_id}/recruit",
            post(handle_recruit_agent),
        )
        .route(
            "/api/v1/rooms/{room_id}/agents/{agent_id}",
            patch(handle_patch_agent).delete(handle_remove_agent),
        )
        .route(
            "/api/v1/agents/{agent_id}/inspector",
            get(handle_get_inspector),
        )
        .route(
            "/api/v1/agents/{agent_id}/inspector/stream",
            get(handle_inspector_stream),
        )
        .route(
            "/api/v1/agents/{agent_id}/approve",
            post(handle_approve_permission),
        )
        .route(
            "/api/v1/agents/{agent_id}/cancel",
            post(handle_cancel_agent_activation),
        )
        .route(
            "/api/v1/agents/{agent_id}/queue/{msg_seq}/withdraw",
            post(handle_withdraw_queued_message),
        )
        .route(
            "/api/v1/internal/agent-speak",
            post(handle_internal_agent_speak),
        )
        .route(
            "/api/v1/internal/manager/add-agent",
            post(handle_internal_manager_add_agent),
        )
        .route(
            "/api/v1/internal/manager/remove-agent",
            post(handle_internal_manager_remove_agent),
        )
        .with_state(state)
}

pub async fn serve_chat_tcp(
    listener: TcpListener,
    state: ChatServerState,
    cancel: CancellationToken,
) -> anyhow::Result<SocketAddr> {
    let addr = listener.local_addr()?;
    state.coordinator.spawn_background_watcher(cancel.clone());
    let app = build_chat_router(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                cancel.cancelled().await;
            })
            .await;
    });
    Ok(addr)
}

fn verify_user_auth(
    state: &ChatServerState,
    headers: &HeaderMap,
) -> Result<ChatPrincipal, ChatApiError> {
    let cand = extract_bearer_or_cookie_token(headers);
    if let Some(principal) = state.extensions.authenticate_token(cand.as_deref()) {
        return Ok(principal);
    }

    Err(ChatApiError::Http(
        StatusCode::UNAUTHORIZED,
        "Unauthorized: valid access token required".to_string(),
    ))
}

fn verify_room_access(
    state: &ChatServerState,
    principal: &ChatPrincipal,
    room_id: &str,
) -> Result<Room, ChatApiError> {
    let room = state
        .coordinator
        .store
        .get_room(room_id)?
        .ok_or_else(|| ChatApiError::Http(StatusCode::NOT_FOUND, "room not found".into()))?;
    let agents = state.coordinator.store.list_room_agents(room_id)?;
    if !principal.can_access_room(&room, &agents) {
        return Err(ChatApiError::Http(
            StatusCode::FORBIDDEN,
            "Forbidden: 当前用户无权访问该聊天室绑定的节点或工作区目录".into(),
        ));
    }
    Ok(room)
}

fn extract_bearer_or_cookie_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth_val) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        let trimmed = auth_val.trim();
        if let Some(rest) = trimmed
            .strip_prefix("Bearer ")
            .or_else(|| trimmed.strip_prefix("bearer "))
        {
            let tok = rest.trim();
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }

    if let Some(cookie_hdr) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        for part in cookie_hdr.split(';') {
            if let Some((k, v)) = part.trim().split_once('=') {
                if k.trim() == AUTH_COOKIE_NAME && !v.trim().is_empty() {
                    return Some(v.trim().to_string());
                }
            }
        }
    }

    None
}

async fn handle_index_html() -> Html<&'static str> {
    Html(WEB_INDEX_HTML)
}

#[derive(Deserialize)]
struct LoginRequest {
    token: String,
}

async fn handle_auth_status(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    let required = state.extensions.auth_required;
    let principal = verify_user_auth(&state, &headers).ok();
    let authenticated = principal.is_some();
    let manifest = state.extensions.manifest();
    Json(json!({
        "auth_required": required,
        "authenticated": authenticated,
        "principal": principal,
        "manifest": manifest,
    }))
}

async fn handle_auth_login(
    State(state): State<ChatServerState>,
    Json(req): Json<LoginRequest>,
) -> Result<Response, ChatApiError> {
    let trimmed = req.token.trim();
    let principal = if state.extensions.auth_required {
        state
            .extensions
            .token_acl
            .authenticate_token(trimmed)
            .ok_or_else(|| ChatApiError::Http(StatusCode::UNAUTHORIZED, "访问密钥无效".to_string()))?
    } else {
        state
            .extensions
            .token_acl
            .authenticate_token(trimmed)
            .unwrap_or_else(ChatPrincipal::anonymous_admin)
    };
    let cookie = format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000",
        AUTH_COOKIE_NAME, trimmed
    );
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({
            "ok": true,
            "authenticated": true,
            "principal": principal,
        })),
    )
        .into_response())
}

async fn handle_auth_logout() -> Response {
    let clear_cookie = format!(
        "{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        AUTH_COOKIE_NAME
    );
    (
        [(header::SET_COOKIE, clear_cookie)],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

async fn handle_extensions_manifest(
    State(state): State<ChatServerState>,
) -> Json<ExtensionManifestResponse> {
    Json(state.extensions.manifest())
}

async fn handle_extension_gateway(
    State(state): State<ChatServerState>,
    method: Method,
    headers: HeaderMap,
    Path((plugin_id, subpath)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Result<Response, ChatApiError> {
    let principal = verify_user_auth(&state, &headers).ok();
    state
        .extensions
        .dispatch_http(&plugin_id, method, &subpath, &query, principal.as_ref(), body)
        .await
        .map_err(|(code, msg)| ChatApiError::Http(code, msg))
}

#[derive(Serialize)]
struct ManagerSettingsWithClusterResponse {
    settings: ManagerSettings,
    cluster_nodes: Vec<Node>,
}

async fn handle_get_manager_settings(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
) -> Result<Json<ManagerSettingsWithClusterResponse>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    let settings = state.coordinator.store.get_manager_settings()?;
    let cluster_nodes = state
        .coordinator
        .ragents_client
        .list_nodes()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|n| principal.can_access_node(Some(n.metadata.id.as_str())))
        .collect();
    Ok(Json(ManagerSettingsWithClusterResponse {
        settings,
        cluster_nodes,
    }))
}

async fn handle_update_manager_settings(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Json(patch): Json<UpdateManagerSettingsRequest>,
) -> Result<Json<ManagerSettings>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    if !principal.is_admin {
        return Err(ChatApiError::Http(
            StatusCode::FORBIDDEN,
            "仅管理员 (admin) 可修改全局 @Manager 设置".into(),
        ));
    }
    let updated = state.coordinator.store.update_manager_settings(patch)?;
    Ok(Json(updated))
}

async fn handle_list_rooms(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
) -> Result<Json<Vec<RoomSummary>>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    let rooms = state.coordinator.store.list_rooms()?;
    let mut summaries = Vec::with_capacity(rooms.len());
    for room in rooms {
        let raw_agents = state.coordinator.store.list_room_agents(&room.room_id)?;
        if !principal.can_access_room(&room, &raw_agents) {
            continue;
        }
        let mut agents = Vec::with_capacity(raw_agents.len());
        for a in raw_agents {
            agents.push(state.coordinator.to_agent_public_hydrated(a).await);
        }
        let msgs = state
            .coordinator
            .store
            .list_room_messages(&room.room_id, room.last_msg_seq.saturating_sub(1))?;
        summaries.push(RoomSummary {
            room,
            agents,
            last_message: msgs.into_iter().last(),
        });
    }
    Ok(Json(summaries))
}

async fn handle_create_room(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Json(req): Json<CreateRoomRequest>,
) -> Result<(StatusCode, Json<RoomDetailResponse>), ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    if !principal.can_access_workspace(req.node_id.as_deref(), req.workspace_path.as_deref()) {
        return Err(ChatApiError::Http(
            StatusCode::FORBIDDEN,
            "当前用户无权在所选节点或工作区目录创建聊天室".into(),
        ));
    }
    let detail = state
        .coordinator
        .create_room_with_default_agent(req)
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(detail)))
}

async fn handle_get_room(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Result<Json<RoomDetailResponse>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    let room = verify_room_access(&state, &principal, &room_id)?;
    let manager_agent = match state.coordinator.ensure_room_manager_agent(&room_id).await {
        Ok(m) => Some(state.coordinator.to_agent_public_hydrated(m).await),
        Err(_) => None,
    };
    let raw_agents = state.coordinator.store.list_room_agents(&room_id)?;
    let mut agents = Vec::with_capacity(raw_agents.len());
    for a in raw_agents {
        agents.push(state.coordinator.to_agent_public_hydrated(a).await);
    }
    let messages = state.coordinator.store.list_room_messages(&room_id, 0)?;
    let flow_logs = state.coordinator.get_room_flow_logs(&room_id);
    Ok(Json(RoomDetailResponse {
        room,
        manager_agent,
        agents,
        messages,
        flow_logs,
    }))
}

async fn handle_patch_room(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(patch): Json<PatchRoomRequest>,
) -> Result<Json<Room>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    verify_room_access(&state, &principal, &room_id)?;
    let updated = state.coordinator.store.patch_room(&room_id, patch)?;
    state.coordinator.emit_room_event(ChatroomEvent::RoomUpdated {
        room_id: room_id.clone(),
        room: updated.clone(),
    });
    if updated.peek_enabled {
        state.coordinator.schedule_room_peek_if_ready(&room_id);
    }
    Ok(Json(updated))
}

async fn handle_delete_room(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Result<Json<serde_json::Value>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    verify_room_access(&state, &principal, &room_id)?;
    state
        .coordinator
        .delete_room_and_sessions(&room_id)
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

async fn handle_post_message(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(mut req): Json<PostMessageRequest>,
) -> Result<(StatusCode, Json<RoomMessage>), ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    verify_room_access(&state, &principal, &room_id)?;
    if req.sender_name.trim().is_empty()
        || (req.sender_name == "Human" && principal.display_name != "Human")
    {
        req.sender_name = principal.display_name;
    }
    let msg = state
        .coordinator
        .post_human_message(&room_id, req)
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(msg)))
}

async fn handle_resume_relay(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Result<Json<Room>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    verify_room_access(&state, &principal, &room_id)?;
    let updated = state.coordinator.store.reset_consecutive_agent_msgs(&room_id)?;
    state.coordinator.emit_room_event(ChatroomEvent::RoomUpdated {
        room_id: room_id.clone(),
        room: updated.clone(),
    });
    state.coordinator.schedule_room_peek_if_ready(&room_id);
    Ok(Json(updated))
}

async fn handle_room_stream(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    verify_room_access(&state, &principal, &room_id)?;
    let mut rx = state.coordinator.subscribe_room_events();
    let (tx, out_rx) = mpsc::unbounded_channel::<Result<SseEvent, Infallible>>();

    tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let ev_room_id = match &ev {
                ChatroomEvent::MessagePosted { room_id, .. }
                | ChatroomEvent::MessageWithdrawn { room_id, .. }
                | ChatroomEvent::AgentUpdated { room_id, .. }
                | ChatroomEvent::AgentRemoved { room_id, .. }
                | ChatroomEvent::RoomUpdated { room_id, .. }
                | ChatroomEvent::PermissionAlert { room_id, .. }
                | ChatroomEvent::PeekRoundStatus { room_id, .. }
                | ChatroomEvent::AgentActivity { room_id, .. } => room_id,
            };
            if ev_room_id != &room_id {
                continue;
            }
            if let Ok(json_str) = serde_json::to_string(&ev) {
                if tx.send(Ok(SseEvent::default().data(json_str))).is_err() {
                    break;
                }
            }
        }
    });

    let stream = futures::stream::unfold(out_rx, |mut r| async move {
        r.recv().await.map(|item| (item, r))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn handle_create_agent(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(req): Json<CreateAgentRequest>,
) -> Result<(StatusCode, Json<RoomAgentPublic>), ChatApiError> {
    verify_user_auth(&state, &headers)?;
    let agent = state
        .coordinator
        .create_agent_in_room(&room_id, req, "human")
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(agent.into())))
}

async fn handle_recruit_agent(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(req): Json<RecruitAgentRequest>,
) -> Result<(StatusCode, Json<RoomMessage>), ChatApiError> {
    verify_user_auth(&state, &headers)?;
    let msg = recruit_agents_via_manager(&state.coordinator, &room_id, &req.requirement, None)
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(msg)))
}

async fn handle_patch_agent(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path((room_id, agent_id)): Path<(String, String)>,
    Json(patch): Json<PatchAgentRequest>,
) -> Result<Json<RoomAgentPublic>, ChatApiError> {
    verify_user_auth(&state, &headers)?;
    let updated = state
        .coordinator
        .patch_agent_in_room(&room_id, &agent_id, patch)
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(state.coordinator.to_agent_public_hydrated(updated).await))
}

async fn handle_remove_agent(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path((room_id, agent_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ChatApiError> {
    verify_user_auth(&state, &headers)?;
    state
        .coordinator
        .remove_agent_from_room(&room_id, &agent_id)
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct InspectorQuery {
    session_id: Option<String>,
}

async fn handle_get_inspector(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Query(query): Query<InspectorQuery>,
) -> Result<Json<InspectorResponse>, ChatApiError> {
    verify_user_auth(&state, &headers)?;
    let agent = state
        .coordinator
        .store
        .get_agent(&agent_id)?
        .ok_or_else(|| ChatApiError::Http(StatusCode::NOT_FOUND, "agent not found".into()))?;

    let selected_session_id = query
        .session_id
        .filter(|s| !s.trim().is_empty())
        .map(SessionId::new)
        .unwrap_or_else(|| agent.active_session_id.clone());

    let session = state
        .coordinator
        .ragents_client
        .get_session(&selected_session_id)
        .await
        .ok()
        .flatten();
    let context = state
        .coordinator
        .ragents_client
        .get_session_context(&selected_session_id)
        .await
        .ok();
    let events = state
        .coordinator
        .ragents_client
        .read_events(Some(&selected_session_id), 0)
        .await
        .unwrap_or_default();

    let mut pending_permissions = Vec::new();
    if let Some(ref act_id) = agent.active_activation_id {
        if let Ok(Some(act)) = state.coordinator.ragents_client.get_activation(act_id).await {
            pending_permissions = act.status.pending_interactions;
        }
    }

    let can_edit_prompt = true;

    let message_queues = state
        .coordinator
        .build_agent_message_queues(&agent, &events);
    let agent_pub = state.coordinator.to_agent_public_hydrated(agent).await;

    Ok(Json(InspectorResponse {
        agent: agent_pub,
        selected_session_id,
        session,
        context,
        events,
        pending_permissions,
        can_edit_prompt,
        message_queues,
    }))
}

async fn handle_inspector_stream(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Query(query): Query<InspectorQuery>,
) -> Result<Sse<impl Stream<Item = Result<SseEvent, Infallible>>>, ChatApiError> {
    verify_user_auth(&state, &headers)?;
    let agent = state
        .coordinator
        .store
        .get_agent(&agent_id)?
        .ok_or_else(|| ChatApiError::Http(StatusCode::NOT_FOUND, "agent not found".into()))?;

    let follow_latest = query.session_id.is_none();
    let mut watched_session_id = query
        .session_id
        .filter(|s| !s.trim().is_empty())
        .map(SessionId::new)
        .unwrap_or_else(|| agent.active_session_id.clone());

    let mut rx = state.coordinator.subscribe_inspector_events();
    let (tx, out_rx) = mpsc::unbounded_channel::<Result<SseEvent, Infallible>>();

    tokio::spawn(async move {
        while let Ok(env) = rx.recv().await {
            if env.session_id != watched_session_id {
                continue;
            }
            if follow_latest {
                if let SessionEvent::SessionCompacted {
                    ref continued_session_id,
                    ..
                } = env.event
                {
                    watched_session_id = continued_session_id.clone();
                }
            }
            if let Ok(json_str) = serde_json::to_string(&env) {
                if tx.send(Ok(SseEvent::default().data(json_str))).is_err() {
                    break;
                }
            }
        }
    });

    let stream = futures::stream::unfold(out_rx, |mut r| async move {
        r.recv().await.map(|item| (item, r))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn handle_approve_permission(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(_agent_id): Path<String>,
    Json(req): Json<ApproveAgentPermissionRequest>,
) -> Result<Json<Activation>, ChatApiError> {
    let principal = verify_user_auth(&state, &headers)?;
    let decision_str = match req.decision {
        PermissionDecision::Deny => "deny",
        PermissionDecision::AllowOnce => "allow_once",
        PermissionDecision::AllowActivation => "allow_activation",
        PermissionDecision::AllowSession => "allow_session",
        PermissionDecision::AllowWorkspace => "allow_workspace",
        PermissionDecision::AllowNode => "allow_node",
    };
    if !principal.can_approve_decision(decision_str) {
        return Err(ChatApiError::Http(
            StatusCode::FORBIDDEN,
            format!(
                "当前用户权限不足：最高仅允许审批到 {} 范围",
                principal.max_approval_scope
            ),
        ));
    }
    let act = state
        .coordinator
        .ragents_client
        .respond_permission_with_path(
            &req.activation_id,
            req.request_id,
            req.decision,
            req.override_path.map(std::path::PathBuf::from),
        )
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(act))
}

async fn handle_cancel_agent_activation(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<Json<serde_json::Value>, ChatApiError> {
    verify_user_auth(&state, &headers)?;
    let agent = state
        .coordinator
        .store
        .get_agent(&agent_id)?
        .ok_or_else(|| ChatApiError::Http(StatusCode::NOT_FOUND, "agent not found".into()))?;

    if let Some(ref act_id) = agent.active_activation_id {
        let _ = state
            .coordinator
            .ragents_client
            .cancel_activation(act_id)
            .await;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn handle_withdraw_queued_message(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Path((agent_id, msg_seq)): Path<(String, u64)>,
) -> Result<Json<WithdrawQueuedMessageResponse>, ChatApiError> {
    verify_user_auth(&state, &headers)?;
    let resp = state
        .coordinator
        .withdraw_agent_queued_message(&agent_id, msg_seq)
        .await
        .map_err(|e| ChatApiError::Http(StatusCode::CONFLICT, e.to_string()))?;
    Ok(Json(resp))
}

async fn handle_internal_agent_speak(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Json(req): Json<InternalAgentSpeakRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ChatApiError> {
    let bearer = extract_bearer_or_cookie_token(&headers);
    let msg = state
        .coordinator
        .handle_internal_agent_speak(bearer.as_deref(), req)
        .await
        .map_err(|(code, err)| {
            ChatApiError::Http(
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
                err,
            )
        })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "msg_seq": msg.msg_seq,
            "message_id": msg.message_id,
        })),
    ))
}

async fn handle_internal_manager_add_agent(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Json(req): Json<InternalManagerAddAgentRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ChatApiError> {
    let bearer = extract_bearer_or_cookie_token(&headers);
    let created = state
        .coordinator
        .handle_internal_manager_add_agent(bearer.as_deref(), req)
        .await
        .map_err(|(code, err)| {
            ChatApiError::Http(
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
                err,
            )
        })?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "agent_id": created.agent_id,
            "name": created.name,
            "role_title": created.role_title,
            "model": created.model,
        })),
    ))
}

async fn handle_internal_manager_remove_agent(
    State(state): State<ChatServerState>,
    headers: HeaderMap,
    Json(req): Json<InternalManagerRemoveAgentRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ChatApiError> {
    let bearer = extract_bearer_or_cookie_token(&headers);
    let res = state
        .coordinator
        .handle_internal_manager_remove_agent(bearer.as_deref(), req)
        .await
        .map_err(|(code, err)| {
            ChatApiError::Http(
                StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
                err,
            )
        })?;
    Ok((StatusCode::OK, Json(res)))
}

pub enum ChatApiError {
    Store(crate::store::ChatStoreError),
    Http(StatusCode, String),
}

impl From<crate::store::ChatStoreError> for ChatApiError {
    fn from(v: crate::store::ChatStoreError) -> Self {
        Self::Store(v)
    }
}

impl IntoResponse for ChatApiError {
    fn into_response(self) -> Response {
        match self {
            Self::Store(err) => {
                let status = match &err {
                    crate::store::ChatStoreError::NotFound(_) => StatusCode::NOT_FOUND,
                    crate::store::ChatStoreError::Conflict(_) => StatusCode::CONFLICT,
                    _ => StatusCode::INTERNAL_SERVER_ERROR,
                };
                (status, Json(json!({ "error": err.to_string() }))).into_response()
            }
            Self::Http(status, msg) => (status, Json(json!({ "error": msg }))).into_response(),
        }
    }
}
