export interface Room {
  room_id: string;
  name: string;
  description: string;
  node_id?: string | null;
  workspace_path?: string | null;
  peek_enabled: boolean;
  peek_idle_secs: number;
  peek_msg_interval: number;
  interject_enabled: boolean;
  mute_probability: number;
  max_agent_relay_depth: number;
  consecutive_agent_msgs: number;
  roster_version: number;
  last_msg_seq: number;
  created_at?: string;
  updated_at?: string;
}

export interface CreateRoomPreset {
  nodeId: string;
  workspacePath: string;
}

export interface SessionChainEntry {
  generation: number;
  working_session_id: string;
  compaction_session_id?: string | null;
}

export type RuntimeState = 'idle' | 'thinking' | 'waiting_permission';

export interface AgentScheduling {
  mode: 'pinned' | 'floating';
  node_id?: string | null;
  workspace_path?: string | null;
  node_selector?: Record<string, string>;
}

export interface TokenUsageBreakdown {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
}

export interface AgentTokenUsage {
  current_context_tokens: number;
  last_usage?: TokenUsageBreakdown | null;
  total_usage: TokenUsageBreakdown;
  turn_count: number;
}

export interface QueuedMessageEntry {
  msg_seq: number;
  sender_name: string;
  content: string;
  is_realtime: boolean;
  status_label: string;
  created_at: string;
}

export interface AgentMessageQueueSnapshot {
  realtime_messages: QueuedMessageEntry[];
  normal_messages: QueuedMessageEntry[];
}

export interface RoomAgent {
  agent_id: string;
  room_id: string;
  name: string;
  role_title: string;
  avatar: string;
  model: string;
  persona_prompt: string;
  reasoning_effort?: string | null;
  reasoning_summary?: string | null;
  scheduling?: AgentScheduling;
  runtime_state: RuntimeState;
  allow_speak_in_turn: boolean;
  last_delivered_seq: number;
  active_session_id: string;
  active_activation_id?: string | null;
  session_chain: SessionChainEntry[];
  token_usage?: AgentTokenUsage;
}

export type SendShortcutMode = 'enter_send' | 'shift_enter_send';

export interface ChatMessage {
  msg_seq: number;
  room_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: 'human' | 'agent' | 'manager' | 'system';
  content: string;
  mentions: string[];
  visible_to?: string[];
  reply_to_seq?: number | null;
  is_realtime?: boolean;
  created_at: string;
}

export interface FlowLogEntry {
  timestamp: string;
  status: string;
}

export interface RoomListItem {
  room: Room;
  agents: RoomAgent[];
  last_message?: ChatMessage | null;
}

export interface RoomDetailResponse {
  room: Room;
  manager_agent?: RoomAgent | null;
  agents: RoomAgent[];
  messages: ChatMessage[];
  flow_logs: FlowLogEntry[];
}

export interface PendingPermission {
  id: string;
  activation_id?: string;
  capability: Record<string, unknown> | string;
  original_path?: string | null;
  reason?: string | null;
}

export interface ContextItem {
  id?: string;
  type: 'message' | 'reasoning' | 'function_call' | 'function_call_output';
  role?: 'user' | 'assistant' | 'system';
  content?: Array<{ type?: string; text?: string }> | string;
  name?: string;
  arguments?: string;
  output?: unknown;
  duration_ms?: number;
  summary?: Array<{ type?: string; text?: string }> | string;
}

export interface InspectorEventEnvelope {
  seq?: number;
  timestamp?: string;
  event: {
    type?: string;
    kind?: string;
    name?: string;
    delta?: string;
    error?: string;
    node_id?: string;
    count?: number;
    duration_ms?: number;
    items?: ContextItem[];
  };
}

export interface PromptParts {
  system_prompt: string;
  node_prompt: string;
  client_prompt: string;
  extension_prompts: Record<string, string>;
}

export interface InspectorSnapshot {
  agent: RoomAgent;
  selected_session_id: string;
  can_edit_prompt: boolean;
  session?: {
    status?: {
      latest_prompt_parts?: PromptParts | null;
      effective_tools?: string[];
    };
  } | null;
  pending_permissions: PendingPermission[];
  context: {
    effective_items: ContextItem[];
  };
  events: InspectorEventEnvelope[];
  message_queues?: AgentMessageQueueSnapshot;
}

export interface ClusterNode {
  metadata: {
    id: string;
  };
  status: {
    phase: string;
    hostname?: string;
    os?: string;
    arch?: string;
    supported_models?: string[];
    default_model?: string;
    allowed_workspace_dirs?: string[];
  };
}

export interface ManagerSettings {
  manager_model: string;
  default_agent_model: string;
  default_reasoning_effort?: string | null;
  default_reasoning_summary?: string | null;
  default_node_id?: string | null;
  default_workspace_root?: string | null;
  max_agent_relay_depth: number;
  manager_system_prompt: string;
}
