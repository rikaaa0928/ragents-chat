import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Room,
  RoomListItem,
  RoomDetailResponse,
  InspectorSnapshot,
  ManagerSettings,
  ClusterNode,
  CreateRoomPreset,
  SendShortcutMode,
} from './types';
import { Sidebar } from './components/Sidebar';
import { TopHeader } from './components/TopHeader';
import { ChatArea } from './components/ChatArea';
import { RightInspectorPane } from './components/RightInspectorPane';
import { Modals, ActiveModalType } from './components/Modals';

const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  manager_model: '',
  default_agent_model: '',
  default_reasoning_effort: null,
  default_reasoning_summary: null,
  default_node_id: null,
  default_workspace_root: null,
  max_agent_relay_depth: 0,
  manager_system_prompt: '',
};

export const App: React.FC = () => {
  // Theme State
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('ragents_chat_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

  // Send Shortcut Mode ('enter_send': Enter发送/Shift+Enter换行 | 'shift_enter_send': Shift+Enter发送/Enter换行)
  const [sendShortcutMode, setSendShortcutMode] = useState<SendShortcutMode>(() => {
    const saved = localStorage.getItem('ragents_chat_send_shortcut');
    return saved === 'shift_enter_send' ? 'shift_enter_send' : 'enter_send';
  });

  useEffect(() => {
    localStorage.setItem('ragents_chat_send_shortcut', sendShortcutMode);
  }, [sendShortcutMode]);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('ragents_chat_theme', theme);
  }, [theme]);

  // Layout Collapsible States (Right-side columns default to closed for clean Codex focus!)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [flowColumnOpen, setFlowColumnOpen] = useState(false);
  const [rosterColumnOpen, setRosterColumnOpen] = useState(false);
  const [inspectorColumnOpen, setInspectorColumnOpen] = useState(false);
  const [activeModal, setActiveModal] = useState<ActiveModalType>(null);
  const [createRoomPreset, setCreateRoomPreset] = useState<CreateRoomPreset | null>(null);

  // Core State
  const [authToken, setAuthToken] = useState(
    () => localStorage.getItem('ragents_chat_token') || ''
  );
  const [roomsList, setRoomsList] = useState<RoomListItem[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);
  const [currentDetail, setCurrentDetail] = useState<RoomDetailResponse | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<Set<string>>(new Set());
  const [singleChatAutoPreselected, setSingleChatAutoPreselected] = useState(false);

  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(null);
  const [inspectorSnap, setInspectorSnap] = useState<InspectorSnapshot | null>(null);
  const [agentActivities, setAgentActivities] = useState<Record<string, string>>({});
  const [peekStatusBanner, setPeekStatusBanner] = useState('');
  const [liveReasoningBuffer, setLiveReasoningBuffer] = useState('');
  const [liveStreamBuffer, setLiveStreamBuffer] = useState('');
  const [restoredDraft, setRestoredDraft] = useState<{
    text: string;
    seq: number;
  } | null>(null);

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [clusterNodes, setClusterNodes] = useState<ClusterNode[]>([]);
  const [managerSettings, setManagerSettings] = useState<ManagerSettings>(
    DEFAULT_MANAGER_SETTINGS
  );
  const [apiErrors, setApiErrors] = useState<
    Array<{
      id: string;
      method: string;
      path: string;
      status: number | string;
      message: string;
      time: string;
    }>
  >([]);

  const pushApiError = useCallback(
    (method: string, path: string, status: number | string, message: string) => {
      const now = new Date().toLocaleTimeString();
      setApiErrors((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          method,
          path,
          status,
          message,
          time: now,
        },
        ...prev.filter((e) => !(e.path === path && e.message === message)).slice(0, 4),
      ]);
    },
    []
  );

  const roomEsRef = useRef<EventSource | null>(null);
  const inspectorEsRef = useRef<EventSource | null>(null);
  const inspectedAgentIdRef = useRef<string | null>(null);
  const inspectedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    inspectedAgentIdRef.current = inspectedAgentId;
  }, [inspectedAgentId]);

  useEffect(() => {
    inspectedSessionIdRef.current = inspectedSessionId;
  }, [inspectedSessionId]);

  const apiFetch = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const method = (options.method || 'GET').toUpperCase();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...((options.headers as Record<string, string>) || {}),
      };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      let res: Response;
      try {
        res = await fetch(path, { ...options, headers });
      } catch (netErr: unknown) {
        const msg = netErr instanceof Error ? netErr.message : String(netErr);
        pushApiError(method, path, 'NETWORK_ERR', msg);
        throw netErr;
      }
      if (res.status === 401) {
        setActiveModal('auth');
        throw new Error('Unauthorized');
      }
      if (!res.ok) {
        const rawText = await res.text().catch(() => '');
        let errMessage = res.statusText || `HTTP ${res.status}`;
        if (rawText) {
          try {
            const parsed = JSON.parse(rawText);
            errMessage = parsed.error || parsed.message || rawText;
          } catch {
            errMessage = rawText;
          }
        }
        pushApiError(method, path, res.status, errMessage);
        throw new Error(errMessage);
      }
      return res.json();
    },
    [authToken, pushApiError]
  );

  const refreshAvailableModels = useCallback(async () => {
    try {
      const data = await apiFetch('/api/v1/settings/manager');
      const s = data.settings || {};
      setManagerSettings((prev) => ({ ...prev, ...s }));
      setClusterNodes(data.cluster_nodes || []);
      const models = new Set<string>();
      for (const node of data.cluster_nodes || []) {
        const st = node.status || {};
        if (st.default_model) models.add(st.default_model);
        for (const m of st.supported_models || []) {
          if (m) models.add(m);
        }
      }
      if (s.default_agent_model) models.add(s.default_agent_model);
      if (s.manager_model) models.add(s.manager_model);
      setAvailableModels(Array.from(models));
      return data;
    } catch (_) {
      return null;
    }
  }, [apiFetch]);

  const refreshInspectorSnapshot = useCallback(
    async (
      agentId: string,
      sessionId: string | null = null,
      resetBuffers = true
    ) => {
      const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
      const snap = await apiFetch(`/api/v1/agents/${agentId}/inspector${q}`);
      const normalized: InspectorSnapshot = {
        agent: snap.agent,
        selected_session_id: snap.selected_session_id,
        session: snap.session || null,
        can_edit_prompt: Boolean(snap.can_edit_prompt),
        pending_permissions: snap.pending_permissions || [],
        context: {
          effective_items: snap.context?.effective_items || [],
        },
        events: snap.events || [],
        message_queues: snap.message_queues || {
          realtime_messages: [],
          normal_messages: [],
        },
      };
      setInspectedAgentId(snap.agent.agent_id);
      setInspectedSessionId(sessionId);
      setInspectorSnap(normalized);
      if (resetBuffers) {
        setLiveReasoningBuffer('');
        setLiveStreamBuffer('');
      }
    },
    [apiFetch]
  );

  const subscribeInspectorStream = useCallback(
    (agentId: string, sessionId: string | null = null) => {
      if (inspectorEsRef.current) {
        inspectorEsRef.current.close();
      }
      const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
      const es = new EventSource(`/api/v1/agents/${agentId}/inspector/stream${q}`);
      inspectorEsRef.current = es;

      const appendContextItems = (items: InspectorSnapshot['context']['effective_items']) => {
        if (!items || items.length === 0) return;
        setInspectorSnap((prev) => {
          if (!prev) return prev;
          const existing = prev.context?.effective_items || [];
          const existingIds = new Set(
            existing.map((it) => it.id).filter(Boolean)
          );
          const filtered = items.filter(
            (it) => !it.id || !existingIds.has(it.id)
          );
          if (filtered.length === 0) return prev;
          return {
            ...prev,
            context: {
              effective_items: [...existing, ...filtered],
            },
          };
        });
      };

      es.onmessage = (e) => {
        try {
          const env = JSON.parse(e.data);
          const ev = env.event;
          if (!ev) return;
          const evType = ev.type || ev.kind;

          if (evType === 'model_reasoning_delta') {
            setLiveReasoningBuffer((prev) => prev + (ev.delta || ''));
          } else if (evType === 'model_text_delta') {
            setLiveStreamBuffer((prev) => prev + (ev.delta || ''));
          } else if (evType === 'activation_submitted') {
            if (ev.items && ev.items.length > 0) {
              appendContextItems(ev.items);
            }
            refreshInspectorSnapshot(agentId, sessionId, false);
          } else if (
            evType === 'activation_started' ||
            evType === 'realtime_messages_drained'
          ) {
            refreshInspectorSnapshot(agentId, sessionId, false);
          } else if (evType === 'turn_started') {
            setLiveReasoningBuffer('');
            setLiveStreamBuffer('');
            refreshInspectorSnapshot(agentId, sessionId, false);
          } else if (evType === 'turn_completed') {
            setLiveReasoningBuffer('');
            setLiveStreamBuffer('');
            if (ev.items && ev.items.length > 0) {
              appendContextItems(ev.items);
            }
            refreshInspectorSnapshot(agentId, sessionId, false);
          } else if (evType === 'tool_call_finished') {
            if (ev.items && ev.items.length > 0) {
              appendContextItems(ev.items);
            }
            refreshInspectorSnapshot(agentId, sessionId, false);
          } else if (
            evType === 'session_compacted' ||
            evType === 'permission_requested' ||
            evType === 'activation_completed' ||
            evType === 'activation_failed'
          ) {
            refreshInspectorSnapshot(
              agentId,
              sessionId,
              evType !== 'permission_requested'
            );
          }
        } catch (err) {
          console.error(err);
        }
      };
    },
    [refreshInspectorSnapshot]
  );

  const subscribeRoomStream = useCallback(
    (roomId: string) => {
      if (roomEsRef.current) {
        roomEsRef.current.close();
      }
      const es = new EventSource(`/api/v1/rooms/${roomId}/stream`);
      roomEsRef.current = es;

      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === 'message_posted') {
            setCurrentDetail((prev) => {
              if (!prev || prev.room.room_id !== roomId) return prev;
              if (prev.messages.some((m) => m.msg_seq === ev.message.msg_seq)) {
                return prev;
              }
              return {
                ...prev,
                messages: [...prev.messages, ev.message],
              };
            });
            setRoomsList((prev) =>
              prev.map((item) =>
                item.room.room_id === roomId
                  ? { ...item, last_message: ev.message }
                  : item
              )
            );
            if (inspectedAgentIdRef.current) {
              refreshInspectorSnapshot(
                inspectedAgentIdRef.current,
                inspectedSessionIdRef.current,
                false
              );
            }
          } else if (ev.type === 'message_withdrawn') {
            setCurrentDetail((prev) => {
              if (!prev || prev.room.room_id !== roomId) return prev;
              return {
                ...prev,
                messages: prev.messages.filter((m) => m.msg_seq !== ev.msg_seq),
              };
            });
            if (inspectedAgentIdRef.current) {
              refreshInspectorSnapshot(
                inspectedAgentIdRef.current,
                inspectedSessionIdRef.current,
                false
              );
            }
          } else if (ev.type === 'agent_updated') {
            if (ev.agent && String(ev.agent.name).toLowerCase() === 'manager') {
              setCurrentDetail((prev) =>
                prev ? { ...prev, manager_agent: ev.agent } : prev
              );
            } else if (ev.agent) {
              setCurrentDetail((prev) => {
                if (!prev) return prev;
                const prevCount = prev.agents.length;
                const idx = prev.agents.findIndex(
                  (a) => a.agent_id === ev.agent.agent_id
                );
                const nextAgents = [...prev.agents];
                if (idx >= 0) nextAgents[idx] = ev.agent;
                else nextAgents.push(ev.agent);
                if (prevCount === 1 && nextAgents.length > 1) {
                  setSelectedMentions(new Set());
                  setSingleChatAutoPreselected(false);
                }
                setRoomsList((list) =>
                  list.map((r) =>
                    r.room.room_id === roomId ? { ...r, agents: nextAgents } : r
                  )
                );
                return { ...prev, agents: nextAgents };
              });
            }
            if (
              ev.agent &&
              inspectedAgentIdRef.current === ev.agent.agent_id
            ) {
              setInspectorSnap((prev) =>
                prev ? { ...prev, agent: ev.agent } : prev
              );
              refreshInspectorSnapshot(
                ev.agent.agent_id,
                inspectedSessionIdRef.current,
                false
              );
            }
          } else if (ev.type === 'agent_removed') {
            setCurrentDetail((prev) => {
              if (!prev) return prev;
              const nextAgents = prev.agents.filter(
                (a) => a.agent_id !== ev.agent_id
              );
              setRoomsList((list) =>
                list.map((r) =>
                  r.room.room_id === roomId ? { ...r, agents: nextAgents } : r
                )
              );
              return { ...prev, agents: nextAgents };
            });
          } else if (ev.type === 'room_updated') {
            setCurrentDetail((prev) =>
              prev ? { ...prev, room: ev.room } : prev
            );
            setRoomsList((list) =>
              list.map((r) =>
                r.room.room_id === roomId ? { ...r, room: ev.room } : r
              )
            );
          } else if (ev.type === 'peek_round_status') {
            const logEntry = {
              timestamp: new Date().toISOString(),
              status: ev.status,
            };
            setCurrentDetail((prev) => {
              if (!prev) return prev;
              const nextLogs = [...(prev.flow_logs || []), logEntry].slice(-120);
              return { ...prev, flow_logs: nextLogs };
            });
            setPeekStatusBanner(ev.status);
            setTimeout(() => {
              setPeekStatusBanner((cur) => (cur === ev.status ? '' : cur));
            }, 5000);
          } else if (ev.type === 'permission_alert') {
            if (inspectedAgentIdRef.current === ev.agent_id) {
              refreshInspectorSnapshot(ev.agent_id, null);
            }
          } else if (ev.type === 'agent_activity') {
            setAgentActivities((prev) => ({
              ...prev,
              [ev.agent_id]: ev.activity || '',
            }));
          }
        } catch (err) {
          console.error(err);
        }
      };
    },
    [refreshInspectorSnapshot]
  );

  const handleSelectRoom = useCallback(
    async (roomId: string) => {
      setCurrentRoomId(roomId);
      const detail: RoomDetailResponse = await apiFetch(`/api/v1/rooms/${roomId}`);
      setCurrentDetail(detail);
      if (detail.agents.length === 1) {
        setSelectedMentions(new Set([detail.agents[0].name]));
        setSingleChatAutoPreselected(true);
      } else {
        setSelectedMentions(new Set());
        setSingleChatAutoPreselected(false);
      }
      subscribeRoomStream(roomId);
      if (detail.agents.length > 0) {
        await refreshInspectorSnapshot(detail.agents[0].agent_id, null);
        subscribeInspectorStream(detail.agents[0].agent_id, null);
      }
    },
    [
      apiFetch,
      refreshInspectorSnapshot,
      subscribeInspectorStream,
      subscribeRoomStream,
    ]
  );

  const refreshRooms = useCallback(async () => {
    const list: RoomListItem[] = await apiFetch('/api/v1/rooms');
    setRoomsList(list);
    if (list.length > 0) {
      const targetId =
        currentRoomId && list.some((r) => r.room.room_id === currentRoomId)
          ? currentRoomId
          : list[0].room.room_id;
      await handleSelectRoom(targetId);
    } else {
      setCurrentRoomId(null);
      setCurrentDetail(null);
    }
  }, [apiFetch, currentRoomId, handleSelectRoom]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/v1/auth/status');
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          pushApiError('GET', '/api/v1/auth/status', res.status, text);
          return;
        }
        const st = await res.json();
        if (st.auth_required && !st.authenticated) {
          setActiveModal('auth');
          return;
        }
        await refreshAvailableModels();
        await refreshRooms();
      } catch (e: unknown) {
        console.error(e);
      }
    })();
  }, []);

  const handleInspectAgent = async (
    agentId: string,
    sessionId?: string,
    autoOpenPane = true
  ) => {
    if (autoOpenPane) setInspectorColumnOpen(true);
    setInspectedAgentId(agentId);
    setLiveReasoningBuffer('');
    setLiveStreamBuffer('');
    await refreshInspectorSnapshot(agentId, sessionId || null);
    subscribeInspectorStream(agentId, sessionId || null);
  };

  const handleToggleMention = (name: string) => {
    setSelectedMentions((prev) => {
      const next = new Set(prev);
      const agents = currentDetail?.agents || [];
      if (singleChatAutoPreselected) {
        setSingleChatAutoPreselected(false);
        if (agents.length === 1 && name !== agents[0].name) {
          next.clear();
          next.add(name);
          return next;
        }
      }
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSendMessage = async (content: string, isRealtime: boolean) => {
    if (!currentDetail || !currentRoomId) return;
    const mentions =
      singleChatAutoPreselected && content.startsWith('@')
        ? []
        : Array.from(selectedMentions);

    await apiFetch(`/api/v1/rooms/${currentRoomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        sender_name: 'Human',
        content,
        mentions,
        is_realtime: isRealtime,
      }),
    });
    if (currentDetail.agents.length === 1) {
      setSelectedMentions(new Set([currentDetail.agents[0].name]));
      setSingleChatAutoPreselected(true);
    }
  };

  const handleUpdateRoomControls = async (patch: Partial<Room>) => {
    if (!currentRoomId || !currentDetail) return;
    const updated = await apiFetch(`/api/v1/rooms/${currentRoomId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    setCurrentDetail((prev) => (prev ? { ...prev, room: updated } : null));
  };

  const handleResumeRelay = async () => {
    if (!currentRoomId) return;
    const updated = await apiFetch(`/api/v1/rooms/${currentRoomId}/resume-relay`, {
      method: 'POST',
    });
    setCurrentDetail((prev) => (prev ? { ...prev, room: updated } : null));
  };

  return (
    <div className="flex w-screen h-screen overflow-hidden bg-[var(--bg-main)] text-[var(--text-primary)]">
      {/* 1. Collapsible Left Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        rooms={roomsList}
        clusterNodes={clusterNodes}
        currentRoomId={currentRoomId}
        onSelectRoom={(id) => handleSelectRoom(id)}
        onOpenCreateRoom={async (preset) => {
          setCreateRoomPreset(preset || null);
          await refreshAvailableModels();
          setActiveModal('createRoom');
        }}
        onOpenManagerSettings={async () => {
          await refreshAvailableModels();
          setActiveModal('managerSettings');
        }}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      />

      {/* 2. Center Main Workspace (Top Header + Collapsible Config Drawer + Chat Area) */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0 h-full overflow-hidden">
        <TopHeader
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(false)}
          onOpenCreateRoom={async () => {
            setCreateRoomPreset(null);
            await refreshAvailableModels();
            setActiveModal('createRoom');
          }}
          room={currentDetail?.room || null}
          agents={currentDetail?.agents || []}
          clusterNodes={clusterNodes}
          inspectedAgent={inspectorSnap?.agent || null}
          flowLogCount={currentDetail?.flow_logs?.length || 0}
          peekStatusBanner={peekStatusBanner}
          flowColumnOpen={flowColumnOpen}
          onToggleFlowColumn={() => setFlowColumnOpen(!flowColumnOpen)}
          rosterColumnOpen={rosterColumnOpen}
          onToggleRosterColumn={() => setRosterColumnOpen(!rosterColumnOpen)}
          inspectorColumnOpen={inspectorColumnOpen}
          onToggleInspectorColumn={() =>
            setInspectorColumnOpen(!inspectorColumnOpen)
          }
          onUpdateRoomControls={handleUpdateRoomControls}
          onResumeRelay={handleResumeRelay}
          onDeleteRoom={async () => {
            if (!currentRoomId) return;
            if (
              !confirm(
                `确定删除聊天室 "${currentDetail?.room.name || ''}" 及其关联 Session 吗？`
              )
            )
              return;
            await apiFetch(`/api/v1/rooms/${currentRoomId}`, {
              method: 'DELETE',
            });
            setCurrentRoomId(null);
            await refreshRooms();
          }}
        />

        {apiErrors.length > 0 && (
          <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-4 py-2.5 space-y-2 max-h-48 overflow-y-auto">
            {apiErrors.map((err) => (
              <div
                key={err.id}
                className="flex items-start justify-between gap-3 text-xs text-red-700 dark:text-red-300"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 font-semibold">
                    <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-700 dark:text-red-200 font-mono text-[11px]">
                      HTTP {err.status}
                    </span>
                    <span className="font-mono text-[11px] opacity-90">
                      {err.method} {err.path}
                    </span>
                    <span className="text-[10.5px] opacity-60 font-normal">
                      {err.time}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed select-text opacity-95">
                    {err.message}
                  </pre>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={async () => {
                      setApiErrors([]);
                      await refreshAvailableModels();
                      await refreshRooms();
                    }}
                    className="px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-800 dark:text-red-200 font-medium cursor-pointer"
                  >
                    重试
                  </button>
                  <button
                    onClick={() =>
                      setApiErrors((prev) => prev.filter((x) => x.id !== err.id))
                    }
                    className="px-2 py-1 rounded hover:bg-red-500/20 text-red-700 dark:text-red-300 cursor-pointer"
                  >
                    关闭
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <ChatArea
          room={currentDetail?.room || null}
          agents={currentDetail?.agents || []}
          messages={currentDetail?.messages || []}
          selectedMentions={selectedMentions}
          sendShortcutMode={sendShortcutMode}
          onChangeSendShortcutMode={setSendShortcutMode}
          onToggleMention={handleToggleMention}
          onSendMessage={handleSendMessage}
          onInspectAgent={(id) => handleInspectAgent(id, undefined, true)}
          onOpenRecruitModal={() => setActiveModal('recruit')}
          restoredDraft={restoredDraft}
        />
      </main>

      {/* 3. Right Three Independent Vertical Columns (流程轨迹竖列 + 群成员竖列 + 具体 Agent 透视竖列) */}
      <RightInspectorPane
        flowColumnOpen={flowColumnOpen}
        onCloseFlowColumn={() => setFlowColumnOpen(false)}
        flowLogs={currentDetail?.flow_logs || []}
        rosterColumnOpen={rosterColumnOpen}
        onCloseRosterColumn={() => setRosterColumnOpen(false)}
        inspectorColumnOpen={inspectorColumnOpen}
        onCloseInspectorColumn={() => setInspectorColumnOpen(false)}
        room={currentDetail?.room || null}
        managerAgent={currentDetail?.manager_agent || null}
        agents={currentDetail?.agents || []}
        agentActivities={agentActivities}
        inspector={inspectorSnap}
        availableModels={availableModels}
        liveReasoningBuffer={liveReasoningBuffer}
        liveStreamBuffer={liveStreamBuffer}
        onSelectAgent={(id, sessId) => handleInspectAgent(id, sessId, true)}
        onOpenRecruitModal={() => setActiveModal('recruit')}
        onOpenAddAgentModal={async () => {
          await refreshAvailableModels();
          setActiveModal('addAgent');
        }}
        onOpenManagerSettings={async () => {
          await refreshAvailableModels();
          setActiveModal('managerSettings');
        }}
        onRemoveAgent={async (agentId) => {
          if (!currentRoomId) return;
          await apiFetch(`/api/v1/rooms/${currentRoomId}/agents/${agentId}`, {
            method: 'DELETE',
          });
        }}
        onUpdateAgentConfig={async (agentId, patch) => {
          if (!currentRoomId) return;
          const updated = await apiFetch(
            `/api/v1/rooms/${currentRoomId}/agents/${agentId}`,
            {
              method: 'PATCH',
              body: JSON.stringify(patch),
            }
          );
          setInspectorSnap((prev) =>
            prev && prev.agent.agent_id === agentId
              ? { ...prev, agent: updated }
              : prev
          );
          setCurrentDetail((prev) => {
            if (!prev) return prev;
            if (prev.manager_agent?.agent_id === agentId) {
              return { ...prev, manager_agent: updated };
            }
            return {
              ...prev,
              agents: prev.agents.map((a) =>
                a.agent_id === agentId ? updated : a
              ),
            };
          });
          if (inspectedAgentId === agentId) {
            await refreshInspectorSnapshot(agentId, inspectedSessionId, false);
          }
        }}
        onResolvePermission={async (actId, reqId, decision, overridePath) => {
          if (!inspectedAgentId) return;
          await apiFetch(`/api/v1/agents/${inspectedAgentId}/approve`, {
            method: 'POST',
            body: JSON.stringify({
              activation_id: actId,
              request_id: reqId,
              decision,
              override_path: overridePath,
            }),
          });
          await refreshInspectorSnapshot(inspectedAgentId, inspectedSessionId);
        }}
        onCancelAgent={async (agentId) => {
          await apiFetch(`/api/v1/agents/${agentId}/cancel`, { method: 'POST' });
        }}
        onWithdrawQueuedMessage={async (agentId, msgSeq) => {
          const res = await apiFetch(
            `/api/v1/agents/${agentId}/queue/${msgSeq}/withdraw`,
            { method: 'POST' }
          );
          if (res?.message_queues) {
            setInspectorSnap((prev) =>
              prev && prev.agent.agent_id === agentId
                ? { ...prev, message_queues: res.message_queues }
                : prev
            );
          }
          setCurrentDetail((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.filter((m) => m.msg_seq !== msgSeq),
                }
              : prev
          );
          if (
            res?.withdrawn_message?.sender_kind === 'human' &&
            res?.withdrawn_message?.content
          ) {
            setRestoredDraft({
              text: String(res.withdrawn_message.content),
              seq: Date.now(),
            });
          }
        }}
      />

      {/* 4. Modals */}
      <Modals
        activeModal={activeModal}
        onClose={() => {
          setActiveModal(null);
          setCreateRoomPreset(null);
        }}
        availableModels={availableModels}
        clusterNodes={clusterNodes}
        defaultAgentModel={managerSettings.default_agent_model}
        managerSettings={managerSettings}
        sendShortcutMode={sendShortcutMode}
        onChangeSendShortcutMode={setSendShortcutMode}
        createRoomPreset={createRoomPreset}
        onSubmitAuth={async (tok) => {
          try {
            const res = await fetch('/api/v1/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: tok }),
            });
            if (!res.ok) {
              alert('访问密钥错误');
              return;
            }
            setAuthToken(tok);
            localStorage.setItem('ragents_chat_token', tok);
            setActiveModal(null);
            await refreshRooms();
          } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
          }
        }}
        onSubmitCreateRoom={async (payload) => {
          setActiveModal(null);
          const created = await apiFetch('/api/v1/rooms', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          await refreshRooms();
          await handleSelectRoom(created.room.room_id);
        }}
        onSubmitRecruit={async (requirement) => {
          setActiveModal(null);
          if (!currentRoomId) return;
          await apiFetch(`/api/v1/rooms/${currentRoomId}/recruit`, {
            method: 'POST',
            body: JSON.stringify({ requirement }),
          });
        }}
        onSubmitAddAgent={async (payload) => {
          setActiveModal(null);
          if (!currentRoomId) return;
          await apiFetch(`/api/v1/rooms/${currentRoomId}/agents`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
        }}
        onSaveManagerSettings={async (updated) => {
          setActiveModal(null);
          const saved = await apiFetch('/api/v1/settings/manager', {
            method: 'PUT',
            body: JSON.stringify(updated),
          });
          setManagerSettings(saved);
        }}
      />
    </div>
  );
};
