import React, { useState, useMemo } from 'react';
import {
  PanelLeftClose,
  SquarePen,
  Hash,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Settings,
  Sun,
  Moon,
  FolderGit2,
  Globe,
  Plus,
  MoreHorizontal,
  KeyRound,
  LogOut,
} from 'lucide-react';
import {
  RoomListItem,
  ClusterNode,
  CreateRoomPreset,
  ChatPrincipal,
  UiContribution,
} from '../types';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  rooms: RoomListItem[];
  clusterNodes: ClusterNode[];
  currentRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onOpenCreateRoom: (preset?: CreateRoomPreset) => void;
  onOpenManagerSettings: () => void;
  principal?: ChatPrincipal | null;
  authRequired?: boolean;
  footerContributions?: UiContribution[];
  onOpenExtensionModal?: (contrib: UiContribution) => void;
  onLogout?: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

interface RoomGroup {
  key: string;
  isFloating: boolean;
  nodeId: string | null;
  workspacePath: string | null;
  displayTitle: string;
  displaySubPath: string | null;
  isOnline: boolean;
  latestTimestamp: number;
  rooms: RoomListItem[];
}

const MAX_VISIBLE_ROOMS_PER_GROUP = 5;

function normalizeGroupWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\/+$/, '') || '/';
  const autoRoomMatch = /^(.+)\/chatroom-room_[0-9a-f-]+$/i.exec(trimmed);
  if (autoRoomMatch) {
    const parent = autoRoomMatch[1] || '/';
    return parent === '/private/tmp' ? '/tmp' : parent;
  }
  return trimmed === '/private/tmp' ? '/tmp' : trimmed;
}

function getRoomTimestamp(item: RoomListItem): number {
  const raw =
    item.last_message?.created_at ||
    item.room.updated_at ||
    item.room.created_at ||
    '';
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export const Sidebar: React.FC<SidebarProps> = ({
  collapsed,
  onToggleCollapse,
  rooms,
  clusterNodes,
  currentRoomId,
  onSelectRoom,
  onOpenCreateRoom,
  onOpenManagerSettings,
  principal,
  authRequired,
  footerContributions = [],
  onOpenExtensionModal,
  onLogout,
  theme,
  onToggleTheme,
}) => {
  const [roomsSectionOpen, setRoomsSectionOpen] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showAllInGroup, setShowAllInGroup] = useState<Record<string, boolean>>({});

  const groupedRooms = useMemo<RoomGroup[]>(() => {
    const map = new Map<string, RoomGroup>();

    for (const item of rooms) {
      const pinnedAgent = item.agents.find(
        (a) =>
          a.scheduling?.mode === 'pinned' &&
          (a.scheduling?.node_id || a.scheduling?.workspace_path)
      );
      const rawNodeId = item.room.node_id || pinnedAgent?.scheduling?.node_id || null;
      const rawWorkspacePath =
        item.room.workspace_path || pinnedAgent?.scheduling?.workspace_path || null;

      if (!rawNodeId) {
        const key = '__floating__';
        let grp = map.get(key);
        if (!grp) {
          grp = {
            key,
            isFloating: true,
            nodeId: null,
            workspacePath: null,
            displayTitle: '浮动聊天室',
            displaySubPath: 'Floating',
            isOnline: true,
            latestTimestamp: 0,
            rooms: [],
          };
          map.set(key, grp);
        }
        grp.rooms.push(item);
      } else {
        const normPath = normalizeGroupWorkspacePath(rawWorkspacePath || '/tmp');
        const key = `${rawNodeId}:${normPath}`;
        let grp = map.get(key);
        if (!grp) {
          const nodeObj = clusterNodes.find((n) => n.metadata.id === rawNodeId);
          const isOnline = Boolean(nodeObj && nodeObj.status.phase === 'ready');
          grp = {
            key,
            isFloating: false,
            nodeId: rawNodeId,
            workspacePath: normPath,
            displayTitle: `${rawNodeId}:${normPath}`,
            displaySubPath: normPath,
            isOnline,
            latestTimestamp: 0,
            rooms: [],
          };
          map.set(key, grp);
        }
        grp.rooms.push(item);
      }
    }

    const list = Array.from(map.values());
    for (const grp of list) {
      // Sort level-2 rooms by time descending (newest first)
      grp.rooms.sort((a, b) => getRoomTimestamp(b) - getRoomTimestamp(a));
      grp.latestTimestamp = grp.rooms.reduce(
        (max, r) => Math.max(max, getRoomTimestamp(r)),
        0
      );
    }

    // Sort level-1 groups:
    // 1. Online groups (and Floating) first, offline node groups pushed to the end
    // 2. Within same online status, sort by latestTimestamp descending
    list.sort((a, b) => {
      if (a.isOnline !== b.isOnline) {
        return a.isOnline ? -1 : 1;
      }
      return b.latestTimestamp - a.latestTimestamp;
    });

    return list;
  }, [rooms, clusterNodes]);

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleShowMore = (key: string) => {
    setShowAllInGroup((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <aside
      className={`flex flex-col shrink-0 select-none border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] transition-all duration-200 ease-out overflow-hidden ${
        collapsed ? 'w-0 border-r-0 opacity-0 pointer-events-none' : 'w-[272px] opacity-100'
      }`}
    >
      {/* Top Bar */}
      <div className="h-[52px] px-3 flex items-center justify-between shrink-0">
        <button
          onClick={onToggleCollapse}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="收起侧边栏"
        >
          <PanelLeftClose className="w-[18px] h-[18px]" />
        </button>

        <div className="flex items-center gap-2 font-semibold text-[13.5px] tracking-tight text-[var(--text-primary)]">
          <span className="w-5 h-5 rounded-md bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] flex items-center justify-center text-[11px] font-bold">
            R
          </span>
          <span>ragents-chat</span>
        </div>

        <button
          onClick={() => onOpenCreateRoom()}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="新建聊天室"
        >
          <SquarePen className="w-[17px] h-[17px]" />
        </button>
      </div>

      {/* Scrollable Navigation Content */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-2">
        {/* Collapsible Rooms Root Section */}
        <div>
          <button
            onClick={() => setRoomsSectionOpen(!roomsSectionOpen)}
            className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)] cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              {roomsSectionOpen ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              协同聊天室 ({rooms.length})
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onOpenCreateRoom();
              }}
              className="text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)]"
            >
              + 新建
            </span>
          </button>

          {roomsSectionOpen && (
            <div className="mt-1 space-y-2">
              {groupedRooms.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                  暂无聊天室，点击右上角新建
                </div>
              ) : (
                groupedRooms.map((group) => {
                  const isGroupCollapsed = Boolean(collapsedGroups[group.key]);
                  const isShowAll = Boolean(showAllInGroup[group.key]);
                  const visibleRooms = isShowAll
                    ? group.rooms
                    : group.rooms.slice(0, MAX_VISIBLE_ROOMS_PER_GROUP);
                  const hiddenCount =
                    group.rooms.length - MAX_VISIBLE_ROOMS_PER_GROUP;

                  return (
                    <div
                      key={group.key}
                      className={`rounded-xl transition-opacity ${
                        !group.isOnline ? 'opacity-65' : ''
                      }`}
                    >
                      {/* Level 1 Header: node:path or Floating */}
                      <div
                        onClick={() => toggleGroupCollapse(group.key)}
                        title={
                          group.isFloating
                            ? '浮动聊天室 (不固定绑定节点与目录)'
                            : `${group.displayTitle}${group.isOnline ? ' (节点在线)' : ' (节点离线)'}`
                        }
                        className="group/hdr flex items-center justify-between gap-1 px-2 py-1.5 rounded-lg hover:bg-[var(--bg-hover)] cursor-pointer text-[var(--text-secondary)] transition-colors"
                      >
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          {isGroupCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                          )}
                          {group.isFloating ? (
                            <Globe className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                          ) : (
                            <span className="relative shrink-0 flex items-center">
                              <FolderGit2
                                className={`w-3.5 h-3.5 ${
                                  group.isOnline
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-500'
                                }`}
                              />
                              <span
                                className={`-ml-1 -mt-2 w-1.5 h-1.5 rounded-full border border-[var(--bg-sidebar)] ${
                                  group.isOnline ? 'bg-emerald-500' : 'bg-rose-500'
                                }`}
                              />
                            </span>
                          )}
                          <span className="font-mono-code text-[11.5px] font-semibold text-[var(--text-primary)] truncate">
                            {group.displayTitle}
                          </span>
                          {!group.isOnline && (
                            <span className="shrink-0 text-[9.5px] px-1 py-0.2 rounded bg-rose-500/15 text-rose-500 font-medium">
                              离线
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] text-[var(--text-muted)] font-mono-code">
                            {group.rooms.length}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (group.isFloating) {
                                onOpenCreateRoom({
                                  nodeId: '__floating__',
                                  workspacePath: '',
                                });
                              } else {
                                onOpenCreateRoom({
                                  nodeId: group.nodeId || '',
                                  workspacePath: group.workspacePath || '',
                                });
                              }
                            }}
                            title={
                              group.isFloating
                                ? '新建浮动聊天室'
                                : `在 ${group.displayTitle} 下新建聊天室`
                            }
                            className="w-5 h-5 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] transition-colors cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Level 2: Rooms List (up to 5 + Show more) */}
                      {!isGroupCollapsed && (
                        <div className="mt-0.5 pl-3 pr-0.5 space-y-0.5 border-l border-[var(--border-subtle)] ml-3.5">
                          {visibleRooms.map((item) => {
                            const r = item.room;
                            const count = item.agents.length;
                            const isActive = currentRoomId === r.room_id;
                            const hasPermAlert = item.agents.some(
                              (a) => a.runtime_state === 'waiting_permission'
                            );
                            const hasThinking = item.agents.some(
                              (a) => a.runtime_state === 'thinking'
                            );
                            const preview = item.last_message
                              ? `@${item.last_message.sender_name}: ${item.last_message.content.slice(0, 30)}`
                              : '暂无消息';

                            return (
                              <div
                                key={r.room_id}
                                onClick={() => onSelectRoom(r.room_id)}
                                className={`group px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                                  isActive
                                    ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                                    : 'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-1.5">
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <Hash className="w-3 h-3 shrink-0 text-[var(--text-muted)]" />
                                    <span
                                      className={`text-[12.5px] truncate ${
                                        isActive
                                          ? 'font-semibold text-[var(--text-primary)]'
                                          : 'font-medium'
                                      }`}
                                    >
                                      {r.name}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {hasPermAlert && (
                                      <span
                                        className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"
                                        title="有待审批的沙箱权限请求"
                                      />
                                    )}
                                    {!hasPermAlert && hasThinking && (
                                      <span
                                        className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"
                                        title="Agent 思考中"
                                      />
                                    )}
                                    <span
                                      className={`text-[9.5px] px-1.5 py-0.2 rounded-full font-medium ${
                                        count <= 1
                                          ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                                          : 'bg-violet-500/12 text-violet-600 dark:text-violet-400'
                                      }`}
                                    >
                                      {count <= 1 ? '单聊' : `${count}人`}
                                    </span>
                                  </div>
                                </div>
                                <div className="mt-0.5 pl-4 text-[11px] text-[var(--text-muted)] truncate">
                                  {preview}
                                </div>
                              </div>
                            );
                          })}

                          {/* Show more / Show less toggle when > 5 rooms */}
                          {hiddenCount > 0 && (
                            <button
                              type="button"
                              onClick={() => toggleShowMore(group.key)}
                              className="w-full px-2 py-1 rounded-lg flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                            >
                              {isShowAll ? (
                                <>
                                  <ChevronUp className="w-3 h-3 shrink-0" />
                                  <span>收起 (Show less)</span>
                                </>
                              ) : (
                                <>
                                  <MoreHorizontal className="w-3.5 h-3.5 shrink-0" />
                                  <span>Show more ({hiddenCount})</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* Cluster Nodes Status Bar */}
      {clusterNodes.length > 0 && (
        <div className="px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]/50 space-y-1 shrink-0">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <span>集群节点 ({clusterNodes.length})</span>
            <span>
              {clusterNodes.filter((n) => n.status.phase === 'ready').length}/
              {clusterNodes.length} 在线
            </span>
          </div>
          <div className="space-y-1">
            {clusterNodes.map((node) => {
              const isReady = node.status.phase === 'ready';
              const active = node.status.active_runners || 0;
              const max = node.status.max_concurrent_runners || 0;
              return (
                <div
                  key={node.metadata.id}
                  title={
                    isReady
                      ? `节点在线 (${node.status.os}/${node.status.arch}) · 并发运行 ${active}/${max}`
                      : `节点断联 (${node.status.phase}) · 运行中任务享有 5 分钟重连宽限期`
                  }
                  className={`px-2 py-1 rounded-md border text-[11px] font-mono-code flex items-center justify-between gap-1.5 ${
                    isReady
                      ? 'bg-[var(--bg-main)] border-[var(--border-subtle)] text-[var(--text-primary)]'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        isReady
                          ? active > 0
                            ? 'bg-blue-500 animate-ping'
                            : 'bg-emerald-500'
                          : 'bg-rose-500 animate-pulse'
                      }`}
                    />
                    <span className="truncate font-semibold">{node.metadata.id}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 text-[10px]">
                    {isReady ? (
                      <span
                        className={
                          active > 0
                            ? 'text-blue-600 dark:text-blue-400 font-semibold'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }
                      >
                        {active > 0 ? `运行 ${active}/${max}` : 'Ready'}
                      </span>
                    ) : (
                      <span className="px-1 py-0.1 rounded bg-rose-500/20 text-rose-600 dark:text-rose-300 font-semibold">
                        断联 (宽限中)
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom Footer Controls */}
      <div className="p-2.5 border-t border-[var(--border-subtle)] space-y-1.5 shrink-0">
        {principal && (
          <div className="px-2 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-between gap-1.5 text-[11px]">
            <div className="flex items-center gap-1.5 min-w-0">
              <span>{principal.is_admin ? '👑' : '👤'}</span>
              <span className="font-semibold text-[var(--text-primary)] truncate">
                @{principal.display_name}
              </span>
              {!principal.is_admin && (
                <span className="text-[9.5px] px-1 py-0.1 rounded bg-blue-500/12 text-blue-600 dark:text-blue-400">
                  {principal.max_approval_scope}
                </span>
              )}
            </div>
            {authRequired && onLogout && (
              <button
                type="button"
                onClick={onLogout}
                title="切换访问 Token / 退出登录"
                className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-rose-500 cursor-pointer shrink-0"
              >
                <LogOut className="w-3 h-3" />
              </button>
            )}
          </div>
        )}

        {footerContributions
          .filter((c) => !c.require_admin || principal?.is_admin)
          .map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpenExtensionModal?.(c)}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span className="truncate">{c.title}</span>
            </button>
          ))}

        <div className="flex items-center gap-1.5">
          {(!principal || principal.is_admin) && (
            <button
              onClick={onOpenManagerSettings}
              className="flex-1 px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>@Manager 设置</span>
            </button>
          )}

          <button
            onClick={onToggleTheme}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
            title="切换深浅色主题"
          >
            {theme === 'dark' ? (
              <>
                <Sun className="w-3.5 h-3.5 text-amber-400" />
                <span>浅色</span>
              </>
            ) : (
              <>
                <Moon className="w-3.5 h-3.5" />
                <span>深色</span>
              </>
            )}
          </button>
        </div>
      </div>
    </aside>
  );
};
