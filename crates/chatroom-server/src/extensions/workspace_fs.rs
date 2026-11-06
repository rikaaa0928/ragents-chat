use super::{ChatPrincipal, UiContribution};
use crate::coordinator::RoomCoordinator;
use axum::body::Bytes;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use chrono::Utc;
use futures::StreamExt;
use ragents_protocol::{NodeFsOp, NodeFsRequest, NodeFsZone, NodeId, NodePhase, SchedulingMode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Notify;
use uuid::Uuid;

const WORKSPACE_FS_UI_JS: &str = include_str!("workspace_fs_ui.js");
const STAGE_TTL_SECS: i64 = 2 * 3600;
const DIRECT_READ_THRESHOLD_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct UploadTempFileRequest {
    filename: String,
    #[serde(default)]
    sub_dir: Option<String>,
    data_base64: String,
    #[serde(default)]
    dedupe: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StagePhase {
    Uploading,
    Ready,
    Failed,
}

pub struct StagedFileEntry {
    pub stage_id: String,
    pub cache_key: String,
    pub node_id: String,
    pub zone_str: String,
    pub rel_path: String,
    pub mime_type: Mutex<String>,
    pub total_bytes: AtomicU64,
    pub uploaded_bytes: AtomicU64,
    pub phase: Mutex<StagePhase>,
    pub error: Mutex<Option<String>>,
    pub upload_token: String,
    pub part_path: PathBuf,
    pub bin_path: PathBuf,
    pub expires_at_unix: AtomicU64,
    pub notify: Notify,
}

#[derive(Debug, Clone, Serialize)]
pub struct StagedFileStatusDto {
    pub ok: bool,
    pub stage_id: String,
    pub rel_path: String,
    pub phase: StagePhase,
    pub uploaded_bytes: u64,
    pub total_bytes: u64,
    pub expires_in_secs: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl StagedFileEntry {
    fn to_dto(&self, now_unix: i64) -> StagedFileStatusDto {
        let phase = self.phase.lock().unwrap().clone();
        let error = self.error.lock().unwrap().clone();
        let expires_at = self.expires_at_unix.load(Ordering::Relaxed) as i64;
        StagedFileStatusDto {
            ok: phase != StagePhase::Failed,
            stage_id: self.stage_id.clone(),
            rel_path: self.rel_path.clone(),
            phase,
            uploaded_bytes: self.uploaded_bytes.load(Ordering::Relaxed),
            total_bytes: self.total_bytes.load(Ordering::Relaxed),
            expires_in_secs: (expires_at - now_unix).max(0),
            error,
        }
    }
}

pub struct WorkspaceFsExtension {
    coordinator: RoomCoordinator,
    stage_dir: PathBuf,
    staged_by_id: Arc<Mutex<HashMap<String, Arc<StagedFileEntry>>>>,
    staged_by_key: Arc<Mutex<HashMap<String, Arc<StagedFileEntry>>>>,
}

impl WorkspaceFsExtension {
    pub fn new(coordinator: RoomCoordinator) -> Self {
        let stage_dir = std::env::temp_dir().join("ragents-chat-fs-stage");
        let _ = std::fs::create_dir_all(&stage_dir);
        let staged_by_id: Arc<Mutex<HashMap<String, Arc<StagedFileEntry>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let staged_by_key: Arc<Mutex<HashMap<String, Arc<StagedFileEntry>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let by_id_bg = staged_by_id.clone();
        let by_key_bg = staged_by_key.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
                loop {
                    interval.tick().await;
                    Self::purge_expired_maps(&by_id_bg, &by_key_bg);
                }
            });
        }

        Self {
            coordinator,
            stage_dir,
            staged_by_id,
            staged_by_key,
        }
    }

    fn purge_expired_maps(
        by_id: &Mutex<HashMap<String, Arc<StagedFileEntry>>>,
        by_key: &Mutex<HashMap<String, Arc<StagedFileEntry>>>,
    ) {
        let now = Utc::now().timestamp() as u64;
        let mut expired = Vec::new();
        {
            let mut map = by_id.lock().unwrap();
            map.retain(|_, entry| {
                let exp = entry.expires_at_unix.load(Ordering::Relaxed);
                if exp <= now {
                    expired.push(entry.clone());
                    false
                } else {
                    true
                }
            });
        }
        if !expired.is_empty() {
            let mut kmap = by_key.lock().unwrap();
            for entry in expired {
                if let Some(curr) = kmap.get(&entry.cache_key) {
                    if curr.stage_id == entry.stage_id {
                        kmap.remove(&entry.cache_key);
                    }
                }
                let _ = std::fs::remove_file(&entry.part_path);
                let _ = std::fs::remove_file(&entry.bin_path);
            }
        }
    }

    fn purge_expired(&self) {
        Self::purge_expired_maps(&self.staged_by_id, &self.staged_by_key);
    }

    fn make_cache_key(node_id: &NodeId, zone: NodeFsZone, rel_path: &str) -> (String, String) {
        let zone_str = match zone {
            NodeFsZone::Workspace => "workspace".to_string(),
            NodeFsZone::Tmp => "tmp".to_string(),
        };
        let clean = rel_path.trim().trim_start_matches('/');
        let key = format!("{}|{}|{}", node_id.as_str(), zone_str, clean);
        (key, zone_str)
    }

    fn find_valid_staged(
        &self,
        node_id: &NodeId,
        zone: NodeFsZone,
        rel_path: &str,
    ) -> Option<Arc<StagedFileEntry>> {
        self.purge_expired();
        let (key, _) = Self::make_cache_key(node_id, zone, rel_path);
        let entry = self.staged_by_key.lock().unwrap().get(&key).cloned()?;
        let phase = entry.phase.lock().unwrap().clone();
        match phase {
            StagePhase::Ready => {
                if entry.bin_path.is_file() {
                    Some(entry)
                } else {
                    None
                }
            }
            StagePhase::Uploading => Some(entry),
            StagePhase::Failed => None,
        }
    }

    async fn start_or_get_stage(
        &self,
        node_id: &NodeId,
        zone: NodeFsZone,
        workspace_path: Option<String>,
        tmp_dir_for_zone: Option<String>,
        rel_path: &str,
    ) -> Result<Arc<StagedFileEntry>, (StatusCode, String)> {
        if let Some(existing) = self.find_valid_staged(node_id, zone, rel_path) {
            return Ok(existing);
        }

        let clean_rel = rel_path.trim().trim_start_matches('/').to_string();
        let (cache_key, zone_str) = Self::make_cache_key(node_id, zone, &clean_rel);
        let stage_id = format!("stg_{}", Uuid::now_v7().simple());
        let upload_token = format!(
            "stgtok_{}{}",
            Uuid::now_v7().simple(),
            Uuid::new_v4().simple()
        );
        let part_path = self.stage_dir.join(format!("{stage_id}.part"));
        let bin_path = self.stage_dir.join(format!("{stage_id}.bin"));
        let expires_at = (Utc::now().timestamp() + STAGE_TTL_SECS) as u64;

        let upload_url = format!(
            "{}/api/v1/ext/workspace_fs/internal-stage/{stage_id}",
            self.coordinator.callback_base_url.trim_end_matches('/')
        );

        let entry = Arc::new(StagedFileEntry {
            stage_id: stage_id.clone(),
            cache_key: cache_key.clone(),
            node_id: node_id.as_str().to_string(),
            zone_str,
            rel_path: clean_rel.clone(),
            mime_type: Mutex::new("application/octet-stream".to_string()),
            total_bytes: AtomicU64::new(0),
            uploaded_bytes: AtomicU64::new(0),
            phase: Mutex::new(StagePhase::Uploading),
            error: Mutex::new(None),
            upload_token: upload_token.clone(),
            part_path,
            bin_path,
            expires_at_unix: AtomicU64::new(expires_at),
            notify: Notify::new(),
        });

        {
            self.staged_by_id
                .lock()
                .unwrap()
                .insert(stage_id.clone(), entry.clone());
            self.staged_by_key
                .lock()
                .unwrap()
                .insert(cache_key.clone(), entry.clone());
        }

        let fs_resp = match self
            .coordinator
            .ragents_client
            .node_fs_query(
                node_id,
                &NodeFsRequest {
                    zone,
                    workspace_path,
                    tmp_dir: tmp_dir_for_zone,
                    op: NodeFsOp::UploadFileToHttp {
                        rel_path: clean_rel.clone(),
                        upload_url,
                        upload_token: Some(upload_token),
                    },
                },
            )
            .await
        {
            Ok(r) if r.ok => r,
            Ok(r) => {
                self.staged_by_id.lock().unwrap().remove(&stage_id);
                self.staged_by_key.lock().unwrap().remove(&cache_key);
                return Err((
                    StatusCode::NOT_FOUND,
                    r.error.unwrap_or_else(|| "file not found".to_string()),
                ));
            }
            Err(e) => {
                self.staged_by_id.lock().unwrap().remove(&stage_id);
                self.staged_by_key.lock().unwrap().remove(&cache_key);
                return Err((StatusCode::BAD_GATEWAY, e.to_string()));
            }
        };

        let total_size = fs_resp.size.unwrap_or(0);
        let mime_type = fs_resp
            .mime_type
            .unwrap_or_else(|| "application/octet-stream".to_string());
        entry.total_bytes.store(total_size, Ordering::Relaxed);
        *entry.mime_type.lock().unwrap() = mime_type;

        Ok(entry)
    }

    async fn stream_local_file_response(
        file_path: PathBuf,
        mime: String,
        disposition: String,
    ) -> Result<Response, (StatusCode, String)> {
        let meta = tokio::fs::metadata(&file_path)
            .await
            .map_err(|e| (StatusCode::NOT_FOUND, format!("staged file missing: {e}")))?;
        let total_size = meta.len();
        let file = tokio::fs::File::open(&file_path)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let stream = futures::stream::unfold(file, |mut f| async move {
            let mut buf = vec![0u8; 128 * 1024];
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    Some((Ok::<Bytes, std::io::Error>(Bytes::from(buf)), f))
                }
                Err(e) => Some((Err(e), f)),
            }
        });

        Ok((
            [
                (header::CONTENT_TYPE, mime),
                (header::CONTENT_DISPOSITION, disposition),
                (header::CONTENT_LENGTH, total_size.to_string()),
            ],
            axum::body::Body::from_stream(stream),
        )
            .into_response())
    }

    pub fn ui_contributions(&self) -> Vec<UiContribution> {
        vec![
            UiContribution {
                plugin_id: "workspace_fs".to_string(),
                id: "workspace_fs.panel".to_string(),
                slot: "room.right_column".to_string(),
                title: "文件".to_string(),
                icon: "FolderOpen".to_string(),
                require_admin: false,
                entry_url: "/api/v1/ext/workspace_fs/ui.js".to_string(),
            },
            UiContribution {
                plugin_id: "workspace_fs".to_string(),
                id: "workspace_fs.composer_image".to_string(),
                slot: "composer.toolbar".to_string(),
                title: "图片/文件".to_string(),
                icon: "ImagePlus".to_string(),
                require_admin: false,
                entry_url: "/api/v1/ext/workspace_fs/ui.js".to_string(),
            },
        ]
    }

    async fn resolve_room_node_and_workspace(
        &self,
        room_id: &str,
        principal: &ChatPrincipal,
    ) -> Result<(NodeId, Option<String>), (StatusCode, String)> {
        let room = self
            .coordinator
            .store
            .get_room(room_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .ok_or_else(|| (StatusCode::NOT_FOUND, format!("房间 {room_id} 不存在")))?;

        let agents = self
            .coordinator
            .store
            .list_room_agents(room_id)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        if !principal.can_access_room(&room, &agents) {
            return Err((
                StatusCode::FORBIDDEN,
                "当前用户无权访问该聊天室绑定的节点或工作区目录".to_string(),
            ));
        }

        let pinned_pair = agents.iter().find_map(|a| match &a.scheduling {
            SchedulingMode::Pinned {
                node_id,
                workspace_path,
            } => Some((
                node_id.clone(),
                workspace_path.to_str().map(|s| s.to_string()),
            )),
            _ => None,
        });

        let eff_ws = room
            .workspace_path
            .clone()
            .or_else(|| pinned_pair.as_ref().and_then(|(_, w)| w.clone()));

        if let Some(nid_str) = room
            .node_id
            .clone()
            .or_else(|| pinned_pair.map(|(n, _)| n.to_string()))
        {
            return Ok((NodeId::new(nid_str), eff_ws));
        }

        // Floating room: check if the primary agent's session is already bound to a node,
        // otherwise pick the first Ready node in the cluster and solidify the binding.
        if let Some(first_ag) = agents.first() {
            if let Ok(Some(sess)) = self
                .coordinator
                .ragents_client
                .get_session(&first_ag.active_session_id)
                .await
            {
                if let Some(bound_nid) = sess.status.bound_node_id {
                    let _ = self
                        .coordinator
                        .sync_floating_room_node(room_id, bound_nid.as_str(), None)
                        .await;
                    return Ok((bound_nid, eff_ws));
                }
            }
        }

        let nodes = self
            .coordinator
            .ragents_client
            .list_nodes()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
        let chosen = nodes
            .into_iter()
            .find(|n| {
                n.status.phase == NodePhase::Ready
                    && principal.can_access_node(Some(n.metadata.id.as_str()))
            })
            .ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "当前无在线且有权限访问的节点".to_string(),
                )
            })?;

        let chosen_nid = NodeId::new(chosen.metadata.id);
        let _ = self
            .coordinator
            .sync_floating_room_node(room_id, chosen_nid.as_str(), None)
            .await;

        Ok((chosen_nid, eff_ws))
    }

    pub async fn handle_http(
        &self,
        method: Method,
        subpath: &str,
        query: &HashMap<String, String>,
        headers: &HeaderMap,
        principal: Option<&ChatPrincipal>,
        body: axum::body::Body,
    ) -> Result<Response, (StatusCode, String)> {
        let path = subpath.trim_start_matches('/');
        if method == Method::GET && path == "ui.js" {
            return Ok((
                [(
                    header::CONTENT_TYPE,
                    "application/javascript; charset=utf-8",
                )],
                WORKSPACE_FS_UI_JS,
            )
                .into_response());
        }

        // Internal Node -> Server raw binary stage upload endpoint: PUT/POST /internal-stage/{stage_id}
        if let Some(stage_id) = path.strip_prefix("internal-stage/") {
            let entry = self
                .staged_by_id
                .lock()
                .unwrap()
                .get(stage_id)
                .cloned()
                .ok_or_else(|| (StatusCode::NOT_FOUND, "stage_id not found".to_string()))?;

            let provided_tok = headers
                .get("x-upload-token")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default();
            if provided_tok != entry.upload_token {
                return Err((StatusCode::FORBIDDEN, "invalid upload token".to_string()));
            }

            if method == Method::POST {
                if query.get("failed").map(|s| s == "1").unwrap_or(false) {
                    *entry.phase.lock().unwrap() = StagePhase::Failed;
                    *entry.error.lock().unwrap() =
                        Some("节点分块上传文件到服务器缓存失败".to_string());
                    entry.notify.notify_waiters();
                    let _ = tokio::fs::remove_file(&entry.part_path).await;
                    return Ok(Json(json!({ "ok": false, "stage_id": stage_id })).into_response());
                }
                if query.get("complete").map(|s| s == "1").unwrap_or(false) {
                    if let Err(e) = tokio::fs::rename(&entry.part_path, &entry.bin_path).await {
                        *entry.phase.lock().unwrap() = StagePhase::Failed;
                        *entry.error.lock().unwrap() = Some(e.to_string());
                        entry.notify.notify_waiters();
                        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
                    }
                    let new_exp = (Utc::now().timestamp() + STAGE_TTL_SECS) as u64;
                    entry.expires_at_unix.store(new_exp, Ordering::Relaxed);
                    *entry.phase.lock().unwrap() = StagePhase::Ready;
                    entry.notify.notify_waiters();
                    return Ok(Json(json!({ "ok": true, "stage_id": stage_id })).into_response());
                }
            }

            if method == Method::PUT {
                let offset_opt = query.get("offset").and_then(|s| s.parse::<u64>().ok());
                let mut file = match tokio::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .open(&entry.part_path)
                    .await
                {
                    Ok(f) => f,
                    Err(e) => {
                        *entry.phase.lock().unwrap() = StagePhase::Failed;
                        *entry.error.lock().unwrap() = Some(e.to_string());
                        entry.notify.notify_waiters();
                        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
                    }
                };

                if let Some(off) = offset_opt {
                    if let Err(e) = file.seek(std::io::SeekFrom::Start(off)).await {
                        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
                    }
                }

                let mut stream = body.into_data_stream();
                while let Some(chunk_res) = stream.next().await {
                    match chunk_res {
                        Ok(chunk) => {
                            if let Err(e) = file.write_all(&chunk).await {
                                return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
                            }
                            entry
                                .uploaded_bytes
                                .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                        }
                        Err(e) => {
                            return Err((StatusCode::BAD_REQUEST, e.to_string()));
                        }
                    }
                }

                let _ = file.flush().await;
                drop(file);

                // Single-shot PUT (without ?offset=...) finalizes immediately
                if offset_opt.is_none() {
                    if let Err(e) = tokio::fs::rename(&entry.part_path, &entry.bin_path).await {
                        *entry.phase.lock().unwrap() = StagePhase::Failed;
                        *entry.error.lock().unwrap() = Some(e.to_string());
                        entry.notify.notify_waiters();
                        return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
                    }
                    let new_exp = (Utc::now().timestamp() + STAGE_TTL_SECS) as u64;
                    entry.expires_at_unix.store(new_exp, Ordering::Relaxed);
                    *entry.phase.lock().unwrap() = StagePhase::Ready;
                    entry.notify.notify_waiters();
                }

                return Ok(Json(json!({ "ok": true, "stage_id": stage_id })).into_response());
            }
        }

        let Some(p) = principal else {
            return Err((StatusCode::UNAUTHORIZED, "Unauthorized".to_string()));
        };

        let Some(rest) = path.strip_prefix("rooms/") else {
            return Err((
                StatusCode::NOT_FOUND,
                format!("unknown workspace_fs path: /{path}"),
            ));
        };
        let Some((room_id, action)) = rest.split_once('/') else {
            return Err((
                StatusCode::NOT_FOUND,
                format!("invalid workspace_fs room path: /{path}"),
            ));
        };

        let (node_id, workspace_path) = self.resolve_room_node_and_workspace(room_id, p).await?;
        let room_tmp_dir = RoomCoordinator::room_tmp_dir(room_id);
        let zone = if workspace_path.is_none() {
            NodeFsZone::Tmp
        } else {
            match query.get("zone").map(|s| s.as_str()) {
                Some("tmp") => NodeFsZone::Tmp,
                _ => NodeFsZone::Workspace,
            }
        };
        let tmp_dir_for_zone = if zone == NodeFsZone::Tmp {
            Some(room_tmp_dir.clone())
        } else {
            None
        };
        let rel_path = query.get("path").cloned().unwrap_or_default();

        match (method, action) {
            (Method::GET, "list") => {
                self.purge_expired();
                let fs_resp = self
                    .coordinator
                    .ragents_client
                    .node_fs_query(
                        &node_id,
                        &NodeFsRequest {
                            zone,
                            workspace_path,
                            tmp_dir: tmp_dir_for_zone,
                            op: NodeFsOp::ListDir { rel_path },
                        },
                    )
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

                let now_unix = Utc::now().timestamp();
                let zone_str = match zone {
                    NodeFsZone::Workspace => "workspace",
                    NodeFsZone::Tmp => "tmp",
                };
                let mut staged_files = HashMap::new();
                {
                    let kmap = self.staged_by_key.lock().unwrap();
                    for entry in kmap.values() {
                        if entry.node_id == node_id.as_str() && entry.zone_str == zone_str {
                            let dto = entry.to_dto(now_unix);
                            if dto.phase == StagePhase::Uploading
                                || (dto.phase == StagePhase::Ready && entry.bin_path.is_file())
                            {
                                staged_files.insert(entry.rel_path.clone(), dto);
                            }
                        }
                    }
                }

                let mut val = serde_json::to_value(&fs_resp)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                if let Some(obj) = val.as_object_mut() {
                    obj.insert(
                        "staged_files".to_string(),
                        serde_json::to_value(staged_files).unwrap_or_else(|_| json!({})),
                    );
                }
                Ok(Json(val).into_response())
            }
            (Method::POST, "stage") => {
                let entry = self
                    .start_or_get_stage(&node_id, zone, workspace_path, tmp_dir_for_zone, &rel_path)
                    .await?;
                let dto = entry.to_dto(Utc::now().timestamp());
                Ok(Json(dto).into_response())
            }
            (Method::GET, "stage-status") => {
                self.purge_expired();
                let now_unix = Utc::now().timestamp();
                if let Some(stage_id) = query.get("stage_id") {
                    if let Some(entry) = self.staged_by_id.lock().unwrap().get(stage_id).cloned() {
                        return Ok(Json(entry.to_dto(now_unix)).into_response());
                    }
                }
                if let Some(entry) = self.find_valid_staged(&node_id, zone, &rel_path) {
                    return Ok(Json(entry.to_dto(now_unix)).into_response());
                }
                Err((
                    StatusCode::NOT_FOUND,
                    "预载任务不存在或已过期".to_string(),
                ))
            }
            (Method::GET, "read") => {
                let fs_resp = self
                    .coordinator
                    .ragents_client
                    .node_fs_query(
                        &node_id,
                        &NodeFsRequest {
                            zone,
                            workspace_path,
                            tmp_dir: tmp_dir_for_zone,
                            op: NodeFsOp::ReadFile {
                                rel_path,
                                offset: None,
                                max_bytes: Some(DIRECT_READ_THRESHOLD_BYTES),
                            },
                        },
                    )
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
                Ok(Json(fs_resp).into_response())
            }
            (Method::GET, "raw") => {
                let filename = rel_path
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("file")
                    .replace('"', "");
                let is_download = query.get("download").map(|s| s == "1").unwrap_or(false);
                let disposition = if is_download {
                    format!("attachment; filename=\"{filename}\"")
                } else {
                    format!("inline; filename=\"{filename}\"")
                };

                // 1. If already staged on local server disk, serve directly from local SSD at full speed!
                if let Some(staged) = self.find_valid_staged(&node_id, zone, &rel_path) {
                    if *staged.phase.lock().unwrap() == StagePhase::Ready {
                        let staged_mime = staged.mime_type.lock().unwrap().clone();
                        return Self::stream_local_file_response(
                            staged.bin_path.clone(),
                            staged_mime,
                            disposition,
                        )
                        .await;
                    }
                }

                // 2. Probe first 2MB chunk; if file <= 2MB, return immediately without staging
                let fs_resp = self
                    .coordinator
                    .ragents_client
                    .node_fs_query(
                        &node_id,
                        &NodeFsRequest {
                            zone,
                            workspace_path: workspace_path.clone(),
                            tmp_dir: tmp_dir_for_zone.clone(),
                            op: NodeFsOp::ReadFile {
                                rel_path: rel_path.clone(),
                                offset: Some(0),
                                max_bytes: Some(DIRECT_READ_THRESHOLD_BYTES),
                            },
                        },
                    )
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

                if !fs_resp.ok {
                    return Err((
                        StatusCode::NOT_FOUND,
                        fs_resp.error.unwrap_or_else(|| "file not found".to_string()),
                    ));
                }

                let b64 = fs_resp.data_base64.unwrap_or_default();
                let first_bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let total_size = fs_resp.size.unwrap_or(first_bytes.len() as u64);
                let mime = fs_resp
                    .mime_type
                    .unwrap_or_else(|| "application/octet-stream".to_string());

                if (first_bytes.len() as u64) >= total_size {
                    return Ok((
                        [
                            (header::CONTENT_TYPE, mime),
                            (header::CONTENT_DISPOSITION, disposition),
                            (header::CONTENT_LENGTH, first_bytes.len().to_string()),
                        ],
                        first_bytes,
                    )
                        .into_response());
                }

                // 3. Large file (> 2MB): stage to server local disk via raw binary HTTP PUT, then stream from disk
                let entry = self
                    .start_or_get_stage(&node_id, zone, workspace_path, tmp_dir_for_zone, &rel_path)
                    .await?;
                let deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_secs(600);
                loop {
                    let phase = entry.phase.lock().unwrap().clone();
                    match phase {
                        StagePhase::Ready => {
                            return Self::stream_local_file_response(
                                entry.bin_path.clone(),
                                mime,
                                disposition,
                            )
                            .await;
                        }
                        StagePhase::Failed => {
                            let err = entry
                                .error
                                .lock()
                                .unwrap()
                                .clone()
                                .unwrap_or_else(|| "文件预载到服务器失败".to_string());
                            return Err((StatusCode::BAD_GATEWAY, err));
                        }
                        StagePhase::Uploading => {
                            if tokio::time::Instant::now() >= deadline {
                                return Err((
                                    StatusCode::GATEWAY_TIMEOUT,
                                    "大文件预载上传超时，请先在文件面板点击「☁️ 预载下载」".to_string(),
                                ));
                            }
                            let _ = tokio::time::timeout(
                                std::time::Duration::from_millis(300),
                                entry.notify.notified(),
                            )
                            .await;
                        }
                    }
                }
            }
            (Method::POST, "upload") => {
                let bytes = axum::body::to_bytes(body, 64 * 1024 * 1024)
                    .await
                    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
                let req: UploadTempFileRequest = serde_json::from_slice(&bytes)
                    .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?;
                let clean_name: String = req
                    .filename
                    .trim()
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or("upload.bin")
                    .chars()
                    .map(|c| {
                        if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
                let clean_name = if clean_name.is_empty() || clean_name == "." || clean_name == ".."
                {
                    "upload.bin".to_string()
                } else {
                    clean_name
                };

                let final_name = if req.dedupe {
                    let short_id = &Uuid::now_v7().simple().to_string()[24..];
                    if let Some((stem, ext)) = clean_name.rsplit_once('.') {
                        format!("{stem}_{short_id}.{ext}")
                    } else {
                        format!("{clean_name}_{short_id}")
                    }
                } else {
                    clean_name
                };

                let sub_dir = req
                    .sub_dir
                    .as_deref()
                    .map(|s| s.trim().trim_matches('/'))
                    .filter(|s| !s.is_empty())
                    .unwrap_or("uploads");
                let target_rel_path = format!("{sub_dir}/{final_name}");

                let fs_resp = self
                    .coordinator
                    .ragents_client
                    .node_fs_query(
                        &node_id,
                        &NodeFsRequest {
                            zone: NodeFsZone::Tmp,
                            workspace_path,
                            tmp_dir: Some(room_tmp_dir),
                            op: NodeFsOp::WriteTempFile {
                                rel_path: target_rel_path.clone(),
                                data_base64: req.data_base64,
                            },
                        },
                    )
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;

                if !fs_resp.ok {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        fs_resp
                            .error
                            .unwrap_or_else(|| "上传文件到节点临时目录失败".to_string()),
                    ));
                }

                let mime = fs_resp.mime_type.clone().unwrap_or_default();
                let is_image = mime.starts_with("image/");
                let raw_url = format!(
                    "/api/v1/ext/workspace_fs/rooms/{room_id}/raw?zone=tmp&path={}",
                    fs_resp.resolved_rel_path
                );

                Ok(Json(json!({
                    "ok": true,
                    "filename": final_name,
                    "rel_path": fs_resp.resolved_rel_path,
                    "agent_path": fs_resp.agent_path,
                    "raw_url": raw_url,
                    "size": fs_resp.size,
                    "mime_type": mime,
                    "is_image": is_image,
                }))
                .into_response())
            }
            _ => Err((
                StatusCode::NOT_FOUND,
                format!("unknown workspace_fs room action: /{action}"),
            )),
        }
    }
}
