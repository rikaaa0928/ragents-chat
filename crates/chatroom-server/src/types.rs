use crate::schedule::AgentSchedule;
use chrono::{DateTime, Utc};
use openresponses_rust::{ReasoningConfig, ReasoningEffort, ReasoningSummary};
use ragents_protocol::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub fn build_reasoning_config(
    effort: Option<&str>,
    summary: Option<&str>,
) -> Option<ReasoningConfig> {
    let parsed_effort = match effort.map(str::trim) {
        Some("none") => Some(ReasoningEffort::None),
        Some("low") => Some(ReasoningEffort::Low),
        Some("medium") => Some(ReasoningEffort::Medium),
        Some("high") => Some(ReasoningEffort::High),
        Some("xhigh") => Some(ReasoningEffort::Xhigh),
        _ => None,
    };
    let parsed_summary = match summary.map(str::trim) {
        Some("concise") => Some(ReasoningSummary::Concise),
        Some("detailed") => Some(ReasoningSummary::Detailed),
        Some("auto") => Some(ReasoningSummary::Auto),
        _ => None,
    };
    if parsed_effort.is_none() && parsed_summary.is_none() {
        None
    } else {
        Some(ReasoningConfig {
            effort: parsed_effort,
            summary: parsed_summary,
        })
    }
}

pub fn build_built_in_tools(web_search: bool) -> Vec<String> {
    if web_search {
        vec!["web_search".to_string()]
    } else {
        Vec::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagerSettings {
    pub manager_model: String,
    pub manager_system_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_workspace_root: Option<String>,
    pub default_agent_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_reasoning_summary: Option<String>,
    #[serde(default)]
    pub default_web_search: bool,
    #[serde(default)]
    pub default_prompt_hint: bool,
    pub default_extensions: Vec<ExtensionSpec>,
    pub idle_peek_debounce_ms: u64,
    pub max_agent_relay_depth: u32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateManagerSettingsRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manager_system_prompt: Option<String>,
    pub default_node_id: Option<Option<String>>,
    pub default_workspace_root: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_model: Option<String>,
    pub default_reasoning_effort: Option<Option<String>>,
    pub default_reasoning_summary: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_web_search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_prompt_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_extensions: Option<Vec<ExtensionSpec>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_peek_debounce_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_agent_relay_depth: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeekIdleMode {
    Global,
    PerAgent,
}

impl Default for PeekIdleMode {
    fn default() -> Self {
        Self::Global
    }
}

impl PeekIdleMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::PerAgent => "per_agent",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "per_agent" => Self::PerAgent,
            _ => Self::Global,
        }
    }
}

pub const MAX_ROOM_PROMPTS_COUNT: usize = 20;
pub const MAX_ROOM_PROMPT_ITEM_CHARS: usize = 8_000;
pub const MAX_ROOM_PROMPTS_TOTAL_CHARS: usize = 32_000;

pub fn normalize_room_prompts(mut prompts: Vec<String>) -> Vec<String> {
    if prompts.is_empty() {
        return vec![String::new()];
    }
    let members = prompts.remove(0).trim().to_string();
    let mut normalized = Vec::with_capacity(prompts.len() + 1);
    normalized.push(members);
    for item in prompts {
        let trimmed = item.trim();
        if !trimmed.is_empty() {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

pub fn validate_room_prompts(prompts: &[String]) -> Result<(), String> {
    if prompts.len() > MAX_ROOM_PROMPTS_COUNT {
        return Err(format!(
            "房间公共 Prompt 条目数超出上限 ({} > {MAX_ROOM_PROMPTS_COUNT})",
            prompts.len()
        ));
    }
    let mut total_chars = 0usize;
    for (idx, item) in prompts.iter().enumerate() {
        let chars = item.chars().count();
        if chars > MAX_ROOM_PROMPT_ITEM_CHARS {
            return Err(format!(
                "房间公共 Prompt 第 [{idx}] 条长度超出上限 ({chars} > {MAX_ROOM_PROMPT_ITEM_CHARS} 字符)"
            ));
        }
        total_chars += chars;
    }
    if total_chars > MAX_ROOM_PROMPTS_TOTAL_CHARS {
        return Err(format!(
            "房间公共 Prompt 总长度超出上限 ({total_chars} > {MAX_ROOM_PROMPTS_TOTAL_CHARS} 字符)"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Room {
    pub room_id: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub room_prompts: Vec<String>,
    pub room_prompts_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_prompts_updated_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_prompts_updated_by: Option<String>,
    pub last_msg_seq: u64,
    pub peek_enabled: bool,
    pub peek_idle_mode: PeekIdleMode,
    pub peek_idle_secs: u64,
    pub peek_msg_interval: u32,
    pub interject_enabled: bool,
    pub mute_probability: u8,
    pub max_agent_relay_depth: u32,
    pub consecutive_agent_msgs: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomSummary {
    pub room: Room,
    pub agents: Vec<RoomAgentPublic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<RoomMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomFlowLogEntry {
    pub timestamp: DateTime<Utc>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomDetailResponse {
    pub room: Room,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manager_agent: Option<RoomAgentPublic>,
    pub agents: Vec<RoomAgentPublic>,
    pub messages: Vec<RoomMessage>,
    #[serde(default)]
    pub flow_logs: Vec<RoomFlowLogEntry>,
    #[serde(default)]
    pub pending_pool: RoomPendingPoolResponse,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RoomPendingPoolAgentStatus {
    pub agent_id: String,
    pub agent_name: String,
    pub avatar: String,
    pub last_delivered_seq: u64,
    pub unread_count: u64,
    pub countable_unread_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomPendingPoolMessageEntry {
    pub msg_seq: u64,
    pub sender_name: String,
    pub sender_kind: SenderKind,
    pub content: String,
    pub mentions: Vec<String>,
    pub is_realtime: bool,
    pub waiting_agent_names: Vec<String>,
    pub delivered_agent_names: Vec<String>,
    pub can_withdraw: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RoomPendingPoolResponse {
    pub room_id: String,
    pub room_last_seq: u64,
    pub total_undelivered_messages: usize,
    pub waiting_messages: Vec<RoomPendingPoolMessageEntry>,
    pub per_agent: Vec<RoomPendingPoolAgentStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRoomRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_agent_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_prompts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RoomPromptMutationRequest {
    pub action: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub room_prompts: Option<Vec<String>>,
    #[serde(default)]
    pub expected_version: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PatchRoomRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peek_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peek_idle_mode: Option<PeekIdleMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peek_idle_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peek_msg_interval: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interject_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mute_probability: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_agent_relay_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeState {
    Idle,
    Thinking,
    WaitingPermission,
}

impl AgentRuntimeState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Thinking => "thinking",
            Self::WaitingPermission => "waiting_permission",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "thinking" => Self::Thinking,
            "waiting_permission" => Self::WaitingPermission,
            _ => Self::Idle,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionChainEntry {
    pub generation: u32,
    pub working_session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomAgent {
    pub agent_id: String,
    pub room_id: String,
    pub name: String,
    pub role_title: String,
    pub avatar: String,
    pub persona_prompt: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(default)]
    pub web_search: bool,
    #[serde(default)]
    pub prompt_hint: bool,
    pub scheduling: SchedulingMode,
    pub root_session_id: SessionId,
    pub active_session_id: SessionId,
    pub session_chain: Vec<SessionChainEntry>,
    pub last_delivered_seq: u64,
    pub runtime_state: AgentRuntimeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_activation_id: Option<ActivationId>,
    pub agent_secret_token: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsageBreakdown {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTokenUsage {
    pub current_context_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_usage: Option<TokenUsageBreakdown>,
    pub total_usage: TokenUsageBreakdown,
    pub turn_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseQueuedMessageEntry {
    pub id: i64,
    pub queue_kind: QueueKind,
    pub sender_label: String,
    pub preview: String,
    pub tool_policy: QueueToolPolicy,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    #[serde(default)]
    pub msg_seqs: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_msg_seq: Option<u64>,
    pub status_label: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentMessageQueueSnapshot {
    pub realtime_messages: Vec<BaseQueuedMessageEntry>,
    pub pending_messages: Vec<BaseQueuedMessageEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomAgentPublic {
    pub agent_id: String,
    pub room_id: String,
    pub name: String,
    pub role_title: String,
    pub avatar: String,
    pub persona_prompt: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(default)]
    pub web_search: bool,
    #[serde(default)]
    pub prompt_hint: bool,
    pub scheduling: SchedulingMode,
    pub root_session_id: SessionId,
    pub active_session_id: SessionId,
    pub session_chain: Vec<SessionChainEntry>,
    pub last_delivered_seq: u64,
    pub runtime_state: AgentRuntimeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_activation_id: Option<ActivationId>,
    #[serde(default)]
    pub token_usage: AgentTokenUsage,
    #[serde(default)]
    pub active_schedule_count: u32,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}

impl From<RoomAgent> for RoomAgentPublic {
    fn from(a: RoomAgent) -> Self {
        Self {
            agent_id: a.agent_id,
            room_id: a.room_id,
            name: a.name,
            role_title: a.role_title,
            avatar: a.avatar,
            persona_prompt: a.persona_prompt,
            model: a.model,
            reasoning_effort: a.reasoning_effort,
            reasoning_summary: a.reasoning_summary,
            web_search: a.web_search,
            prompt_hint: a.prompt_hint,
            scheduling: a.scheduling,
            root_session_id: a.root_session_id,
            active_session_id: a.active_session_id,
            session_chain: a.session_chain,
            last_delivered_seq: a.last_delivered_seq,
            runtime_state: a.runtime_state,
            active_activation_id: a.active_activation_id,
            token_usage: AgentTokenUsage::default(),
            active_schedule_count: 0,
            created_by: a.created_by,
            created_at: a.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentRequest {
    pub name: String,
    pub role_title: String,
    #[serde(default = "default_avatar")]
    pub avatar: String,
    pub persona_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PatchAgentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub reasoning_effort: Option<Option<String>>,
    pub reasoning_summary: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_hint: Option<bool>,
}

fn default_avatar() -> String {
    "🤖".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecruitAgentRequest {
    pub requirement: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderKind {
    Human,
    Agent,
    Manager,
    System,
}

impl SenderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
            Self::Manager => "manager",
            Self::System => "system",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "agent" => Self::Agent,
            "manager" => Self::Manager,
            "system" => Self::System,
            _ => Self::Human,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomMessage {
    pub room_id: String,
    pub msg_seq: u64,
    pub message_id: String,
    pub sender_kind: SenderKind,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    pub mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub visible_to: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_seq: Option<u64>,
    #[serde(default)]
    pub is_realtime: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_activation_id: Option<ActivationId>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostMessageRequest {
    #[serde(default = "default_human_name")]
    pub sender_name: String,
    pub content: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub visible_to: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_seq: Option<u64>,
    #[serde(default)]
    pub is_realtime: bool,
}

fn default_human_name() -> String {
    "Human".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalAgentSpeakRequest {
    pub room_id: String,
    pub agent_id: String,
    pub content: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default)]
    pub visible_to: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalManagerAddAgentRequest {
    pub room_id: String,
    pub agent_id: String,
    pub name: String,
    pub role_title: String,
    #[serde(default)]
    pub avatar: String,
    pub persona_prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalManagerRemoveAgentRequest {
    pub room_id: String,
    pub agent_id: String,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalManagerRoomInfoRequest {
    pub room_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InternalRoomPromptRequest {
    pub room_id: String,
    pub agent_id: String,
    pub action: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub expected_version: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatroomEvent {
    MessagePosted {
        room_id: String,
        message: RoomMessage,
    },
    MessageWithdrawn {
        room_id: String,
        msg_seq: u64,
        withdrawn_message: RoomMessage,
    },
    AgentUpdated {
        room_id: String,
        agent: RoomAgentPublic,
    },
    AgentRemoved {
        room_id: String,
        agent_id: String,
    },
    RoomUpdated {
        room_id: String,
        room: Room,
    },
    PermissionAlert {
        room_id: String,
        agent_id: String,
        agent_name: String,
        activation_id: ActivationId,
        request: PermissionRequest,
    },
    PeekRoundStatus {
        room_id: String,
        status: String,
    },
    AgentActivity {
        room_id: String,
        agent_id: String,
        activity: String,
    },
    AgentSchedulesUpdated {
        room_id: String,
        agent_id: String,
        schedules: Vec<AgentSchedule>,
    },
    AgentQueueUpdated {
        room_id: String,
        agent_id: String,
        realtime_count: usize,
        pending_count: usize,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRuleEntry {
    pub category: String,
    pub list_kind: String,
    pub rule: String,
    /// `builtin` | `node_base` | `node_grant` | `workspace_grant` | `session_grant`
    pub scope: String,
    pub scope_label: String,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentPermissionSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub defaults: BTreeMap<String, String>,
    #[serde(default)]
    pub rules: Vec<PermissionRuleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevokeAgentPermissionRuleRequest {
    pub scope: String,
    pub category: String,
    pub list_kind: String,
    pub rule: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectorResponse {
    pub agent: RoomAgentPublic,
    pub selected_session_id: SessionId,
    pub session: Option<Session>,
    pub context: Option<SessionContextResponse>,
    #[serde(default)]
    pub item_timestamps: Vec<String>,
    pub events: Vec<SessionEventEnvelope>,
    pub pending_permissions: Vec<PermissionRequest>,
    #[serde(default)]
    pub can_edit_prompt: bool,
    #[serde(default)]
    pub message_queues: AgentMessageQueueSnapshot,
    #[serde(default)]
    pub permission_summary: AgentPermissionSummary,
    #[serde(default)]
    pub schedules: Vec<AgentSchedule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApproveAgentPermissionRequest {
    pub activation_id: ActivationId,
    pub request_id: PermissionRequestId,
    pub decision: PermissionDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithdrawQueuedMessageResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdrawn_message: Option<RoomMessage>,
    pub removed_queue_id: i64,
    pub message_queues: AgentMessageQueueSnapshot,
}
