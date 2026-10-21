use chrono::{DateTime, Utc};
use openresponses_rust::{ReasoningConfig, ReasoningEffort, ReasoningSummary};
use ragents_protocol::*;
use serde::{Deserialize, Serialize};

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
    pub default_extensions: Option<Vec<ExtensionSpec>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_peek_debounce_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_agent_relay_depth: Option<u32>,
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
    pub last_msg_seq: u64,
    pub roster_version: u64,
    pub peek_enabled: bool,
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
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
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
    pub peek_idle_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peek_msg_interval: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interject_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mute_probability: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_agent_relay_depth: Option<u32>,
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
    pub scheduling: SchedulingMode,
    pub root_session_id: SessionId,
    pub active_session_id: SessionId,
    pub session_chain: Vec<SessionChainEntry>,
    pub last_delivered_seq: u64,
    pub last_roster_version: u64,
    pub allow_speak_in_turn: bool,
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
pub struct QueuedMessageEntry {
    pub msg_seq: u64,
    pub sender_name: String,
    pub content: String,
    pub is_realtime: bool,
    pub status_label: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentMessageQueueSnapshot {
    pub realtime_messages: Vec<QueuedMessageEntry>,
    pub normal_messages: Vec<QueuedMessageEntry>,
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
    pub scheduling: SchedulingMode,
    pub root_session_id: SessionId,
    pub active_session_id: SessionId,
    pub session_chain: Vec<SessionChainEntry>,
    pub last_delivered_seq: u64,
    pub allow_speak_in_turn: bool,
    pub runtime_state: AgentRuntimeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_activation_id: Option<ActivationId>,
    #[serde(default)]
    pub token_usage: AgentTokenUsage,
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
            scheduling: a.scheduling,
            root_session_id: a.root_session_id,
            active_session_id: a.active_session_id,
            session_chain: a.session_chain,
            last_delivered_seq: a.last_delivered_seq,
            allow_speak_in_turn: a.allow_speak_in_turn,
            runtime_state: a.runtime_state,
            active_activation_id: a.active_activation_id,
            token_usage: AgentTokenUsage::default(),
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
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatroomEvent {
    MessagePosted {
        room_id: String,
        message: RoomMessage,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectorResponse {
    pub agent: RoomAgentPublic,
    pub selected_session_id: SessionId,
    pub session: Option<Session>,
    pub context: Option<SessionContextResponse>,
    pub events: Vec<SessionEventEnvelope>,
    pub pending_permissions: Vec<PermissionRequest>,
    #[serde(default)]
    pub can_edit_prompt: bool,
    #[serde(default)]
    pub message_queues: AgentMessageQueueSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApproveAgentPermissionRequest {
    pub activation_id: ActivationId,
    pub request_id: PermissionRequestId,
    pub decision: PermissionDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_path: Option<String>,
}
