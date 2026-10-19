import React, { useState } from 'react';
import {
  PanelLeftClose,
  SquarePen,
  Hash,
  ChevronDown,
  ChevronRight,
  Settings,
  Sun,
  Moon,
} from 'lucide-react';
import { RoomListItem } from '../types';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  rooms: RoomListItem[];
  currentRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onOpenCreateRoom: () => void;
  onOpenManagerSettings: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  collapsed,
  onToggleCollapse,
  rooms,
  currentRoomId,
  onSelectRoom,
  onOpenCreateRoom,
  onOpenManagerSettings,
  theme,
  onToggleTheme,
}) => {
  const [roomsSectionOpen, setRoomsSectionOpen] = useState(true);

  return (
    <aside
      className={`flex flex-col shrink-0 select-none border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] transition-all duration-200 ease-out overflow-hidden ${
        collapsed ? 'w-0 border-r-0 opacity-0 pointer-events-none' : 'w-[260px] opacity-100'
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
          onClick={onOpenCreateRoom}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="新建聊天室"
        >
          <SquarePen className="w-[17px] h-[17px]" />
        </button>
      </div>

      {/* Scrollable Navigation Content */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-2">
        {/* Collapsible Rooms Group */}
        <div>
          <button
            onClick={() => setRoomsSectionOpen(!roomsSectionOpen)}
            className="w-full px-2.5 py-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)] cursor-pointer"
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
            <div className="mt-1 space-y-0.5">
              {rooms.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                  暂无聊天室，点击右上角新建
                </div>
              ) : (
                rooms.map((item) => {
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
                    ? `@${item.last_message.sender_name}: ${item.last_message.content.slice(0, 32)}`
                    : '暂无消息';

                  return (
                    <div
                      key={r.room_id}
                      onClick={() => onSelectRoom(r.room_id)}
                      className={`group px-2.5 py-2 rounded-xl cursor-pointer transition-colors ${
                        isActive
                          ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                          : 'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Hash className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                          <span
                            className={`text-[13px] truncate ${
                              isActive ? 'font-semibold text-[var(--text-primary)]' : 'font-medium'
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
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              count <= 1
                                ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                                : 'bg-violet-500/12 text-violet-600 dark:text-violet-400'
                            }`}
                          >
                            {count <= 1 ? '单聊' : `${count}人`}
                          </span>
                        </div>
                      </div>
                      <div className="mt-0.5 pl-5 text-[11.5px] text-[var(--text-muted)] truncate">
                        {preview}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Footer Controls */}
      <div className="p-2.5 border-t border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onOpenManagerSettings}
            className="flex-1 px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>@Manager 设置</span>
          </button>

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
