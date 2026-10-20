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
  Zap,
  Clock,
  ArrowDown,
  CheckCircle2,
} from 'lucide-react';
import {
  Room,
  RoomAgent,
  InspectorSnapshot,
  ContextItem,
  FlowLogEntry,
  AgentTokenUsage,
  QueuedMessageEntry,
} from '../types';

function formatCompactTokens(n?: number | null): string {
  const val = Number(n || 0);
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 10_000) return `${(val / 1_000).toFixed(1)}k`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(2)}k`;
  return String(val);
}

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

  // Message Queue Panel State (实时消息列表 & 非实时消息列表)
  const [queuePanelOpen, setQueuePanelOpen] = useState(true);
  const [queueTab, setQueueTab] = useState<'all' | 'realtime' | 'normal'>('all');

  // 3-State Collapsible Session Log Blocks: 'default' (>10 lines collapsed, <=10 expanded) | 'collapsed' | 'expanded'
  const [collapseMode, setCollapseMode] = useState<'default' | 'collapsed' | 'expanded'>('default');
  const [manualCollapseOverrides, setManualCollapseOverrides] = useState<Record<string, boolean>>({});
  const [logFilter, setLogFilter] = useState<'all' | 'thought' | 'tool' | 'context'>('all');

  // Sticky Bottom Auto-Follow State for Inspector Log
  const [logPinnedToBottom, setLogPinnedToBottom] = useState(true);
  const logPinnedToBottomRef = useRef(true);
  const lastLogScrollTopRef = useRef(0);

  // Prompt Editor Local Form State
  const [roleDraft, setRoleDraft] = useState('');
  const [promptDraft, setPromptDraft] = useState('');

  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const flowScrollRef = useRef<HTMLDivElement | null>(null);

  const inspectedAgent = inspector?.agent || null;
  const items = inspector?.context?.effective_items || [];
  const realtimeQueue: QueuedMessageEntry[] =
    inspector?.message_queues?.realtime_messages || [];
  const normalQueue: QueuedMessageEntry[] =
    inspector?.message_queues?.normal_messages || [];
  const rtQueuedCount = realtimeQueue.filter((m) => m.status === 'queued').length;
  const normQueuedCount = normalQueue.filter((m) => m.status === 'queued').length;

  const scrollLogToBottom = () => {
    const el = logScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastLogScrollTopRef.current = el.scrollTop;
    logPinnedToBottomRef.current = true;
    setLogPinnedToBottom(true);
    requestAnimationFrame(() => {
      const cur = logScrollRef.current;
      if (cur && logPinnedToBottomRef.current) {
        cur.scrollTop = cur.scrollHeight;
        lastLogScrollTopRef.current = cur.scrollTop;
      }
    });
  };

  const handleLogScroll = () => {
    const el = logScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastLogScrollTopRef.current - 4;
    lastLogScrollTopRef.current = el.scrollTop;

    if (distanceFromBottom <= 48) {
      if (!logPinnedToBottomRef.current) {
        logPinnedToBottomRef.current = true;
        setLogPinnedToBottom(true);
      }
    } else if (scrolledUp) {
      if (logPinnedToBottomRef.current) {
        logPinnedToBottomRef.current = false;
        setLogPinnedToBottom(false);
      }
    }
  };

  // Reset sticky-bottom and overrides when switching agent or session
  useEffect(() => {
    setManualCollapseOverrides({});
    logPinnedToBottomRef.current = true;
    setLogPinnedToBottom(true);
    scrollLogToBottom();
  }, [inspectedAgent?.agent_id, inspector?.selected_session_id]);

  // Keep following bottom when new items or streaming buffers arrive
  useEffect(() => {
    if (logPinnedToBottomRef.current) {
      scrollLogToBottom();
    }
  }, [
    items.length,
    liveReasoningBuffer,
    liveStreamBuffer,
    logFilter,
    collapseMode,
    inspectorColumnOpen,
  ]);

  // MutationObserver + ResizeObserver to guarantee sticky bottom even when large blocks render asynchronously
  useEffect(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const snapIfPinned = () => {
      if (logPinnedToBottomRef.current && logScrollRef.current) {
        logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
        lastLogScrollTopRef.current = logScrollRef.current.scrollTop;
      }
    };
    const mo = new MutationObserver(snapIfPinned);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(snapIfPinned);
    ro.observe(el);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [inspectedAgent?.agent_id, inspector?.selected_session_id, inspectorColumnOpen]);

  useEffect(() => {
    if (rtQueuedCount + normQueuedCount > 0) {
      setQueuePanelOpen(true);
    }
  }, [rtQueuedCount, normQueuedCount]);

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

  const toggleBlockCollapse = (id: string, currentlyCollapsed: boolean) => {
    setManualCollapseOverrides((prev) => ({
      ...prev,
      [id]: !currentlyCollapsed,
    }));
  };

  const handleSelectCollapseMode = (mode: 'default' | 'collapsed' | 'expanded') => {
    setCollapseMode(mode);
    setManualCollapseOverrides({});
  };

  const renderRosterTokenSummary = (usage?: AgentTokenUsage) => {
    const u = usage || {
      current_context_tokens: 0,
      last_usage: null,
      total_usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
      },
      turn_count: 0,
    };
    const last = u.last_usage;
    const tot = u.total_usage;
    return (
      <div className="p-1.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono-code text-[10px] leading-snug space-y-0.5 text-[var(--text-secondary)]">
        <div className="flex items-center justify-between gap-1">
          <span>
            当前上下文:{' '}
            <strong className="text-[var(--text-primary)]">
              {formatCompactTokens(u.current_context_tokens)}
            </strong>
          </span>
          <span>
            累计:{' '}
            <strong className="text-[var(--text-primary)]">
              {formatCompactTokens(tot.total_tokens)}
            </strong>{' '}
            ({u.turn_count}轮)
          </span>
        </div>
        <div className="truncate text-[9.5px] text-[var(--text-muted)]" title={
          last
            ? `最近一次请求: ${last.input_tokens.toLocaleString()} (缓存: ${last.cached_tokens.toLocaleString()}) / 响应: ${last.output_tokens.toLocaleString()} (思考: ${last.reasoning_tokens.toLocaleString()})`
            : '尚无最近调用记录'
        }>
          最近: 请求 {formatCompactTokens(last?.input_tokens)}
          (缓{formatCompactTokens(last?.cached_tokens)}) · 响应{' '}
          {formatCompactTokens(last?.output_tokens)}
          (思{formatCompactTokens(last?.reasoning_tokens)})
        </div>
        <div className="truncate text-[9.5px] text-[var(--text-muted)]" title={
          `总请求: ${tot.input_tokens.toLocaleString()} (总缓存: ${tot.cached_tokens.toLocaleString()}) / 总响应: ${tot.output_tokens.toLocaleString()} (总思考: ${tot.reasoning_tokens.toLocaleString()})`
        }>
          总计: 请求 {formatCompactTokens(tot.input_tokens)}
          (缓{formatCompactTokens(tot.cached_tokens)}) · 响应{' '}
          {formatCompactTokens(tot.output_tokens)}
          (思{formatCompactTokens(tot.reasoning_tokens)})
        </div>
      </div>
    );
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
              className={`p-2 rounded-xl border border-dashed cursor-pointer transition-all space-y-1.5 ${
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
                  className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] border border-[var(--border-subtle)] flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <Settings className="w-2.5 h-2.5" />
                  <span>设置</span>
                </button>
              </div>
              <div className="text-[10.5px] text-[var(--text-muted)] font-mono-code flex items-center justify-between gap-1">
                <span className="truncate">{managerAgent.model}</span>
                <span className="shrink-0">
                  #{managerAgent.last_delivered_seq}/#{roomLastSeq}
                </span>
              </div>
              {renderRosterTokenSummary(managerAgent.token_usage)}
            </div>
          )}

          {/* Working Agent Cards (Simplified + Token Usage) */}
          {agents.map((a, idx) => {
            const isSelected =
              inspectedAgent?.agent_id === a.agent_id && inspectorColumnOpen;
            const unread = Math.max(0, roomLastSeq - (a.last_delivered_seq || 0));
            const activity = agentActivities[a.agent_id] || '';
            return (
              <div
                key={a.agent_id}
                onClick={() => onSelectAgent(a.agent_id)}
                className={`p-2 rounded-xl border cursor-pointer transition-all space-y-1.5 ${
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
                      <span className="px-1.5 py-0.2 rounded bg-blue-500/12 text-blue-600 dark:text-blue-400 text-[9.5px] font-medium inline-flex items-center gap-0.5 shrink-0">
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

                <div className="flex items-center justify-between gap-1.5 text-[10.5px] text-[var(--text-muted)]">
                  <span className="truncate font-mono-code text-[var(--text-secondary)]">
                    {a.model}
                  </span>
                  <span className="shrink-0 font-mono-code">
                    {a.runtime_state === 'thinking'
                      ? '🔵思考'
                      : a.runtime_state === 'waiting_permission'
                      ? '🟠待批'
                      : '🟢空闲'}{' '}
                    · #{a.last_delivered_seq}/#{roomLastSeq}
                    {unread > 0 ? `(+${unread})` : ''}
                  </span>
                </div>

                {renderRosterTokenSummary(a.token_usage)}

                {activity && (
                  <div className="text-[10.5px] text-blue-500 font-medium truncate">
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
                      <span>System Prompt (四段式)</span>
                      <Unlock className="w-2.5 h-2.5 text-emerald-500" />
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

                {/* Tab 2: 4-Segment System Prompt & Role Editor */}
                {activeConfigTab === 'prompt' && (
                  <div className="p-2.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[11.5px] text-[var(--text-primary)]">
                        [3. Client Prompt] 角色头衔与人设提示词
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                        🟢 随时可修改 (下轮生效)
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[var(--text-muted)] shrink-0">
                        头衔:
                      </span>
                      <input
                        type="text"
                        value={roleDraft}
                        onChange={(e) => setRoleDraft(e.target.value)}
                        className="flex-1 px-2 py-1 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs"
                      />
                    </div>

                    <textarea
                      rows={3}
                      value={promptDraft}
                      onChange={(e) => setPromptDraft(e.target.value)}
                      className="w-full p-2 rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono-code text-[11.5px] leading-relaxed resize-y"
                    />

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
                        <span>保存 Client Prompt 修改</span>
                      </button>
                    </div>

                    {inspector?.session?.status?.latest_prompt_parts && (
                      <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5 text-[11px]">
                        <div className="font-semibold text-[var(--text-secondary)]">
                          四段式 System Prompt 实时快照 (api-server SSOT)
                        </div>
                        {inspector.session.status.latest_prompt_parts.system_prompt && (
                          <details className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2">
                            <summary className="cursor-pointer font-medium text-[var(--text-primary)]">
                              [1. system_prompt] 集群系统级指令
                            </summary>
                            <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono-code text-[10.5px] text-[var(--text-secondary)]">
                              {inspector.session.status.latest_prompt_parts.system_prompt}
                            </pre>
                          </details>
                        )}
                        {inspector.session.status.latest_prompt_parts.node_prompt && (
                          <details className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2">
                            <summary className="cursor-pointer font-medium text-[var(--text-primary)]">
                              [2. node_prompt] 节点环境指令
                            </summary>
                            <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono-code text-[10.5px] text-[var(--text-secondary)]">
                              {inspector.session.status.latest_prompt_parts.node_prompt}
                            </pre>
                          </details>
                        )}
                        {Object.entries(
                          inspector.session.status.latest_prompt_parts.extension_prompts || {}
                        ).map(([extId, extPrompt]) => (
                          <details
                            key={extId}
                            className="rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-2"
                          >
                            <summary className="cursor-pointer font-medium text-[var(--text-primary)]">
                              [4. extension_prompts.{extId}] 插件追加指令
                            </summary>
                            <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono-code text-[10.5px] text-[var(--text-secondary)]">
                              {extPrompt}
                            </pre>
                          </details>
                        ))}
                        {inspector.session.status.effective_tools &&
                          inspector.session.status.effective_tools.length > 0 && (
                            <div className="text-[10.5px] text-[var(--text-muted)] pt-0.5">
                              当前生效工具 ({inspector.session.status.effective_tools.length}):{' '}
                              <span className="font-mono-code text-[var(--text-secondary)]">
                                {inspector.session.status.effective_tools.join(', ')}
                              </span>
                            </div>
                          )}
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
                TOKEN USAGE & MESSAGE QUEUES BAR IN INSPECTOR
                =============================================================== */}
            {(() => {
              const u = inspectedAgent.token_usage || {
                current_context_tokens: 0,
                last_usage: null,
                total_usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  total_tokens: 0,
                  cached_tokens: 0,
                  reasoning_tokens: 0,
                },
                turn_count: 0,
              };
              const last = u.last_usage;
              const tot = u.total_usage;
              const filteredQueueEntries =
                queueTab === 'realtime'
                  ? realtimeQueue
                  : queueTab === 'normal'
                  ? normalQueue
                  : [...realtimeQueue, ...normalQueue].sort(
                      (a, b) => a.msg_seq - b.msg_seq
                    );

              return (
                <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] space-y-2 shrink-0 text-[11px]">
                  {/* Token Usage Detailed Breakdown */}
                  <div className="p-2 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code space-y-1 text-[10.5px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[var(--text-secondary)]">
                        当前上下文 Token:{' '}
                        <strong className="text-emerald-600 dark:text-emerald-400 text-[11.5px]">
                          {(u.current_context_tokens || 0).toLocaleString()}
                        </strong>
                      </span>
                      <span className="text-[var(--text-muted)]">
                        已完成调用: <strong className="text-[var(--text-primary)]">{u.turn_count}</strong> 轮 · 累计总计:{' '}
                        <strong className="text-[var(--text-primary)]">
                          {(tot.total_tokens || 0).toLocaleString()}
                        </strong>
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-0.5 pt-1 border-t border-[var(--border-subtle)] text-[10px]">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-[var(--text-muted)]">最近单次:</span>
                        {last ? (
                          <span className="text-[var(--text-secondary)]">
                            请求 <strong className="text-[var(--text-primary)]">{last.input_tokens.toLocaleString()}</strong>
                            <span className="text-cyan-600 dark:text-cyan-400"> (缓存 {last.cached_tokens.toLocaleString()})</span>
                            {' · '}响应 <strong className="text-[var(--text-primary)]">{last.output_tokens.toLocaleString()}</strong>
                            <span className="text-violet-600 dark:text-violet-400"> (思考 {last.reasoning_tokens.toLocaleString()})</span>
                            {' · '}合 <strong className="text-[var(--text-primary)]">{last.total_tokens.toLocaleString()}</strong>
                          </span>
                        ) : (
                          <span className="text-[var(--text-muted)]">暂无记录</span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-[var(--text-muted)]">累计总计:</span>
                        <span className="text-[var(--text-secondary)]">
                          请求 <strong className="text-[var(--text-primary)]">{tot.input_tokens.toLocaleString()}</strong>
                          <span className="text-cyan-600 dark:text-cyan-400"> (缓存 {tot.cached_tokens.toLocaleString()})</span>
                          {' · '}响应 <strong className="text-[var(--text-primary)]">{tot.output_tokens.toLocaleString()}</strong>
                          <span className="text-violet-600 dark:text-violet-400"> (思考 {tot.reasoning_tokens.toLocaleString()})</span>
                          {' · '}总 <strong className="text-[var(--text-primary)]">{tot.total_tokens.toLocaleString()}</strong>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Realtime & Non-Realtime Message Queue Status Section */}
                  <div className="rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] overflow-hidden">
                    <div
                      onClick={() => setQueuePanelOpen(!queuePanelOpen)}
                      className="px-2.5 py-1.5 flex items-center justify-between gap-1.5 cursor-pointer hover:bg-[var(--bg-hover)]"
                    >
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="font-semibold text-[var(--text-primary)] text-[11px]">
                          消息队列状态
                        </span>
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setQueueTab('realtime');
                            setQueuePanelOpen(true);
                          }}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[10px] font-medium cursor-pointer border ${
                            rtQueuedCount > 0
                              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40 animate-pulse'
                              : queueTab === 'realtime'
                              ? 'bg-[var(--bg-active)] text-[var(--text-primary)] border-[var(--border-default)]'
                              : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-subtle)]'
                          }`}
                        >
                          <Zap className="w-2.5 h-2.5 text-amber-500" />
                          <span>
                            实时: 排队 {rtQueuedCount} / 已读{' '}
                            {realtimeQueue.length - rtQueuedCount}
                          </span>
                        </span>
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            setQueueTab('normal');
                            setQueuePanelOpen(true);
                          }}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[10px] font-medium cursor-pointer border ${
                            normQueuedCount > 0
                              ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/40 animate-pulse'
                              : queueTab === 'normal'
                              ? 'bg-[var(--bg-active)] text-[var(--text-primary)] border-[var(--border-default)]'
                              : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-subtle)]'
                          }`}
                        >
                          <Clock className="w-2.5 h-2.5 text-blue-500" />
                          <span>
                            非实时: 排队 {normQueuedCount} / 已读{' '}
                            {normalQueue.length - normQueuedCount}
                          </span>
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {queuePanelOpen && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setQueueTab('all');
                            }}
                            className={`px-1.5 py-0.2 rounded text-[10px] cursor-pointer ${
                              queueTab === 'all'
                                ? 'bg-[var(--bg-active)] text-[var(--text-primary)] font-semibold'
                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                            }`}
                          >
                            全部
                          </button>
                        )}
                        {queuePanelOpen ? (
                          <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        )}
                      </div>
                    </div>

                    {queuePanelOpen && (
                      <div className="px-2.5 pb-2 pt-1 border-t border-[var(--border-subtle)] max-h-[150px] overflow-y-auto space-y-1">
                        {filteredQueueEntries.length === 0 ? (
                          <div className="py-2 text-center text-[10.5px] text-[var(--text-muted)]">
                            暂无{queueTab === 'realtime' ? '实时' : queueTab === 'normal' ? '非实时' : ''}消息记录
                          </div>
                        ) : (
                          filteredQueueEntries.map((entry) => {
                            const isQueued = entry.status === 'queued';
                            return (
                              <div
                                key={`${entry.is_realtime ? 'rt' : 'norm'}-${entry.msg_seq}`}
                                className={`p-1.5 rounded-lg border text-[10.5px] space-y-0.5 ${
                                  isQueued
                                    ? 'bg-amber-500/10 border-amber-500/40'
                                    : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] opacity-85'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1.5">
                                  <div className="flex items-center gap-1 min-w-0">
                                    <span className="font-mono-code font-semibold text-[var(--text-primary)]">
                                      #{entry.msg_seq}
                                    </span>
                                    <span className="font-medium text-[var(--text-secondary)] truncate">
                                      @{entry.sender_name}
                                    </span>
                                    {entry.is_realtime ? (
                                      <span className="inline-flex items-center gap-0.5 px-1 py-0.1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[9.5px] font-medium">
                                        <Zap className="w-2.5 h-2.5" />
                                        实时
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-0.5 px-1 py-0.1 rounded bg-[var(--bg-main)] text-[var(--text-muted)] text-[9.5px] font-medium">
                                        <Clock className="w-2.5 h-2.5" />
                                        非实时
                                      </span>
                                    )}
                                  </div>

                                  <span
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[9.5px] font-semibold shrink-0 ${
                                      isQueued
                                        ? 'bg-amber-500 text-black'
                                        : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                    }`}
                                  >
                                    {isQueued ? (
                                      <span className="w-1.5 h-1.5 rounded-full bg-black animate-ping" />
                                    ) : (
                                      <CheckCircle2 className="w-2.5 h-2.5" />
                                    )}
                                    <span>{entry.status_label}</span>
                                  </span>
                                </div>

                                <div className="text-[11px] text-[var(--text-primary)] break-words line-clamp-2 font-sans">
                                  {entry.content}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* ===============================================================
                SESSION CONTENT STREAM FILTER BAR + FULL-HEIGHT SCROLLABLE LOG
                =============================================================== */}
            <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 text-[11px] shrink-0 bg-[var(--bg-sidebar)]">
              <div className="flex items-center gap-1 overflow-x-auto">
                {[
                  { key: 'all', label: `全部 (${items.length})` },
                  { key: 'thought', label: '💭 思考' },
                  { key: 'tool', label: '🔧 工具' },
                  { key: 'context', label: '📥 上下文' },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setLogFilter(tab.key as typeof logFilter)}
                    className={`px-2 py-0.5 rounded-md font-medium cursor-pointer transition-colors whitespace-nowrap ${
                      logFilter === tab.key
                        ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* 3-State Collapse Mode Selector: 默认 (>10行折叠) | 全部折叠 | 全部展开 */}
              <div
                className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] shrink-0"
                title="折叠模式：默认（内容超过10行折叠，≤10行展开） / 全部折叠 / 全部展开"
              >
                <ChevronsUpDown className="w-3 h-3 text-[var(--text-muted)] ml-1 shrink-0" />
                {[
                  { key: 'default', label: '默认', tip: '超过 10 行折叠，≤10 行展开' },
                  { key: 'collapsed', label: '全折', tip: '全部折叠' },
                  { key: 'expanded', label: '全展', tip: '全部展开' },
                ].map((m) => (
                  <button
                    key={m.key}
                    onClick={() =>
                      handleSelectCollapseMode(
                        m.key as 'default' | 'collapsed' | 'expanded'
                      )
                    }
                    title={m.tip}
                    className={`px-1.5 py-0.5 rounded text-[10.5px] font-medium cursor-pointer transition-colors whitespace-nowrap ${
                      collapseMode === m.key &&
                      Object.keys(manualCollapseOverrides).length === 0
                        ? 'bg-[var(--bg-main)] text-[var(--text-primary)] shadow-2xs'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Full-Height Scrollable Session Content Preview */}
            <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">
              <div
                ref={logScrollRef}
                onScroll={handleLogScroll}
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

                    const lineCount = bodyContent
                      ? bodyContent.split(/\r?\n/).length
                      : 0;
                    const defaultCollapsed = lineCount > 10;
                    const isCollapsed =
                      blockId in manualCollapseOverrides
                        ? manualCollapseOverrides[blockId]
                        : collapseMode === 'collapsed'
                        ? true
                        : collapseMode === 'expanded'
                        ? false
                        : defaultCollapsed;

                    return (
                      <div
                        key={blockId}
                        className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden"
                      >
                        <div
                          onClick={() => toggleBlockCollapse(blockId, isCollapsed)}
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
                          <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                            {lineCount}行
                          </span>
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

              {/* Floating Jump-to-Bottom Pill in Inspector */}
              {!logPinnedToBottom && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
                  <button
                    onClick={scrollLogToBottom}
                    className="px-3 py-1 rounded-full bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-default)] shadow-md text-[11px] font-medium flex items-center gap-1 cursor-pointer hover:bg-[var(--bg-surface)]"
                  >
                    <ArrowDown className="w-3 h-3" />
                    <span>回到最新底部</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
};
