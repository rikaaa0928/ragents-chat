use super::{ChatPrincipal, UiContribution};
use crate::coordinator::{constant_time_eq, RoomCoordinator};
use crate::store::{ChatStoreError, ChatroomStore};
use axum::body::Bytes;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

const TOKEN_ACL_UI_JS: &str = include_str!("token_acl_ui.js");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclUserRecord {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub token: String,
    pub is_admin: bool,
    pub allowed_nodes: Option<Vec<String>>,
    #[serde(default)]
    pub node_workspace_prefixes: BTreeMap<String, Vec<String>>,
    pub max_approval_scope: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<AclUserRecord> for ChatPrincipal {
    fn from(r: AclUserRecord) -> Self {
        Self {
            user_id: r.user_id,
            username: r.username,
            display_name: r.display_name,
            is_admin: r.is_admin,
            allowed_nodes: r.allowed_nodes,
            node_workspace_prefixes: r.node_workspace_prefixes,
            max_approval_scope: r.max_approval_scope,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct UpsertUserRequest {
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub token: Option<String>,
    pub is_admin: Option<bool>,
    pub allowed_nodes: Option<Vec<String>>,
    pub node_workspace_prefixes: Option<BTreeMap<String, Vec<String>>>,
    pub max_approval_scope: Option<String>,
}

pub struct TokenAclExtension {
    store: ChatroomStore,
}

impl TokenAclExtension {
    pub fn new(store: ChatroomStore, admin_token: &str) -> Self {
        let ext = Self { store };
        let _ = ext.ensure_admin_bootstrapped(admin_token);
        ext
    }

    fn ensure_admin_bootstrapped(&self, admin_token: &str) -> Result<(), ChatStoreError> {
        let now = Utc::now().to_rfc3339();
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT INTO chat_users_acl (
                    user_id, username, display_name, token, is_admin,
                    allowed_nodes_json, node_workspaces_json, max_approval_scope, created_at, updated_at
                ) VALUES ('admin', 'admin', 'Admin', ?1, 1, NULL, '{}', 'node', ?2, ?2)
                ON CONFLICT(user_id) DO UPDATE SET
                    token = excluded.token,
                    is_admin = 1,
                    updated_at = excluded.updated_at",
                params![admin_token, now],
            )?;
            Ok(())
        })
    }

    pub fn authenticate_token(&self, candidate: &str) -> Option<ChatPrincipal> {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            return None;
        }
        let users = self.list_users().ok()?;
        for user in users {
            if constant_time_eq(trimmed, &user.token) {
                return Some(user.into());
            }
        }
        None
    }

    pub fn list_users(&self) -> Result<Vec<AclUserRecord>, ChatStoreError> {
        self.store.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT user_id, username, display_name, token, is_admin,
                        allowed_nodes_json, node_workspaces_json, max_approval_scope, created_at, updated_at
                 FROM chat_users_acl ORDER BY is_admin DESC, created_at ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                let allowed_json: Option<String> = row.get(5)?;
                let ws_json: String = row.get(6)?;
                let allowed_nodes: Option<Vec<String>> = match allowed_json {
                    Some(s) if !s.trim().is_empty() => serde_json::from_str(&s).ok(),
                    _ => None,
                };
                let node_workspace_prefixes: BTreeMap<String, Vec<String>> =
                    serde_json::from_str(&ws_json).unwrap_or_default();
                Ok(AclUserRecord {
                    user_id: row.get(0)?,
                    username: row.get(1)?,
                    display_name: row.get(2)?,
                    token: row.get(3)?,
                    is_admin: row.get::<_, i64>(4)? != 0,
                    allowed_nodes,
                    node_workspace_prefixes,
                    max_approval_scope: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?;
            let mut list = Vec::new();
            for r in rows {
                list.push(r?);
            }
            Ok(list)
        })
    }

    pub fn create_user(&self, req: UpsertUserRequest) -> Result<AclUserRecord, String> {
        let username = req
            .username
            .unwrap_or_default()
            .trim()
            .to_string();
        if username.is_empty() {
            return Err("用户名 (username) 不能为空".to_string());
        }
        let display_name = req
            .display_name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| username.clone());
        let token = req
            .token
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("rct_{}", Uuid::now_v7().simple()));
        let is_admin = req.is_admin.unwrap_or(false);
        let allowed_nodes = req.allowed_nodes;
        let node_workspace_prefixes = req.node_workspace_prefixes.unwrap_or_default();
        let max_approval_scope = req
            .max_approval_scope
            .unwrap_or_else(|| "session".to_string());

        let user_id = format!("usr_{}", Uuid::now_v7().simple());
        let now = Utc::now().to_rfc3339();
        let allowed_json = match &allowed_nodes {
            Some(list) => Some(serde_json::to_string(list).map_err(|e| e.to_string())?),
            None => None,
        };
        let ws_json =
            serde_json::to_string(&node_workspace_prefixes).map_err(|e| e.to_string())?;

        self.store
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO chat_users_acl (
                        user_id, username, display_name, token, is_admin,
                        allowed_nodes_json, node_workspaces_json, max_approval_scope, created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    params![
                        user_id,
                        username,
                        display_name,
                        token,
                        i64::from(is_admin),
                        allowed_json,
                        ws_json,
                        max_approval_scope,
                        now,
                    ],
                )?;
                Ok(())
            })
            .map_err(|e| format!("创建用户失败 (可能用户名或 Token 已存在): {e}"))?;

        Ok(AclUserRecord {
            user_id,
            username,
            display_name,
            token,
            is_admin,
            allowed_nodes,
            node_workspace_prefixes,
            max_approval_scope,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn update_user(
        &self,
        user_id: &str,
        req: UpsertUserRequest,
    ) -> Result<AclUserRecord, String> {
        let existing = self
            .list_users()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|u| u.user_id == user_id)
            .ok_or_else(|| format!("用户 '{user_id}' 不存在"))?;

        let username = if user_id == "admin" {
            "admin".to_string()
        } else {
            req.username
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(existing.username)
        };
        let display_name = req
            .display_name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(existing.display_name);
        let token = req
            .token
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(existing.token);
        let is_admin = if user_id == "admin" {
            true
        } else {
            req.is_admin.unwrap_or(existing.is_admin)
        };
        let allowed_nodes = req.allowed_nodes;
        let node_workspace_prefixes = req
            .node_workspace_prefixes
            .unwrap_or(existing.node_workspace_prefixes);
        let max_approval_scope = req
            .max_approval_scope
            .unwrap_or(existing.max_approval_scope);
        let now = Utc::now().to_rfc3339();

        let allowed_json = match &allowed_nodes {
            Some(list) => Some(serde_json::to_string(list).map_err(|e| e.to_string())?),
            None => None,
        };
        let ws_json =
            serde_json::to_string(&node_workspace_prefixes).map_err(|e| e.to_string())?;

        self.store
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE chat_users_acl SET
                        username = ?1,
                        display_name = ?2,
                        token = ?3,
                        is_admin = ?4,
                        allowed_nodes_json = ?5,
                        node_workspaces_json = ?6,
                        max_approval_scope = ?7,
                        updated_at = ?8
                     WHERE user_id = ?9",
                    params![
                        username,
                        display_name,
                        token,
                        i64::from(is_admin),
                        allowed_json,
                        ws_json,
                        max_approval_scope,
                        now,
                        user_id,
                    ],
                )?;
                Ok(())
            })
            .map_err(|e| format!("更新用户失败: {e}"))?;

        Ok(AclUserRecord {
            user_id: user_id.to_string(),
            username,
            display_name,
            token,
            is_admin,
            allowed_nodes,
            node_workspace_prefixes,
            max_approval_scope,
            created_at: existing.created_at,
            updated_at: now,
        })
    }

    pub fn delete_user(&self, user_id: &str) -> Result<(), String> {
        if user_id == "admin" {
            return Err("初始管理员账号 admin 不可删除".to_string());
        }
        self.store
            .with_conn(|conn| {
                let _ = conn.execute(
                    "DELETE FROM chat_users_acl WHERE user_id = ?1",
                    params![user_id],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())
    }

    pub fn ui_contributions(&self) -> Vec<UiContribution> {
        vec![
            UiContribution {
                plugin_id: "token_acl".to_string(),
                id: "token_acl.login".to_string(),
                slot: "auth.login".to_string(),
                title: "Token 访问认证".to_string(),
                icon: "KeyRound".to_string(),
                require_admin: false,
                entry_url: "/api/v1/ext/token_acl/ui.js".to_string(),
            },
            UiContribution {
                plugin_id: "token_acl".to_string(),
                id: "token_acl.admin".to_string(),
                slot: "sidebar.footer".to_string(),
                title: "用户与权限".to_string(),
                icon: "KeyRound".to_string(),
                require_admin: true,
                entry_url: "/api/v1/ext/token_acl/ui.js".to_string(),
            },
        ]
    }

    pub async fn handle_http(
        &self,
        coordinator: &RoomCoordinator,
        method: Method,
        subpath: &str,
        _query: &HashMap<String, String>,
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
                TOKEN_ACL_UI_JS,
            )
                .into_response());
        }

        let Some(p) = principal else {
            return Err((StatusCode::UNAUTHORIZED, "Unauthorized".to_string()));
        };

        if method == Method::GET && path == "me" {
            return Ok(Json(p.clone()).into_response());
        }

        if !p.is_admin {
            return Err((
                StatusCode::FORBIDDEN,
                "需要管理员 (admin) 权限才能管理用户与 Token".to_string(),
            ));
        }

        if method == Method::GET && path == "users" {
            let users = self
                .list_users()
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            let cluster_nodes = coordinator
                .ragents_client
                .list_nodes()
                .await
                .unwrap_or_default();
            return Ok(Json(json!({
                "users": users,
                "cluster_nodes": cluster_nodes,
            }))
            .into_response());
        }

        if method == Method::POST && path == "users" {
            let req: UpsertUserRequest = serde_json::from_slice(&body)
                .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?;
            let created = self
                .create_user(req)
                .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
            return Ok((StatusCode::CREATED, Json(created)).into_response());
        }

        if let Some(uid) = path.strip_prefix("users/") {
            let uid = uid.trim();
            if method == Method::PATCH {
                let req: UpsertUserRequest = serde_json::from_slice(&body)
                    .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?;
                let updated = self
                    .update_user(uid, req)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
                return Ok(Json(updated).into_response());
            }
            if method == Method::DELETE {
                self.delete_user(uid)
                    .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
                return Ok(Json(json!({ "ok": true })).into_response());
            }
        }

        Err((
            StatusCode::NOT_FOUND,
            format!("token_acl endpoint not found: {method} /{path}"),
        ))
    }
}
