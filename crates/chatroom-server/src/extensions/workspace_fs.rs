use super::{ChatPrincipal, UiContribution};
use crate::coordinator::RoomCoordinator;
use axum::body::Bytes;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use ragents_protocol::{NodeFsOp, NodeFsRequest, NodeFsZone, NodeId, NodePhase, SchedulingMode};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

const WORKSPACE_FS_UI_JS: &str = include_str!("workspace_fs_ui.js");

#[derive(Debug, Deserialize)]
struct UploadTempFileRequest {
    filename: String,
    #[serde(default)]
    sub_dir: Option<String>,
    data_base64: String,
    #[serde(default)]
    dedupe: bool,
}

pub struct WorkspaceFsExtension {
    coordinator: RoomCoordinator,
}

impl WorkspaceFsExtension {
    pub fn new(coordinator: RoomCoordinator) -> Self {
        Self { coordinator }
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
        // otherwise pick the first Ready node in the cluster.
        if let Some(first_ag) = agents.first() {
            if let Ok(Some(sess)) = self
                .coordinator
                .ragents_client
                .get_session(&first_ag.active_session_id)
                .await
            {
                if let Some(bound_nid) = sess.status.bound_node_id {
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
            .find(|n| n.status.phase == NodePhase::Ready && principal.can_access_node(Some(n.metadata.id.as_str())))
            .ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "当前无在线且有权限访问的节点".to_string(),
                )
            })?;

        Ok((NodeId::new(chosen.metadata.id), eff_ws))
    }

    pub async fn handle_http(
        &self,
        method: Method,
        subpath: &str,
        query: &HashMap<String, String>,
        principal: Option<&ChatPrincipal>,
        body: Bytes,
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

        let Some(p) = principal else {
            return Err((StatusCode::UNAUTHORIZED, "Unauthorized".to_string()));
        };

        // Match /rooms/{room_id}/{action}
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
        let zone = match query.get("zone").map(|s| s.as_str()) {
            Some("tmp") => NodeFsZone::Tmp,
            _ => NodeFsZone::Workspace,
        };
        let rel_path = query.get("path").cloned().unwrap_or_default();

        match (method, action) {
            (Method::GET, "list") => {
                let fs_resp = self
                    .coordinator
                    .ragents_client
                    .node_fs_query(
                        &node_id,
                        &NodeFsRequest {
                            zone,
                            workspace_path,
                            op: NodeFsOp::ListDir { rel_path },
                        },
                    )
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
                Ok(Json(fs_resp).into_response())
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
                            op: NodeFsOp::ReadFile {
                                rel_path,
                                max_bytes: Some(2 * 1024 * 1024),
                            },
                        },
                    )
                    .await
                    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
                Ok(Json(fs_resp).into_response())
            }
            (Method::GET, "raw") => {
                let fs_resp = self
                    .coordinator
                    .ragents_client
                    .node_fs_query(
                        &node_id,
                        &NodeFsRequest {
                            zone,
                            workspace_path,
                            op: NodeFsOp::ReadFile {
                                rel_path: rel_path.clone(),
                                max_bytes: Some(50 * 1024 * 1024),
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
                let raw_bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let mime = fs_resp
                    .mime_type
                    .unwrap_or_else(|| "application/octet-stream".to_string());
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

                Ok((
                    [
                        (header::CONTENT_TYPE, mime),
                        (header::CONTENT_DISPOSITION, disposition),
                    ],
                    raw_bytes,
                )
                    .into_response())
            }
            (Method::POST, "upload") => {
                let req: UploadTempFileRequest = serde_json::from_slice(&body)
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
