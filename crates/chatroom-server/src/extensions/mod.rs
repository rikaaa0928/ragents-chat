pub mod token_acl;
pub mod workspace_fs;

use crate::coordinator::RoomCoordinator;
use crate::types::{Room, RoomAgent};
use axum::body::Bytes;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use token_acl::TokenAclExtension;
use workspace_fs::WorkspaceFsExtension;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPrincipal {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub is_admin: bool,
    /// `None` = unrestricted; `Some(vec)` = allowed node IDs (plus `"__floating__"` if floating rooms are allowed)
    pub allowed_nodes: Option<Vec<String>>,
    /// Per-node allowed workspace directory prefixes (`node_id -> Vec<prefix>`)
    #[serde(default)]
    pub node_workspace_prefixes: BTreeMap<String, Vec<String>>,
    /// `"once" | "session" | "workspace" | "node"`
    pub max_approval_scope: String,
}

impl ChatPrincipal {
    pub fn anonymous_admin() -> Self {
        Self {
            user_id: "admin".to_string(),
            username: "admin".to_string(),
            display_name: "Human".to_string(),
            is_admin: true,
            allowed_nodes: None,
            node_workspace_prefixes: BTreeMap::new(),
            max_approval_scope: "node".to_string(),
        }
    }

    pub fn can_access_node(&self, node_id: Option<&str>) -> bool {
        if self.is_admin {
            return true;
        }
        let Some(ref allowed) = self.allowed_nodes else {
            return true;
        };
        let target = node_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("__floating__");
        allowed.iter().any(|n| n == target || n == "*")
    }

    pub fn can_access_workspace(
        &self,
        node_id: Option<&str>,
        workspace_path: Option<&str>,
    ) -> bool {
        if !self.can_access_node(node_id) {
            return false;
        }
        if self.is_admin {
            return true;
        }
        let Some(nid) = node_id.map(str::trim).filter(|s| !s.is_empty()) else {
            return true;
        };
        let Some(prefixes) = self.node_workspace_prefixes.get(nid) else {
            return true;
        };
        if prefixes.is_empty() {
            return true;
        }
        let ws = workspace_path
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("/tmp");
        let norm_ws = ws.trim_end_matches('/');
        prefixes.iter().any(|pref| {
            let norm_p = pref.trim().trim_end_matches('/');
            norm_p.is_empty()
                || norm_p == "*"
                || norm_ws == norm_p
                || norm_ws.starts_with(&format!("{norm_p}/"))
        })
    }

    pub fn can_access_room(&self, room: &Room, agents: &[RoomAgent]) -> bool {
        if self.is_admin {
            return true;
        }
        let pinned_agent = agents.iter().find_map(|a| match &a.scheduling {
            ragents_protocol::SchedulingMode::Pinned {
                node_id,
                workspace_path,
            } => Some((
                node_id.as_str(),
                workspace_path.to_str().unwrap_or_default(),
            )),
            _ => None,
        });
        let eff_node = room
            .node_id
            .as_deref()
            .or_else(|| pinned_agent.map(|(n, _)| n));
        let eff_ws = room
            .workspace_path
            .as_deref()
            .or_else(|| pinned_agent.map(|(_, w)| w));
        self.can_access_workspace(eff_node, eff_ws)
    }

    pub fn can_approve_decision(&self, decision: &str) -> bool {
        if self.is_admin {
            return true;
        }
        let rank = |scope: &str| -> u8 {
            match scope {
                "deny" | "once" | "allow_once" => 1,
                "session" | "allow_session" => 2,
                "workspace" | "allow_workspace" => 3,
                "node" | "allow_node" => 4,
                _ => 1,
            }
        };
        rank(decision) <= rank(&self.max_approval_scope)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiContribution {
    pub plugin_id: String,
    pub id: String,
    /// `"auth.login" | "sidebar.footer" | "room.right_column" | "composer.toolbar"`
    pub slot: String,
    pub title: String,
    pub icon: String,
    pub require_admin: bool,
    pub entry_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifestResponse {
    pub auth_required: bool,
    pub auth_mode: String,
    pub auth_plugin_id: Option<String>,
    pub contributions: Vec<UiContribution>,
}

#[derive(Clone)]
pub struct ChatExtensionHost {
    pub coordinator: RoomCoordinator,
    pub auth_required: bool,
    pub token_acl: Arc<TokenAclExtension>,
    pub workspace_fs: Arc<WorkspaceFsExtension>,
}

impl ChatExtensionHost {
    pub fn new(coordinator: RoomCoordinator, admin_token: Option<String>) -> Self {
        let trimmed_tok = admin_token
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let auth_required = trimmed_tok.is_some();
        let seed_token = trimmed_tok.unwrap_or_else(|| "admin".to_string());
        let token_acl = Arc::new(TokenAclExtension::new(
            coordinator.store.clone(),
            &seed_token,
        ));
        let workspace_fs = Arc::new(WorkspaceFsExtension::new(coordinator.clone()));
        Self {
            coordinator,
            auth_required,
            token_acl,
            workspace_fs,
        }
    }

    pub fn authenticate_token(&self, candidate: Option<&str>) -> Option<ChatPrincipal> {
        if !self.auth_required {
            if let Some(tok) = candidate.filter(|s| !s.is_empty()) {
                if let Some(p) = self.token_acl.authenticate_token(tok) {
                    return Some(p);
                }
            }
            return Some(ChatPrincipal::anonymous_admin());
        }
        let tok = candidate.filter(|s| !s.is_empty())?;
        self.token_acl.authenticate_token(tok)
    }

    pub fn manifest(&self) -> ExtensionManifestResponse {
        let mut contributions = Vec::new();
        contributions.extend(self.token_acl.ui_contributions());
        contributions.extend(self.workspace_fs.ui_contributions());
        ExtensionManifestResponse {
            auth_required: self.auth_required,
            auth_mode: if self.auth_required {
                "token".to_string()
            } else {
                "none".to_string()
            },
            auth_plugin_id: Some("token_acl".to_string()),
            contributions,
        }
    }

    pub async fn dispatch_http(
        &self,
        plugin_id: &str,
        method: Method,
        subpath: &str,
        query: &HashMap<String, String>,
        principal: Option<&ChatPrincipal>,
        body: Bytes,
    ) -> Result<Response, (StatusCode, String)> {
        match plugin_id {
            "token_acl" => {
                self.token_acl
                    .handle_http(
                        &self.coordinator,
                        method,
                        subpath,
                        query,
                        principal,
                        body,
                    )
                    .await
            }
            "workspace_fs" => {
                self.workspace_fs
                    .handle_http(method, subpath, query, principal, body)
                    .await
            }
            other => Err((
                StatusCode::NOT_FOUND,
                format!("extension '{other}' not found"),
            )),
        }
    }
}
