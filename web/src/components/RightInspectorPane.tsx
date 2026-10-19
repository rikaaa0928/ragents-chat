import React, { useState, useEffect, useRef } from 'react';
import {
  Users,
  Sparkles,
  Plus,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cpu,
  FileText,
  GitBranch,
  OctagonX,
  ShieldAlert,
  Lock,
  Unlock,
  Save,
  Maximize2,
  Minimize2,
  X,
  Brain,
  Wrench,
  Terminal,
  Inbox,
  Package,
  ChevronsUpDown,
  Settings,
  Trash2,
  Crown,
  SlidersHorizontal,
  Microscope,
  Compass,
  Eye,
  MessageSquareMore,
  Repeat,
} from 'lucide-react';
import {
  Room,
  RoomAgent,
  InspectorSnapshot,
  ContextItem,
  FlowLogEntry,
} from '../types';

function extractPartArrayText(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    return val
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text || '');
        }
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof val === 'object' && 'text' in (val as Record<string, unknown>)) {
    return String((val as { text?: unknown }).text || '');
  }
  return JSON.stringify(val);
}

interface RightInspectorPaneProps {
  flowColumnOpen: boolean;
  onCloseFlowColumn: () => void;
  flowLogs: FlowLogEntry[];
  rosterColumnOpen: boolean;
  onCloseRosterColumn: () => void;
  inspectorColumnOpen: boolean;
  onCloseInspectorColumn: () => void;
  room: Room | null;
  managerAgent: RoomAgent | null;
  agents: RoomAgent[];
  agentActivities: Record<string, string>;
  inspector: InspectorSnapshot | null;
  availableModels: string[];
  liveReasoningBuffer: string;
  liveStreamBuffer: string;
  onSelectAgent: (agentId: string, sessionId?: string) => void;
  onOpenRecruitModal: () => void;
  onOpenAddAgentModal: () => void;
  onOpenManagerSettings: () => void;
  onRemoveAgent: (agentId: string) => void;
  onUpdateAgentConfig: (
    agentId: string,
    patch: {
      model?: string | null;
      reasoning_effort?: string | null;
      reasoning_summary?: string | null;
      role_title?: string | null;
      persona_prompt?: string | null;
    }
  ) => void;
  onResolvePermission: (
    activationId: string,
    requestId: string,
    decision: string,
    overridePath: string | null
  ) => void;
  onCancelAgent: (agentId: string) => void;
}

export const RightInspectorPane: React.FC<RightInspectorPaneProps> = ({
  flowColumnOpen,
  onCloseFlowColumn,
  flowLogs,
  rosterColumnOpen,
  onCloseRosterColumn,
  inspectorColumnOpen,
  onCloseInspectorColumn,
  room,
  managerAgent,
  agents,
  agentActivities,
  inspector,
  availableModels,
  liveReasoningBuffer,
  liveStreamBuffer,
  onSelectAgent,
  onOpenRecruitModal,
  onOpenAddAgentModal,
  onOpenManagerSettings,
  onRemoveAgent,
  onUpdateAgentConfig,
  onResolvePermission,
  onCancelAgent,
}) => {
  // Inspector Column Width Mode: standard (430px) or wide (580px)
  const [wideMode, setWideMode] = useState(false);

  // Master Collapsible Toggle for Inspector Configuration Section (collapsed by default to maximize content preview space!)
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false);
  // Active tab inside the collapsible config drawer
  const [activeConfigTab, setActiveConfigTab] = useState<'reasoning' | 'prompt' | 'lineage'>('reasoning');

  // Permission Box Collapsible State
  const [permExpanded, setPermExpanded] = useState(true);
  const [customPathOpen, setCustomPathOpen] = useState<Record<string, boolean>>({});
  const [permPaths, setPermPaths] = useState<Record<string, string>>({});

  // Collapsible Session Log Blocks & Filter
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const [logFilter, setLogFilter] = useState<'all' | 'thought' | 'tool' | 'context'>('all');

  // Prompt Editor Local Form State
  const [roleDraft, setRoleDraft] = useState('');
  const [promptDraft, setPromptDraft] = useState('');

  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const flowScrollRef = useRef<HTMLDivElement | null>(null);

  const inspectedAgent = inspector?.agent || null;

  useEffect(() => {
    if (flowColumnOpen && flowScrollRef.current) {
      flowScrollRef.current.scrollTop = flowScrollRef.current.scrollHeight;
    }
  }, [flowLogs.length, flowColumnOpen]);

  useEffect(() => {
    if (inspectedAgent) {
      setRoleDraft(inspectedAgent.role_title || '');
      setPromptDraft(inspectedAgent.persona_prompt || '');
    }
  }, [inspectedAgent?.agent_id, inspectedAgent?.role_title, inspectedAgent?.persona_prompt]);

  useEffect(() => {
    if (inspector?.pending_permissions && inspector.pending_permissions.length > 0) {
      setPermExpanded(true);
    }
  }, [inspector?.pending_permissions?.length]);

  const toggleBlockCollapse = (id: string) => {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const items = inspector?.context?.effective_items || [];

  const toggleAllBlocks = () => {
    if (collapsedBlocks.size > 0) {
      setCollapsedBlocks(new Set());
    } else {
      setCollapsedBlocks(new Set(items.map((it, idx) => it.id || `item-${idx}`)));
    }
  };

  const renderStatusDot = (state: RoomAgent['runtime_state']) => {
    if (state === 'thinking') {
      return <span className="w-2 h-2 rounded-full bg-blue-500 animate-ping inline-block shrink-0" />;
    }
    if (state === 'waiting_permission') {
      return <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse inline-block shrink-0" />;
    }
    return <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block shrink-0" />;
  };

  const roomLastSeq = room?.last_msg_seq || 0;
  const latestFlow = flowLogs.length > 0 ? flowLogs[flowLogs.length - 1] : null;

  return (
    <div className="flex h-full shrink-0 select-none">
      {/* =====================================================================
          VERTICAL COLUMN 0: 流程轨迹竖列 (Flow Trace Column - Closed by default!)
          ===================================================================== */}
      <aside
        className={`flex flex-col h-full shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-sidebar)] transition-all duration-200 ease-out overflow-hidden ${
          !flowColumnOpen
            ? 'w-0 border-l-0 opacity-0 pointer-events-none'
            : 'w-[300px] opacity-100'
        }`}
      >
        {/* Flow Column Header (52px) */}
        <div className="h-[52px] px-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0 bg-[var(--bg-main)]">
          <div className="flex items-center gap-1.5 min-w-0">
            <Compass className="w-4 h-4 text-violet-500 shrink-0" />
            <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">
              流程轨迹 ({flowLogs.length})
            </span>
          </div>
          <button
            onClick={onCloseFlowColumn}
            className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
            title="隐藏流程轨迹竖列"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Room Routing & Peek State Summary Cards */}
        {room && (
          <div className="p-3 border-b border-[var(--border-subtle)] space-y-2 text-[11px] shrink-0">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-0.5">
                <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                  <Eye className="w-3 h-3 text-emerald-500" />
                  <span>空闲窥屏</span>
                </div>
                <div className="font-semibold text-[var(--text-primary)]">
                  {room.peek_enabled
                    ? `${room.peek_idle_secs}s · ≥${room.peek_msg_interval}条`
                    : '已关闭'}
                </div>
              </div>

              <div className="p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-0.5">
                <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                  <MessageSquareMore className="w-3 h-3 text-violet-500" />
                  <span>主动插话</span>
                </div>
                <div className="font-semibold text-[var(--text-primary)]">
                  {room.peek_enabled && room.interject_enabled
                    ? `插话率 ${100 - room.mute_probability}%`
                    : '仅只读窥屏'}
                </div>
              </div>

              <div className="p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-0.5">
                <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                  <Repeat className="w-3 h-3 text-blue-500" />
                  <span>连续接力</span>
                </div>
                <div className="font-semibold text-[var(--text-primary)]">
                  {room.consecutive_agent_msgs} /{' '}
                  {room.max_agent_relay_depth > 0 ? room.max_agent_relay_depth : '∞'} 轮
                </div>
              </div>

              <div className="p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-0.5">
                <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                  <Users className="w-3 h-3 text-[var(--text-muted)]" />
                  <span>名册 / 消息</span>
                </div>
                <div className="font-semibold text-[var(--text-primary)]">
                  v{room.roster_version} · #{room.last_msg_seq}
                </div>
              </div>
            </div>

            {latestFlow && (
              <div className="p-2 rounded-lg bg-violet-500/10 border border-violet-500/25 text-violet-600 dark:text-violet-300 font-medium leading-snug">
                最新: {latestFlow.status}
              </div>
            )}
          </div>
        )}

        {/* Full-Height Scrollable Monospace Flow Log */}
        <div
          ref={flowScrollRef}
          className="flex-1 min-h-0 overflow-y-auto p-3 font-mono-code text-[11px] leading-relaxed space-y-2"
        >
          {flowLogs.length === 0 ? (
            <div className="py-12 text-center text-[var(--text-muted)] font-sans text-xs">
              暂无调度/窥屏轨迹记录
            </div>
          ) : (
            flowLogs.map((entry, idx) => {
              const timeStr = entry.timestamp
                ? new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })
                : '';
              return (
                <div
                  key={idx}
                  className="p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] text-[var(--text-secondary)] break-words"
                >
                  <div className="text-[10px] text-[var(--text-muted)] mb-0.5">
                    [{timeStr}]
                  </div>
                  <div>{entry.status}</div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* =====================================================================
          VERTICAL COLUMN 1: 群成员竖列 (Agent Roster Column)
          ===================================================================== */}
      <aside
        className={`flex flex-col h-full shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-sidebar)] transition-all duration-200 ease-out overflow-hidden ${
          !rosterColumnOpen
            ? 'w-0 border-l-0 opacity-0 pointer-events-none'
            : 'w-[280px] opacity-100'
        }`}
      >
        {/* Column 1 Header (52px) */}
        <div className="h-[52px] px-3 border-b border-[var(--border-subtle)] flex items-center justify-between gap-1.5 shrink-0 bg-[var(--bg-main)]">
          <div className="flex items-center gap-1.5 min-w-0">
            <Users className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
            <span className="font-semibold text-[13px] text-[var(--text-primary)] truncate">
              群成员 ({agents.length} + 管家)
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onOpenRecruitModal}
              className="px-2 py-1 rounded-md text-[11px] font-medium bg-violet-500/12 text-violet-600 dark:text-violet-300 hover:bg-violet-500/20 flex items-center gap-1 cursor-pointer transition-colors"
              title="让 @Manager 招募新专家"
            >
              <Sparkles className="w-3 h-3" />
              <span>招募</span>
            </button>
            <button
              onClick={onOpenAddAgentModal}
              className="px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-surface-2)] border border-[var(--border-subtle)] flex items-center gap-0.5 cursor-pointer transition-colors"
              title="手动添加 Agent"
            >
              <Plus className="w-3 h-3" />
              <span>添加</span>
            </button>
            <button
              onClick={onCloseRosterColumn}
              className="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              title="隐藏群成员竖列"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Full-Height Scrollable Roster List */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2">
          {/* @Manager Card */}
          {managerAgent && (
            <div
              onClick={() => onSelectAgent(managerAgent.agent_id)}
              className={`p-2.5 rounded-xl border border-dashed cursor-pointer transition-all space-y-1.5 ${
                inspectedAgent?.agent_id === managerAgent.agent_id && inspectorColumnOpen
                  ? 'border-violet-500 bg-violet-500/12 shadow-xs'
                  : 'border-violet-500/35 bg-violet-500/[0.04] hover:bg-violet-500/[0.08]'
              }`}
            >
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-300 min-w-0">
                  {renderStatusDot(managerAgent.runtime_state)}
                  <span className="truncate">🎩 @Manager</span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenManagerSettings();
                  }}
                  className="px-1.5 py-0.5 rounded text-[10.5px] bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border-subtle)] flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <Settings className="w-2.5 h-2.5" />
                  <span>默认设置</span>
                </button>
              </div>
              <div className="text-[11px] text-[var(--text-muted)] truncate">
                {managerAgent.role_title}
              </div>
              <div className="text-[10.5px] text-[var(--text-muted)] font-mono-code flex items-center justify-between">
                <span>{managerAgent.model}</span>
                <span>
                  已读 #{managerAgent.last_delivered_seq}/#{roomLastSeq}
                </span>
              </div>
            </div>
          )}

          {/* Working Agent Cards */}
          {agents.map((a, idx) => {
            const isSelected =
              inspectedAgent?.agent_id === a.agent_id && inspectorColumnOpen;
            const unread = Math.max(0, roomLastSeq - (a.last_delivered_seq || 0));
            const activity = agentActivities[a.agent_id] || '';
            return (
              <div
                key={a.agent_id}
                onClick={() => onSelectAgent(a.agent_id)}
                className={`p-2.5 rounded-xl border cursor-pointer transition-all space-y-1.5 ${
                  isSelected
                    ? 'bg-[var(--bg-active)] border-[var(--text-secondary)] shadow-xs'
                    : 'bg-[var(--bg-main)] border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)] min-w-0">
                    {renderStatusDot(a.runtime_state)}
                    <span className="truncate">
                      {a.avatar} @{a.name}
                    </span>
                    {idx === 0 && agents.length > 1 && (
                      <span className="px-1.5 py-0.2 rounded bg-blue-500/12 text-blue-600 dark:text-blue-400 text-[10px] font-medium inline-flex items-center gap-0.5 shrink-0">
                        <Crown className="w-2.5 h-2.5" />
                        主导
                      </span>
                    )}
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveAgent(a.agent_id);
                    }}
                    className="p-1 rounded-md text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 shrink-0 cursor-pointer transition-colors"
                    title="移除该 Agent"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                <div className="text-[11px] text-[var(--text-secondary)] truncate">
                  {a.role_title}
                </div>

                <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                  <span
                    className={
                      a.runtime_state === 'waiting_permission'
                        ? 'text-amber-600 dark:text-amber-400 font-medium'
                        : a.runtime_state === 'thinking'
                        ? 'text-blue-500 font-medium'
                        : ''
                    }
                  >
                    {a.runtime_state === 'thinking'
                      ? '🔵 思考中'
                      : a.runtime_state === 'waiting_permission'
                      ? '🟠 待审批'
                      : '🟢 空闲'}
                  </span>
                  <span>·</span>
                  <span>{a.allow_speak_in_turn ? '🔊 可发言' : '🔇 窥屏禁言'}</span>
                  <span>·</span>
                  <span>
                    #{a.last_delivered_seq}/#{roomLastSeq}
                    {unread > 0 ? ` (未读${unread})` : ''}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[10.5px] text-[var(--text-muted)] font-mono-code pt-0.5 border-t border-[var(--border-subtle)]">
                  <span className="truncate">{a.model}</span>
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5 shrink-0">
                    <Microscope className="w-2.5 h-2.5" />
                    点击透视
                  </span>
                </div>

                {a.scheduling?.mode === 'pinned' && (
                  <div className="text-[10px] text-[var(--text-muted)] font-mono-code truncate">
                    🖥️ {a.scheduling.node_id || 'Pinned'}{' '}
                    {a.scheduling.workspace_path
                      ? `· ${a.scheduling.workspace_path}`
                      : ''}
                  </div>
                )}

                {activity && (
                  <div className="text-[11px] text-blue-500 font-medium truncate">
                    {activity}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* =====================================================================
          VERTICAL COLUMN 2: 具体 Agent Session 透视竖列 (Independently Hideable!)
          ===================================================================== */}
      <aside
        className={`flex flex-col h-full shrink-0 border-l border-[var(--border-subtle)] bg-[var(--bg-main)] transition-all duration-200 ease-out overflow-hidden ${
          !inspectorColumnOpen
            ? 'w-0 border-l-0 opacity-0 pointer-events-none'
            : wideMode
            ? 'w-[600px] max-w-[85vw] opacity-100'
            : 'w-[430px] max-w-[82vw] opacity-100'
        }`}
      >
        {/* Column 2 Top Header (52px) */}
        <div className="h-[52px] px-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0 bg-[var(--bg-main)]">
          <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
            {inspectedAgent ? (
              <>
                {renderStatusDot(inspectedAgent.runtime_state)}
                <span className="text-sm shrink-0">{inspectedAgent.avatar}</span>
                <span className="font-semibold text-[13.5px] text-[var(--text-primary)] shrink-0 whitespace-nowrap">
                  @{inspectedAgent.name}
                </span>
                <span className="text-[11px] text-[var(--text-muted)] font-mono-code truncate min-w-0">
                  {inspector?.selected_session_id}
                </span>
              </>
            ) : (
              <span className="font-semibold text-[13px] text-[var(--text-secondary)]">
                Session 实时透视
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {inspectedAgent?.active_activation_id && (
              <button
                onClick={() => onCancelAgent(inspectedAgent.agent_id)}
                className="px-2 py-1 rounded-lg text-[11px] font-medium bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500 hover:text-white flex items-center gap-1 cursor-pointer transition-colors"
                title="紧急中止当前 Agent 执行回合"
              >
                <OctagonX className="w-3 h-3" />
                <span>中止</span>
              </button>
            )}

            {/* Master Collapsible Config Drawer Toggle Button */}
            {inspectedAgent && (
              <button
                onClick={() => setConfigDrawerOpen(!configDrawerOpen)}
                className={`h-7 px-2.5 rounded-lg text-[11.5px] font-medium flex items-center gap-1 border cursor-pointer transition-colors ${
                  configDrawerOpen
                    ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] border-transparent'
                    : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'
                }`}
                title="展开/折叠 Agent 模型配置、System Prompt 与压缩血缘"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>透视配置</span>
                {configDrawerOpen ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            )}

            <button
              onClick={() => setWideMode(!wideMode)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              title={wideMode ? '切换标准列宽' : '加宽透视竖列'}
            >
              {wideMode ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>

            <button
              onClick={onCloseInspectorColumn}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              title="单独隐藏具体 Agent 透视竖列"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {!inspectedAgent ? (
          <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-[var(--text-muted)]">
            请在左侧「群成员竖列」或聊天消息中点击任意 Agent 查看其底层 Session
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* ===============================================================
                COLLAPSIBLE CONFIG DRAWER (Collapsed by default to leave max space for content preview!)
                =============================================================== */}
            {configDrawerOpen && (
              <div className="p-3 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] space-y-2.5 shrink-0 text-xs max-h-[48%] overflow-y-auto">
                {/* Sub-Tab Selector inside Collapsible Config Drawer */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
                    <button
                      onClick={() => setActiveConfigTab('reasoning')}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                        activeConfigTab === 'reasoning'
                          ? 'bg-[var(--bg-main)] text-[var(--text-primary)] shadow-2xs'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <Cpu className="w-3 h-3 text-blue-500" />
                      <span>模型与思考</span>
                    </button>

                    <button
                      onClick={() => setActiveConfigTab('prompt')}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                        activeConfigTab === 'prompt'
                          ? 'bg-[var(--bg-main)] text-[var(--text-primary)] shadow-2xs'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <FileText className="w-3 h-3 text-emerald-500" />
                      <span>System Prompt</span>
                      {inspector?.can_edit_prompt ? (
                        <Unlock className="w-2.5 h-2.5 text-emerald-500" />
                      ) : (
                        <Lock className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                      )}
                    </button>

                    <button
                      onClick={() => setActiveConfigTab('lineage')}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                        activeConfigTab === 'lineage'
                          ? 'bg-[var(--bg-main)] text-[var(--text-primary)] shadow-2xs'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <GitBranch className="w-3 h-3 text-violet-500" />
                      <span>血缘链 ({inspectedAgent.session_chain?.length || 1}代)</span>
                    </button>
                  </div>

                  <button
                    onClick={() => setConfigDrawerOpen(false)}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] cursor-pointer"
                  >
                    收起配置 ▲
                  </button>
                </div>

                {/* Tab 1: Model & Reasoning Effort/Summary */}
                {activeConfigTab === 'reasoning' && (
                  <div className="p-2.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10.5px] text-[var(--text-muted)] mb-1">
                          模型 (Model)
                        </label>
                        <select
                          value={inspectedAgent.model || ''}
                          onChange={(e) =>
                            onUpdateAgentConfig(inspectedAgent.agent_id, {
                              model: e.target.value || null,
                            })
                          }
                          className="w-full px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11.5px]"
                        >
                          {Array.from(
                            new Set([...availableModels, inspectedAgent.model])
                          ).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10.5px] text-[var(--text-muted)] mb-1">
                          思考强度 (Effort)
                        </label>
                        <select
                          value={inspectedAgent.reasoning_effort || ''}
                          onChange={(e) =>
                            onUpdateAgentConfig(inspectedAgent.agent_id, {
                              reasoning_effort: e.target.value || null,
                            })
                          }
                          className="w-full px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11.5px]"
                        >
                          <option value="">默认</option>
                          <option value="none">none (关闭)</option>
                          <option value="low">low (轻量)</option>
                          <option value="medium">medium (中等)</option>
                          <option value="high">high (深度)</option>
                          <option value="xhigh">xhigh (极高)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[10.5px] text-[var(--text-muted)] mb-1">
                          思考摘要 (Summary)
                        </label>
                        <select
                          value={inspectedAgent.reasoning_summary || ''}
                          onChange={(e) =>
                            onUpdateAgentConfig(inspectedAgent.agent_id, {
                              reasoning_summary: e.target.value || null,
                            })
                          }
                          className="w-full px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11.5px]"
                        >
                          <option value="">默认</option>
                          <option value="auto">auto (自动)</option>
                          <option value="concise">concise (精简)</option>
                          <option value="detailed">detailed (详细)</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {/* Tab 2: Role Title & System Prompt Editor */}
                {activeConfigTab === 'prompt' && (
                  <div className="p-2.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[11.5px] text-[var(--text-primary)]">
                        角色头衔与人设提示词
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          inspector?.can_edit_prompt
                            ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                            : 'bg-[var(--bg-surface)] text-[var(--text-muted)]'
                        }`}
                      >
                        {inspector?.can_edit_prompt
                          ? '🟢 首次运行前允许修改'
                          : '🔒 已触发运行 · 只读锁定'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[var(--text-muted)] shrink-0">
                        头衔:
                      </span>
                      <input
                        type="text"
                        value={roleDraft}
                        readOnly={!inspector?.can_edit_prompt}
                        onChange={(e) => setRoleDraft(e.target.value)}
                        className="flex-1 px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs"
                      />
                    </div>

                    <textarea
                      rows={3}
                      value={promptDraft}
                      readOnly={!inspector?.can_edit_prompt}
                      onChange={(e) => setPromptDraft(e.target.value)}
                      className="w-full p-2 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono-code text-[11.5px] leading-relaxed resize-y"
                    />

                    {inspector?.can_edit_prompt && (
                      <div className="flex justify-end">
                        <button
                          onClick={() =>
                            onUpdateAgentConfig(inspectedAgent.agent_id, {
                              role_title: roleDraft.trim() || null,
                              persona_prompt: promptDraft.trim() || null,
                            })
                          }
                          className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] flex items-center gap-1 cursor-pointer"
                        >
                          <Save className="w-3 h-3" />
                          <span>保存 Prompt 修改</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Tab 3: Session Compaction Lineage */}
                {activeConfigTab === 'lineage' && (
                  <div className="p-2.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                      {(inspectedAgent.session_chain || []).map((entry, idx) => {
                        const isCompactSel =
                          inspector?.selected_session_id === entry.compaction_session_id;
                        const isWorkSel =
                          inspector?.selected_session_id === entry.working_session_id;
                        const isLatest =
                          entry.working_session_id === inspectedAgent.active_session_id;

                        return (
                          <React.Fragment key={entry.generation}>
                            {idx > 0 && (
                              <span className="text-[10px] text-[var(--text-muted)]">➔</span>
                            )}
                            {entry.compaction_session_id && (
                              <>
                                <button
                                  onClick={() =>
                                    onSelectAgent(
                                      inspectedAgent.agent_id,
                                      entry.compaction_session_id!
                                    )
                                  }
                                  className={`px-2 py-0.5 rounded-md text-[11px] font-medium shrink-0 cursor-pointer ${
                                    isCompactSel
                                      ? 'bg-amber-500 text-black'
                                      : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                  }`}
                                >
                                  📦 Compact #{entry.generation}
                                </button>
                                <span className="text-[10px] text-[var(--text-muted)]">➔</span>
                              </>
                            )}
                            <button
                              onClick={() =>
                                onSelectAgent(
                                  inspectedAgent.agent_id,
                                  entry.working_session_id
                                )
                              }
                              className={`px-2 py-0.5 rounded-md text-[11px] font-medium shrink-0 cursor-pointer ${
                                isWorkSel
                                  ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)]'
                                  : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                              }`}
                            >
                              Gen {entry.generation}
                              {isLatest ? ' (当前)' : ''}
                            </button>
                          </React.Fragment>
                        );
                      })}
                    </div>
                    <div className="text-[10.5px] text-[var(--text-muted)] flex items-center gap-1">
                      <Lock className="w-3 h-3 shrink-0" />
                      <span>只读透视模式：禁止在此处私聊，一切对话请在左侧聊天室进行。</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ===============================================================
                COLLAPSIBLE 5-LEVEL PERMISSION APPROVAL BOX
                =============================================================== */}
            {inspector?.pending_permissions &&
              inspector.pending_permissions.length > 0 && (
                <div className="mx-3 mt-2.5 rounded-xl border border-amber-500/50 bg-amber-500/10 overflow-hidden shrink-0">
                  <div
                    onClick={() => setPermExpanded(!permExpanded)}
                    className="px-3 py-2 flex items-center justify-between cursor-pointer select-none"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                      <ShieldAlert className="w-4 h-4 animate-bounce" />
                      <span>
                        5 级沙箱权限审批 ({inspector.pending_permissions.length})
                      </span>
                    </div>
                    {permExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5 text-amber-500" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-amber-500" />
                    )}
                  </div>

                  {permExpanded && (
                    <div className="px-3 pb-3 space-y-2 border-t border-amber-500/25 pt-2 text-xs max-h-[220px] overflow-y-auto">
                      {inspector.pending_permissions.map((p) => {
                        const actId =
                          p.activation_id || inspectedAgent.active_activation_id || '';
                        const isPathOpen = Boolean(customPathOpen[p.id]);
                        return (
                          <div key={p.id} className="space-y-1.5">
                            <div className="font-mono-code text-[11px] bg-[var(--bg-main)] p-2 rounded-lg border border-[var(--border-subtle)] break-all">
                              <span className="text-[var(--text-muted)]">capability: </span>
                              {JSON.stringify(p.capability)}
                              {p.original_path && (
                                <div className="mt-0.5 text-amber-600 dark:text-amber-400">
                                  path: {p.original_path}
                                </div>
                              )}
                            </div>

                            {p.reason && (
                              <div className="text-[11.5px] text-[var(--text-secondary)]">
                                {p.reason}
                              </div>
                            )}

                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  setCustomPathOpen((prev) => ({
                                    ...prev,
                                    [p.id]: !prev[p.id],
                                  }))
                                }
                                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer"
                              >
                                {isPathOpen ? (
                                  <ChevronDown className="w-3 h-3" />
                                ) : (
                                  <ChevronRight className="w-3 h-3" />
                                )}
                                <span>自定义授权路径覆盖 (--path)</span>
                              </button>
                              {isPathOpen && (
                                <input
                                  type="text"
                                  placeholder="例如: /etc/ragents/*"
                                  value={permPaths[p.id] || ''}
                                  onChange={(e) =>
                                    setPermPaths((prev) => ({
                                      ...prev,
                                      [p.id]: e.target.value,
                                    }))
                                  }
                                  className="mt-1 w-full px-2.5 py-1 rounded-md bg-[var(--bg-main)] border border-[var(--border-default)] text-[11.5px] font-mono-code"
                                />
                              )}
                            </div>

                            <div className="flex flex-wrap gap-1.5 pt-0.5">
                              {[
                                { key: 'allow_once', label: '仅本次' },
                                { key: 'allow_activation', label: '本轮激活' },
                                { key: 'allow_session', label: '本会话' },
                                { key: 'allow_workspace', label: '工作区' },
                                { key: 'allow_node', label: '全节点' },
                              ].map((btn) => (
                                <button
                                  key={btn.key}
                                  onClick={() =>
                                    onResolvePermission(
                                      actId,
                                      p.id,
                                      btn.key,
                                      permPaths[p.id]?.trim() || null
                                    )
                                  }
                                  className="px-2 py-1 rounded-md text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer transition-colors"
                                >
                                  {btn.label}
                                </button>
                              ))}
                              <button
                                onClick={() =>
                                  onResolvePermission(
                                    actId,
                                    p.id,
                                    'deny',
                                    permPaths[p.id]?.trim() || null
                                  )
                                }
                                className="px-2 py-1 rounded-md text-[11px] font-medium bg-red-600 hover:bg-red-500 text-white cursor-pointer transition-colors"
                              >
                                拒绝
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

            {/* ===============================================================
                SESSION CONTENT STREAM FILTER BAR + FULL-HEIGHT SCROLLABLE LOG
                =============================================================== */}
            <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 text-[11px] shrink-0 bg-[var(--bg-sidebar)]">
              <div className="flex items-center gap-1">
                {[
                  { key: 'all', label: `全部 (${items.length})` },
                  { key: 'thought', label: '💭 思考' },
                  { key: 'tool', label: '🔧 工具' },
                  { key: 'context', label: '📥 上下文' },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setLogFilter(tab.key as typeof logFilter)}
                    className={`px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors ${
                      logFilter === tab.key
                        ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <button
                onClick={toggleAllBlocks}
                className="px-2 py-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-1 cursor-pointer"
                title="一键展开或折叠所有条目"
              >
                <ChevronsUpDown className="w-3 h-3" />
                <span>{collapsedBlocks.size > 0 ? '全部展开' : '全部折叠'}</span>
              </button>
            </div>

            {/* Full-Height Scrollable Session Content Preview */}
            <div
              ref={logScrollRef}
              className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 font-mono-code text-xs"
            >
              {items.length === 0 && !liveReasoningBuffer && !liveStreamBuffer ? (
                <div className="py-16 text-center text-[var(--text-muted)] font-sans text-xs space-y-1">
                  <div>该 Session 尚未产生思考或工具调用记录</div>
                  {inspector?.can_edit_prompt && (
                    <div className="text-[11px] text-emerald-500">
                      提示：点击右上角「透视配置 ➔ System Prompt」可在首次运行前修改该 Agent 的人设提示词
                    </div>
                  )}
                </div>
              ) : (
                items.map((item: ContextItem, idx: number) => {
                  const blockId = item.id || `item-${idx}`;
                  const isCollapsed = collapsedBlocks.has(blockId);

                  const rawContentText = extractPartArrayText(item.content);
                  const rawSummaryText = extractPartArrayText(item.summary);
                  const rawText = [rawSummaryText, rawContentText]
                    .filter(Boolean)
                    .join('\n\n');
                  const isCompaction = rawText.startsWith('[Compaction Summary]');

                  if (logFilter === 'thought' && item.type !== 'reasoning') return null;
                  if (
                    logFilter === 'tool' &&
                    item.type !== 'function_call' &&
                    item.type !== 'function_call_output'
                  )
                    return null;
                  if (logFilter === 'context' && item.type !== 'message') return null;

                  let icon = <Inbox className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
                  let title = 'Context';
                  let preview = rawText.replace(/\s+/g, ' ').slice(0, 68);
                  let bodyContent = rawText;
                  let badgeColor = 'text-emerald-600 dark:text-emerald-400';

                  if (isCompaction) {
                    icon = <Package className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
                    title = 'Compaction Summary';
                    badgeColor = 'text-amber-600 dark:text-amber-400';
                  } else if (item.type === 'reasoning') {
                    icon = <Brain className="w-3.5 h-3.5 text-violet-500 shrink-0" />;
                    const firstLine =
                      rawText
                        .split('\n')
                        .map((l) => l.replace(/^\*\*|\*\*$/g, '').trim())
                        .find(Boolean) || 'Thought / 内部推理链';
                    title = `Thought: ${firstLine.slice(0, 42)}`;
                    bodyContent = rawText || '(已完成内部推理)';
                    preview = bodyContent.replace(/\s+/g, ' ').slice(0, 60);
                    badgeColor = 'text-violet-600 dark:text-violet-400';
                  } else if (item.type === 'function_call') {
                    icon = <Wrench className="w-3.5 h-3.5 text-blue-500 shrink-0" />;
                    title = `ToolCall: ${String(item.name || 'tool')}${
                      item.duration_ms ? ` (${item.duration_ms}ms)` : ''
                    }`;
                    let formattedArgs =
                      typeof item.arguments === 'string'
                        ? item.arguments
                        : JSON.stringify(item.arguments || {}, null, 2);
                    try {
                      formattedArgs = JSON.stringify(
                        JSON.parse(formattedArgs),
                        null,
                        2
                      );
                    } catch (_) {}
                    bodyContent = formattedArgs;
                    preview = bodyContent.replace(/\s+/g, ' ').slice(0, 60);
                    badgeColor = 'text-blue-600 dark:text-blue-400';
                  } else if (item.type === 'function_call_output') {
                    icon = <Terminal className="w-3.5 h-3.5 text-cyan-500 shrink-0" />;
                    title = `ToolResult${item.name ? `: ${String(item.name)}` : ''}`;
                    bodyContent =
                      typeof item.output === 'string'
                        ? item.output
                        : JSON.stringify(item.output ?? '', null, 2);
                    preview = bodyContent.replace(/\s+/g, ' ').slice(0, 60);
                    badgeColor = 'text-cyan-600 dark:text-cyan-400';
                  } else if (item.type === 'message') {
                    const role = String(item.role || 'user');
                    title =
                      role === 'user'
                        ? 'Context:user (聊天室上下文载荷)'
                        : `Context:${role} (内部草稿)`;
                  }

                  return (
                    <div
                      key={blockId}
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden"
                    >
                      <div
                        onClick={() => toggleBlockCollapse(blockId)}
                        className="px-3 py-2 flex items-center justify-between gap-2 cursor-pointer hover:bg-[var(--bg-hover)] select-none"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {isCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                          )}
                          {icon}
                          <span className={`font-semibold text-[11.5px] shrink-0 ${badgeColor}`}>
                            {title}
                          </span>
                          {isCollapsed && (
                            <span className="text-[11px] text-[var(--text-muted)] truncate">
                              {preview}
                            </span>
                          )}
                        </div>
                      </div>

                      {!isCollapsed && (
                        <div className="px-3 pb-2.5 pt-1 border-t border-[var(--border-subtle)] text-[11.5px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                          {bodyContent}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {/* Live Streaming Reasoning Slot */}
              {liveReasoningBuffer && (
                <div className="rounded-xl border border-violet-500/40 bg-violet-500/[0.06] p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-violet-500">
                    <Brain className="w-3.5 h-3.5 animate-spin" />
                    <span>💭 实时思考流 (Reasoning Delta)</span>
                  </div>
                  <div className="text-[11.5px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">
                    {liveReasoningBuffer}
                    <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-violet-500 animate-pulse align-middle" />
                  </div>
                </div>
              )}

              {/* Live Streaming Output Slot */}
              {liveStreamBuffer && (
                <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/[0.06] p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-emerald-500">
                    <Terminal className="w-3.5 h-3.5" />
                    <span>✍️ 实时输出流 (Output Delta)</span>
                  </div>
                  <div className="text-[11.5px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">
                    {liveStreamBuffer}
                    <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-emerald-500 animate-pulse align-middle" />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
};
