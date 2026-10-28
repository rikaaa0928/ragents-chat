import React, { useState } from 'react';
import {
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  SquarePen,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Play,
  Trash2,
  FolderGit2,
  Eye,
  EyeOff,
  Users,
  Info,
  X,
  Compass,
  Server,
  Globe,
  FolderOpen,
} from 'lucide-react';
import { Room, RoomAgent, ClusterNode, UiContribution } from '../types';

interface TopHeaderProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenCreateRoom: () => void;
  room: Room | null;
  agents: RoomAgent[];
  clusterNodes: ClusterNode[];
  inspectedAgent: RoomAgent | null;
  flowLogCount: number;
  peekStatusBanner: string;
  rightColumnContributions?: UiContribution[];
  activeExtRightColumnId?: string | null;
  onToggleExtRightColumn?: (id: string) => void;
  flowColumnOpen: boolean;
  onToggleFlowColumn: () => void;
  rosterColumnOpen: boolean;
  onToggleRosterColumn: () => void;
  inspectorColumnOpen: boolean;
  onToggleInspectorColumn: () => void;
  onUpdateRoomControls: (patch: Partial<Room>) => void;
  onResumeRelay: () => void;
  onDeleteRoom: () => void;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenCreateRoom,
  room,
  agents,
  clusterNodes,
  inspectedAgent,
  flowLogCount,
  peekStatusBanner,
  rightColumnContributions = [],
  activeExtRightColumnId = null,
  onToggleExtRightColumn,
  flowColumnOpen,
  onToggleFlowColumn,
  rosterColumnOpen,
  onToggleRosterColumn,
  inspectorColumnOpen,
  onToggleInspectorColumn,
  onUpdateRoomControls,
  onResumeRelay,
  onDeleteRoom,
}) => {
  // Collapsible drawers state (collapsed by default for clean Codex aesthetic!)
  const [roomInfoOpen, setRoomInfoOpen] = useState(false);
  const [peekConfigOpen, setPeekConfigOpen] = useState(false);

  if (!room) {
    return (
      <header className="h-[52px] px-4 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-main)]">
        <div className="flex items-center gap-2">
          {sidebarCollapsed && (
            <button
              onClick={onToggleSidebar}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <PanelLeftOpen className="w-[18px] h-[18px]" />
            </button>
          )}
          <span className="text-sm font-medium text-[var(--text-secondary)]">
            请选择或新建聊天室
          </span>
        </div>
      </header>
    );
  }

  const isRelayPaused =
    room.max_agent_relay_depth > 0 &&
    room.consecutive_agent_msgs >= room.max_agent_relay_depth;
  const pendingPermCount = agents.filter(
    (a) => a.runtime_state === 'waiting_permission'
  ).length;
  const thinkingCount = agents.filter((a) => a.runtime_state === 'thinking').length;

  const roomNodeId =
    room.node_id ||
    agents.find((a) => a.scheduling?.mode === 'pinned' && a.scheduling?.node_id)
      ?.scheduling?.node_id ||
    null;
  const roomWorkspacePath =
    room.workspace_path ||
    agents.find(
      (a) => a.scheduling?.mode === 'pinned' && a.scheduling?.workspace_path
    )?.scheduling?.workspace_path ||
    null;
  const roomNodeDetail = roomNodeId
    ? clusterNodes.find((n) => n.metadata.id === roomNodeId) || null
    : null;
  const isRoomNodeReady = roomNodeDetail
    ? roomNodeDetail.status.phase === 'ready'
    : true;

  return (
    <div className="shrink-0 bg-[var(--bg-main)] border-b border-[var(--border-subtle)] z-20">
      {/* Primary Codex Top Bar */}
      <header className="h-[52px] px-3 flex items-center justify-between gap-2 overflow-hidden">
        {/* Left: Sidebar Trigger (when collapsed) + Room Title Popover Trigger + Live Badges */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          {sidebarCollapsed && (
            <div className="flex items-center gap-1 mr-0.5 shrink-0">
              <button
                onClick={onToggleSidebar}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                title="展开侧边栏"
              >
                <PanelLeftOpen className="w-[18px] h-[18px]" />
              </button>
              <button
                onClick={onOpenCreateRoom}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                title="新建聊天室"
              >
                <SquarePen className="w-[17px] h-[17px]" />
              </button>
            </div>
          )}

          {/* Room Selector / Info Trigger (Codex Model Picker Style) */}
          <button
            onClick={() => setRoomInfoOpen(!roomInfoOpen)}
            className={`px-2 py-1.5 rounded-lg flex items-center gap-1.5 text-[13.5px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer min-w-0 max-w-full overflow-hidden ${
              roomInfoOpen ? 'bg-[var(--bg-active)]' : ''
            }`}
            title="点击展开/收起聊天室基础信息（节点、工作目录、成员调度）"
          >
            <span className="truncate min-w-0">{room.name}</span>
            <span
              className={`text-[10.5px] px-1.5 py-0.5 rounded-full font-medium shrink-0 whitespace-nowrap ${
                agents.length <= 1
                  ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                  : 'bg-violet-500/12 text-violet-600 dark:text-violet-400'
              }`}
            >
              {agents.length <= 1 ? '单聊' : `群聊 · ${agents.length}`}
            </span>
            {roomNodeId ? (
              <span
                className={`hidden sm:inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded-md font-mono-code font-normal shrink-0 whitespace-nowrap ${
                  isRoomNodeReady
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 animate-pulse'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isRoomNodeReady ? 'bg-emerald-500' : 'bg-rose-500'
                  }`}
                />
                <Server className="w-3 h-3 shrink-0" />
                <span>{roomNodeId}</span>
                {!isRoomNodeReady && <span className="font-semibold">· 断联</span>}
              </span>
            ) : (
              <span className="hidden sm:inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] text-[var(--text-muted)] font-mono-code font-normal shrink-0 whitespace-nowrap">
                <Globe className="w-3 h-3 shrink-0" />
                <span>Floating</span>
              </span>
            )}
            {roomInfoOpen ? (
              <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
            )}
          </button>

          {/* Relay Limit Reached Resume Button */}
          {isRelayPaused && (
            <button
              onClick={onResumeRelay}
              className="px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 flex items-center gap-1 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>继续讨论</span>
            </button>
          )}

          {/* Live Transient Status Pill */}
          {peekStatusBanner && (
            <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-300 text-xs font-medium max-w-[260px] truncate shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-ping shrink-0" />
              <span className="truncate">{peekStatusBanner}</span>
            </div>
          )}
        </div>

        {/* Right: Expandable Component Toggle Pills */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 0. Toggle Room Basic Info Drawer */}
          <button
            onClick={() => setRoomInfoOpen(!roomInfoOpen)}
            className={`h-8 px-2 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              roomInfoOpen
                ? 'bg-[var(--bg-active)] border-[var(--border-default)] text-[var(--text-primary)]'
                : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
            title="查看当前聊天室基础信息（所在节点、工作目录、调度状态）"
          >
            <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span className="hidden lg:inline">房间信息</span>
          </button>

          {/* 1. Toggle Peek & Turn-Taking Config Drawer */}
          <button
            onClick={() => setPeekConfigOpen(!peekConfigOpen)}
            className={`h-8 px-2 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              peekConfigOpen
                ? 'bg-[var(--bg-active)] border-[var(--border-default)] text-[var(--text-primary)]'
                : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
            title="展开/隐藏 空闲窥屏与概率插话配置组件"
          >
            {room.peek_enabled ? (
              <Eye className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            ) : (
              <EyeOff className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
            )}
            <span className="hidden lg:inline">窥屏配置</span>
            <span className="text-[11px] text-[var(--text-muted)]">
              {room.peek_enabled ? `${room.peek_idle_secs}s` : '已关'}
            </span>
            {peekConfigOpen ? (
              <ChevronUp className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
            ) : (
              <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
            )}
          </button>

          {/* 1b. Extension Right Columns (e.g. 📁 文件穿透) */}
          {rightColumnContributions.map((contrib) => {
            const isOpen = activeExtRightColumnId === contrib.id;
            return (
              <button
                key={contrib.id}
                onClick={() => onToggleExtRightColumn?.(contrib.id)}
                className={`h-8 px-2 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  isOpen
                    ? 'bg-[var(--bg-active)] border-[var(--border-default)] text-[var(--text-primary)]'
                    : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
                title={`展开/隐藏 ${contrib.title} 竖列`}
              >
                <FolderOpen className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span className="hidden lg:inline">{contrib.title}</span>
              </button>
            );
          })}

          {/* 2. Toggle Flow Trace Vertical Column (右侧流程轨迹竖列 - 默认不打开) */}
          <button
            onClick={onToggleFlowColumn}
            className={`h-8 px-2 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              flowColumnOpen
                ? 'bg-[var(--bg-active)] border-[var(--border-default)] text-[var(--text-primary)]'
                : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
            title="展开/隐藏 右侧流程轨迹竖列"
          >
            <Compass className="w-3.5 h-3.5 text-violet-500 shrink-0" />
            <span className="hidden lg:inline">流程轨迹</span>
            <span className="px-1.5 py-0.2 rounded-full bg-[var(--bg-surface)] text-[10.5px] text-[var(--text-secondary)]">
              {flowLogCount}
            </span>
          </button>

          {/* 3. Toggle Roster Vertical Column (群成员竖列) */}
          <button
            onClick={onToggleRosterColumn}
            className={`h-8 px-2 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              rosterColumnOpen
                ? 'bg-[var(--bg-active)] border-[var(--border-default)] text-[var(--text-primary)]'
                : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
            title="展开/隐藏 群成员竖列"
          >
            <Users className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span className="hidden lg:inline">群成员</span>
            <span className="px-1.5 py-0.2 rounded-full bg-[var(--bg-surface)] text-[10.5px] text-[var(--text-secondary)]">
              {agents.length}
            </span>
          </button>

          {/* 4. Toggle Specific Agent Inspector Vertical Column (具体 Agent 透视竖列) */}
          <button
            onClick={onToggleInspectorColumn}
            className={`h-8 px-2.5 rounded-lg text-xs font-medium flex items-center gap-1.5 border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              inspectorColumnOpen
                ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] border-transparent'
                : 'bg-transparent border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            }`}
            title="单独展开/隐藏 具体 Agent Session 透视竖列"
          >
            {pendingPermCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-black text-[10px] font-bold animate-pulse">
                ⚠️ {pendingPermCount}
              </span>
            )}
            {pendingPermCount === 0 && thinkingCount > 0 && (
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping shrink-0" />
            )}
            <span className="hidden md:inline">
              {inspectedAgent ? `透视 @${inspectedAgent.name}` : '透视'}
            </span>
            {inspectorColumnOpen ? (
              <PanelRightClose className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <PanelRightOpen className="w-3.5 h-3.5 shrink-0" />
            )}
          </button>
        </div>
      </header>

      {/* Node Disconnected / Reconnect Grace Period Alert Banner */}
      {roomNodeId && roomNodeDetail && !isRoomNodeReady && (
        <div className="px-4 py-1.5 bg-amber-500/15 border-t border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0" />
            <span className="font-medium truncate">
              ⚠️ 节点 <code className="font-mono-code font-semibold">{roomNodeId}</code> 当前网络断联 ({roomNodeDetail.status.phase}) — 运行中的任务处于 5 分钟断网重连宽限期，节点重连后将自动无缝继续执行。
            </span>
          </div>
          <span className="text-[11px] font-mono-code shrink-0 opacity-80">
            上次心跳: {roomNodeDetail.status.last_heartbeat_at ? new Date(roomNodeDetail.status.last_heartbeat_at).toLocaleTimeString() : '未知'}
          </span>
        </div>
      )}

      {/* Collapsible Drawer A: Room Basic Info & Node / Workspace Details */}
      {roomInfoOpen && (
        <div className="px-4 py-3 bg-[var(--bg-sidebar)] border-t border-[var(--border-subtle)] text-xs space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 text-[var(--text-secondary)] min-w-0">
              <span className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                <span>聊天室基础信息</span>
              </span>
              <span className="text-[11px] font-mono-code px-2 py-0.5 rounded-md bg-[var(--bg-surface)] text-[var(--text-muted)]">
                ID: {room.room_id}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                名册 v{room.roster_version} · 消息 #{room.last_msg_seq}
              </span>
              {room.created_at && (
                <span className="text-[11px] text-[var(--text-muted)]">
                  创建于 {new Date(room.created_at).toLocaleString()}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={onDeleteRoom}
                className="px-2.5 py-1 rounded-md text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>删除房间</span>
              </button>
              <button
                onClick={() => setRoomInfoOpen(false)}
                className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Node & Workspace Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            <div className="p-2.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-1">
              <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
                <Server className="w-3 h-3 text-blue-500" />
                <span>所在节点 (Node)</span>
              </div>
              {roomNodeId ? (
                <div className="flex items-center flex-wrap gap-1.5">
                  <span className="font-mono-code font-semibold text-[var(--text-primary)]">
                    {roomNodeId}
                  </span>
                  {roomNodeDetail && (
                    <span className="text-[10.5px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono-code">
                      {roomNodeDetail.status.os}/{roomNodeDetail.status.arch} · {roomNodeDetail.status.phase}
                    </span>
                  )}
                </div>
              ) : (
                <div className="font-mono-code text-[var(--text-secondary)]">
                  Floating (未固定节点 / 浮动调度)
                </div>
              )}
            </div>

            <div className="p-2.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-1 md:col-span-2">
              <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
                <FolderGit2 className="w-3 h-3 text-emerald-500" />
                <span>工作区目录 (Workspace Directory)</span>
              </div>
              <div className="font-mono-code text-[var(--text-primary)] break-all">
                {roomWorkspacePath || '未绑定固定目录（按节点默认临时目录动态隔离）'}
              </div>
            </div>
          </div>

          {room.description && (
            <div className="text-[11.5px] text-[var(--text-secondary)] px-1">
              描述：{room.description}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Drawer B: Real-time Peek & Turn-Taking Interjection Config */}
      {peekConfigOpen && (
        <div className="px-4 py-3 bg-[var(--bg-sidebar)] border-t border-[var(--border-subtle)] text-xs">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
              <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-500" />
                <span>空闲窥屏与概率插话机制</span>
              </div>

              {/* Toggle 1: Enable Peek */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={room.peek_enabled}
                  onChange={(e) =>
                    onUpdateRoomControls({ peek_enabled: e.target.checked })
                  }
                  className="w-3.5 h-3.5 accent-emerald-600 rounded cursor-pointer"
                />
                <span className="font-medium text-[var(--text-primary)]">
                  开启空闲窥屏
                </span>
              </label>

              {/* Idle Secs */}
              <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                <span>静默触发</span>
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={room.peek_idle_secs}
                  onChange={(e) =>
                    onUpdateRoomControls({
                      peek_idle_secs: Math.max(1, parseInt(e.target.value || '2', 10)),
                    })
                  }
                  className="w-14 px-2 py-1 text-center rounded-md bg-[var(--bg-main)] border border-[var(--border-default)] text-xs font-mono-code"
                />
                <span>秒</span>
              </label>

              {/* Msg Interval */}
              <label className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                <span>轮次间隔</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={room.peek_msg_interval}
                  onChange={(e) =>
                    onUpdateRoomControls({
                      peek_msg_interval: Math.max(1, parseInt(e.target.value || '1', 10)),
                    })
                  }
                  className="w-14 px-2 py-1 text-center rounded-md bg-[var(--bg-main)] border border-[var(--border-default)] text-xs font-mono-code"
                />
                <span>条</span>
              </label>

              {/* Toggle 2: Allow Interject */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={room.interject_enabled}
                  onChange={(e) =>
                    onUpdateRoomControls({ interject_enabled: e.target.checked })
                  }
                  className="w-3.5 h-3.5 accent-emerald-600 rounded cursor-pointer"
                />
                <span className="font-medium text-[var(--text-primary)]">
                  允许主动插话
                </span>
              </label>

              {/* Mute Probability */}
              <label
                className="flex items-center gap-2 text-[var(--text-secondary)]"
                title="每次窥屏为各空闲 Agent 生成 0~100 随机数，低于禁言概率的本轮只读禁言，高于的从高到低依次唤醒"
              >
                <span>禁言率</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={room.mute_probability}
                  onChange={(e) =>
                    onUpdateRoomControls({
                      mute_probability: parseInt(e.target.value || '40', 10),
                    })
                  }
                  className="w-20 accent-violet-500 cursor-pointer"
                />
                <span className="font-mono-code font-semibold text-[var(--text-primary)] w-9">
                  {room.mute_probability}%
                </span>
              </label>

              {/* Max Relay Depth */}
              <label
                className="flex items-center gap-1.5 text-[var(--text-secondary)]"
                title="Agent 连续发言接力上限轮数，设为 0 表示不限制"
              >
                <span>接力上限</span>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={room.max_agent_relay_depth}
                  onChange={(e) =>
                    onUpdateRoomControls({
                      max_agent_relay_depth: Math.max(
                        0,
                        parseInt(e.target.value || '0', 10)
                      ),
                    })
                  }
                  className="w-14 px-2 py-1 text-center rounded-md bg-[var(--bg-main)] border border-[var(--border-default)] text-xs font-mono-code"
                />
                <span>轮 (0=∞)</span>
              </label>
            </div>

            <button
              onClick={() => setPeekConfigOpen(false)}
              className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              title="收起面板"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
