import React, { useState, useEffect } from 'react';
import {
  X,
  KeyRound,
  Sparkles,
  Plus,
  Settings,
  ChevronDown,
  ChevronRight,
  MessageSquarePlus,
} from 'lucide-react';
import {
  ManagerSettings,
  ClusterNode,
  CreateRoomPreset,
  SendShortcutMode,
} from '../types';

export type ActiveModalType =
  | null
  | 'auth'
  | 'createRoom'
  | 'recruit'
  | 'addAgent'
  | 'managerSettings';

interface ModalsProps {
  activeModal: ActiveModalType;
  onClose: () => void;
  availableModels: string[];
  clusterNodes: ClusterNode[];
  defaultAgentModel: string;
  managerSettings: ManagerSettings;
  sendShortcutMode: SendShortcutMode;
  onChangeSendShortcutMode: (mode: SendShortcutMode) => void;
  createRoomPreset?: CreateRoomPreset | null;
  onSubmitAuth: (token: string) => void;
  onSubmitCreateRoom: (payload: {
    name: string;
    description: string;
    default_agent_name: string;
    default_agent_role: string;
    default_agent_persona: string | null;
    default_agent_model: string | null;
    reasoning_effort: string | null;
    reasoning_summary: string | null;
    web_search: boolean | null;
    node_id: string | null;
    workspace_path: string | null;
  }) => void;
  onSubmitRecruit: (requirement: string) => void;
  onSubmitAddAgent: (payload: {
    name: string;
    role_title: string;
    avatar: string;
    persona_prompt: string;
    model: string | null;
    reasoning_effort: string | null;
    reasoning_summary: string | null;
    web_search: boolean | null;
  }) => void;
  onSaveManagerSettings: (settings: ManagerSettings) => void;
}

export const Modals: React.FC<ModalsProps> = ({
  activeModal,
  onClose,
  availableModels,
  clusterNodes,
  defaultAgentModel,
  managerSettings,
  sendShortcutMode,
  onChangeSendShortcutMode,
  createRoomPreset,
  onSubmitAuth,
  onSubmitCreateRoom,
  onSubmitRecruit,
  onSubmitAddAgent,
  onSaveManagerSettings,
}) => {
  // Auth Modal State
  const [authToken, setAuthToken] = useState('');

  // Create Room State + Collapsible Advanced Section
  const [roomName, setRoomName] = useState('');
  const [roomDesc, setRoomDesc] = useState('');
  const [roomAdvancedOpen, setRoomAdvancedOpen] = useState(false);
  const [initAgentName, setInitAgentName] = useState('Assistant');
  const [initAgentRole, setInitAgentRole] = useState('全能 AI 研发助手');
  const [initAgentModel, setInitAgentModel] = useState('');
  const [initAgentPersona, setInitAgentPersona] = useState(
    'You are a helpful, pragmatic software engineering and research assistant.'
  );
  const [initEffort, setInitEffort] = useState('');
  const [initSummary, setInitSummary] = useState('');
  const [initWebSearch, setInitWebSearch] = useState<'default' | 'on' | 'off'>(
    'default'
  );
  const [initNodeId, setInitNodeId] = useState('');
  const [initWorkdir, setInitWorkdir] = useState('');

  // Recruit Modal State
  const [recruitText, setRecruitText] = useState('');

  // Manual Add Agent State + Collapsible Reasoning Section
  const [manualName, setManualName] = useState('');
  const [manualRole, setManualRole] = useState('');
  const [manualAvatar, setManualAvatar] = useState('🛠️');
  const [manualModel, setManualModel] = useState('');
  const [manualPrompt, setManualPrompt] = useState('');
  const [manualAdvancedOpen, setManualAdvancedOpen] = useState(false);
  const [manualEffort, setManualEffort] = useState('');
  const [manualSummary, setManualSummary] = useState('');
  const [manualWebSearch, setManualWebSearch] = useState<
    'default' | 'on' | 'off'
  >('default');

  // Manager Settings State + Collapsible Prompt Section
  const [mgrDraft, setMgrDraft] = useState<ManagerSettings>(managerSettings);
  const [mgrClusterOpen, setMgrClusterOpen] = useState(false);

  useEffect(() => {
    setMgrDraft(managerSettings);
    if (activeModal === 'createRoom') {
      if (createRoomPreset) {
        setInitNodeId(createRoomPreset.nodeId);
        setInitWorkdir(createRoomPreset.workspacePath);
      } else {
        setInitNodeId('');
        setInitWorkdir('');
      }
    }
  }, [managerSettings, activeModal, createRoomPreset]);

  if (!activeModal) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[500px] rounded-2xl bg-[var(--bg-main)] border border-[var(--border-default)] shadow-2xl overflow-hidden text-sm"
      >
        {/* 1. AUTH MODAL */}
        {activeModal === 'auth' && (
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-emerald-500" />
                <span>输入聊天室访问密钥</span>
              </h3>
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs text-[var(--text-secondary)]">
                Access Token / 密码
              </label>
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="请输入服务端配置的访问密钥"
                className="w-full px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-default)] text-sm"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => onSubmitAuth(authToken.trim())}
                className="px-4 py-2 rounded-xl bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] font-medium text-xs cursor-pointer"
              >
                解锁进入
              </button>
            </div>
          </div>
        )}

        {/* 2. CREATE ROOM MODAL */}
        {activeModal === 'createRoom' && (
          <div className="p-5 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <MessageSquarePlus className="w-4 h-4 text-emerald-500" />
                <span>新建协同聊天室</span>
              </h3>
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  房间名称
                </label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="例如：架构设计与代码实现群"
                  className="w-full px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  房间描述（可选）
                </label>
                <input
                  type="text"
                  value={roomDesc}
                  onChange={(e) => setRoomDesc(e.target.value)}
                  placeholder="单聊或群聊协作说明"
                  className="w-full px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                  绑定运行节点（可选）
                </label>
                <select
                  value={initNodeId}
                  onChange={(e) => setInitNodeId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs"
                >
                  <option value="">
                    跟随全局默认 ({managerSettings.default_node_id ? `绑定: ${managerSettings.default_node_id}` : '不绑定 / Floating'})
                  </option>
                  <option value="__floating__">不绑定节点 (Floating 浮动调度)</option>
                  {clusterNodes.map((n) => (
                    <option key={n.metadata.id} value={n.metadata.id}>
                      {n.metadata.id} ({n.status.os || 'os'}/{n.status.arch || 'arch'} · {n.status.phase})
                    </option>
                  ))}
                </select>
              </div>

              {initNodeId !== '__floating__' && (
                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                    绑定工作区目录（可选，留空按节点默认分配或 Floating）
                  </label>
                  <input
                    type="text"
                    value={initWorkdir}
                    onChange={(e) => setInitWorkdir(e.target.value)}
                    placeholder="/path/to/workspace"
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono-code text-xs"
                  />
                  {(() => {
                    const effectiveNodeId =
                      initNodeId || managerSettings.default_node_id || '';
                    const targetNode = clusterNodes.find(
                      (n) => n.metadata.id === effectiveNodeId
                    );
                    const allowedDirs =
                      targetNode?.status.allowed_workspace_dirs || [];
                    if (allowedDirs.length === 0) return null;
                    return (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-[var(--text-muted)]">
                          允许前缀：
                        </span>
                        {allowedDirs.map((dir) => (
                          <button
                            key={dir}
                            type="button"
                            onClick={() =>
                              setInitWorkdir(dir.endsWith('/') ? dir : `${dir}/`)
                            }
                            className="px-2 py-0.5 rounded-md bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] font-mono-code text-[11px] text-[var(--text-secondary)] cursor-pointer"
                          >
                            {dir}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Collapsible Initial Agent Configuration */}
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setRoomAdvancedOpen(!roomAdvancedOpen)}
                  className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  <span>高级配置：初始默认 Agent 参数与人设</span>
                  {roomAdvancedOpen ? (
                    <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                  )}
                </button>

                {roomAdvancedOpen && (
                  <div className="p-3.5 border-t border-[var(--border-subtle)] space-y-3 text-xs">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          初始 Agent 昵称
                        </label>
                        <input
                          type="text"
                          value={initAgentName}
                          onChange={(e) => setInitAgentName(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          角色头衔
                        </label>
                        <input
                          type="text"
                          value={initAgentRole}
                          onChange={(e) => setInitAgentRole(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        初始 Agent 模型
                      </label>
                      <select
                        value={initAgentModel}
                        onChange={(e) => setInitAgentModel(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                      >
                        <option value="">
                          跟随全局默认 {defaultAgentModel ? `(${defaultAgentModel})` : ''}
                        </option>
                        {availableModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          思考强度 (Effort)
                        </label>
                        <select
                          value={initEffort}
                          onChange={(e) => setInitEffort(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                        >
                          <option value="">
                            跟随全局默认 ({managerSettings.default_reasoning_effort || '未设置'})
                          </option>
                          <option value="none">none (关闭)</option>
                          <option value="low">low (轻量)</option>
                          <option value="medium">medium (中等)</option>
                          <option value="high">high (深度)</option>
                          <option value="xhigh">xhigh (极高)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          思考摘要 (Summary)
                        </label>
                        <select
                          value={initSummary}
                          onChange={(e) => setInitSummary(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                        >
                          <option value="">
                            跟随全局默认 ({managerSettings.default_reasoning_summary || '未设置'})
                          </option>
                          <option value="auto">auto (自动)</option>
                          <option value="concise">concise (精简)</option>
                          <option value="detailed">detailed (详细)</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        内置联网搜索 (Web Search)
                      </label>
                      <select
                        value={initWebSearch}
                        onChange={(e) =>
                          setInitWebSearch(
                            e.target.value as 'default' | 'on' | 'off'
                          )
                        }
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                      >
                        <option value="default">
                          跟随全局默认 (
                          {managerSettings.default_web_search ? '开启' : '关闭'})
                        </option>
                        <option value="on">🌐 开启联网搜索 (web_search)</option>
                        <option value="off">关闭</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        初始人设提示词 (System Prompt)
                      </label>
                      <textarea
                        rows={3}
                        value={initAgentPersona}
                        onChange={(e) => setInitAgentPersona(e.target.value)}
                        className="w-full p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code text-[11.5px]"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs font-medium cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onSubmitCreateRoom({
                    name: roomName.trim() || '新协同聊天室',
                    description: roomDesc.trim(),
                    default_agent_name: initAgentName.trim() || 'Assistant',
                    default_agent_role: initAgentRole.trim() || '全能 AI 研发助手',
                    default_agent_persona: initAgentPersona.trim() || null,
                    default_agent_model: initAgentModel.trim() || null,
                    reasoning_effort: initEffort || null,
                    reasoning_summary: initSummary || null,
                    web_search:
                      initWebSearch === 'on'
                        ? true
                        : initWebSearch === 'off'
                        ? false
                        : null,
                    node_id: initNodeId || null,
                    workspace_path:
                      initNodeId === '__floating__'
                        ? null
                        : initWorkdir.trim() || null,
                  });
                  setRoomName('');
                  setRoomDesc('');
                  setInitNodeId('');
                  setInitWorkdir('');
                }}
                className="px-4 py-1.5 rounded-xl bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] text-xs font-medium cursor-pointer"
              >
                创建房间
              </button>
            </div>
          </div>
        )}

        {/* 3. RECRUIT VIA @MANAGER MODAL */}
        {activeModal === 'recruit' && (
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-500" />
                <span>让管家 (@Manager) 招募新专家</span>
              </h3>
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs text-[var(--text-secondary)]">
                用自然语言描述你需要的专家角色、专长或协作分工：
              </label>
              <textarea
                rows={4}
                value={recruitText}
                onChange={(e) => setRecruitText(e.target.value)}
                placeholder="例如：请帮我招一个专门负责代码安全审查与边界测试的 Reviewer，以及一个负责数据库 SQL 调优的 DBAExpert"
                className="w-full p-3 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs leading-relaxed"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] text-xs font-medium cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (!recruitText.trim()) return;
                  onSubmitRecruit(recruitText.trim());
                  setRecruitText('');
                }}
                className="px-4 py-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium cursor-pointer"
              >
                立即招募
              </button>
            </div>
          </div>
        )}

        {/* 4. MANUAL ADD AGENT MODAL */}
        {activeModal === 'addAgent' && (
          <div className="p-5 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-500" />
                <span>手动添加群内 Agent</span>
              </h3>
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-4 gap-2.5">
                <div>
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                    图标
                  </label>
                  <input
                    type="text"
                    value={manualAvatar}
                    onChange={(e) => setManualAvatar(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-center rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                    昵称（用于 @name 点名，不含空格）
                  </label>
                  <input
                    type="text"
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder="例如：Reviewer"
                    className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                  角色头衔
                </label>
                <input
                  type="text"
                  value={manualRole}
                  onChange={(e) => setManualRole(e.target.value)}
                  placeholder="例如：代码审查与测试专家"
                  className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                />
              </div>

              <div>
                <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                  人设提示词 (System Prompt)
                </label>
                <textarea
                  rows={3}
                  value={manualPrompt}
                  onChange={(e) => setManualPrompt(e.target.value)}
                  placeholder="定义该 Agent 的专业领域与工作职责..."
                  className="w-full p-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono-code text-[11.5px]"
                />
              </div>

              {/* Collapsible Model & Reasoning Tuning */}
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setManualAdvancedOpen(!manualAdvancedOpen)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  <span>展开模型与思考强度参数</span>
                  {manualAdvancedOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  )}
                </button>
                {manualAdvancedOpen && (
                  <div className="p-3 border-t border-[var(--border-subtle)] space-y-2.5">
                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        模型 (Model)
                      </label>
                      <select
                        value={manualModel}
                        onChange={(e) => setManualModel(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                      >
                        <option value="">
                          跟随全局默认 {defaultAgentModel ? `(${defaultAgentModel})` : ''}
                        </option>
                        {availableModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          思考强度 (Effort)
                        </label>
                        <select
                          value={manualEffort}
                          onChange={(e) => setManualEffort(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                        >
                          <option value="">
                            跟随全局默认 ({managerSettings.default_reasoning_effort || '未设置'})
                          </option>
                          <option value="none">none</option>
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                          <option value="xhigh">xhigh</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                          思考摘要 (Summary)
                        </label>
                        <select
                          value={manualSummary}
                          onChange={(e) => setManualSummary(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                        >
                          <option value="">
                            跟随全局默认 ({managerSettings.default_reasoning_summary || '未设置'})
                          </option>
                          <option value="auto">auto</option>
                          <option value="concise">concise</option>
                          <option value="detailed">detailed</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        内置联网搜索 (Web Search)
                      </label>
                      <select
                        value={manualWebSearch}
                        onChange={(e) =>
                          setManualWebSearch(
                            e.target.value as 'default' | 'on' | 'off'
                          )
                        }
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)]"
                      >
                        <option value="default">
                          跟随全局默认 (
                          {managerSettings.default_web_search ? '开启' : '关闭'})
                        </option>
                        <option value="on">🌐 开启联网搜索 (web_search)</option>
                        <option value="off">关闭</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] text-xs font-medium cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (!manualName.trim()) return;
                  onSubmitAddAgent({
                    name: manualName.trim(),
                    role_title: manualRole.trim() || 'AI 专家',
                    avatar: manualAvatar.trim() || '🛠️',
                    persona_prompt:
                      manualPrompt.trim() ||
                      `You are @${manualName.trim()}, a specialist AI agent.`,
                    model: manualModel.trim() || null,
                    reasoning_effort: manualEffort || null,
                    reasoning_summary: manualSummary || null,
                    web_search:
                      manualWebSearch === 'on'
                        ? true
                        : manualWebSearch === 'off'
                        ? false
                        : null,
                  });
                  setManualName('');
                  setManualRole('');
                  setManualPrompt('');
                }}
                className="px-4 py-1.5 rounded-xl bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] text-xs font-medium cursor-pointer"
              >
                添加入群
              </button>
            </div>
          </div>
        )}

        {/* 5. @MANAGER GLOBAL SETTINGS MODAL */}
        {activeModal === 'managerSettings' && (
          <div className="p-5 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Settings className="w-4 h-4 text-violet-500" />
                <span>聊天室管家 (@Manager) 与全局默认设置</span>
              </h3>
              <button
                onClick={onClose}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                    Manager 使用模型
                  </label>
                  <select
                    value={mgrDraft.manager_model}
                    onChange={(e) =>
                      setMgrDraft({ ...mgrDraft, manager_model: e.target.value })
                    }
                    className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                  >
                    {Array.from(
                      new Set([...availableModels, mgrDraft.manager_model])
                    ).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                    新建 Agent 默认模型
                  </label>
                  <select
                    value={mgrDraft.default_agent_model}
                    onChange={(e) =>
                      setMgrDraft({
                        ...mgrDraft,
                        default_agent_model: e.target.value,
                      })
                    }
                    className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                  >
                    {Array.from(
                      new Set([...availableModels, mgrDraft.default_agent_model])
                    ).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                    默认思考强度
                  </label>
                  <select
                    value={mgrDraft.default_reasoning_effort || ''}
                    onChange={(e) =>
                      setMgrDraft({
                        ...mgrDraft,
                        default_reasoning_effort: e.target.value || null,
                      })
                    }
                    className="w-full px-2 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                  >
                    <option value="">网关默认</option>
                    <option value="none">none</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                    默认思考摘要
                  </label>
                  <select
                    value={mgrDraft.default_reasoning_summary || ''}
                    onChange={(e) =>
                      setMgrDraft({
                        ...mgrDraft,
                        default_reasoning_summary: e.target.value || null,
                      })
                    }
                    className="w-full px-2 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                  >
                    <option value="">网关默认</option>
                    <option value="auto">auto</option>
                    <option value="concise">concise</option>
                    <option value="detailed">detailed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                    默认接力上限(0=∞)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={mgrDraft.max_agent_relay_depth}
                    onChange={(e) =>
                      setMgrDraft({
                        ...mgrDraft,
                        max_agent_relay_depth: Math.max(
                          0,
                          parseInt(e.target.value || '0', 10)
                        ),
                      })
                    }
                    className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono-code"
                  />
                </div>
              </div>

              <label className="flex items-center justify-between px-3 py-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] cursor-pointer select-none">
                <div className="space-y-0.5">
                  <div className="font-medium text-[var(--text-primary)]">
                    🌐 默认开启内置联网搜索 (web_search)
                  </div>
                  <div className="text-[10.5px] text-[var(--text-muted)]">
                    向模型下发 OpenResponses 原生内置搜索工具声明
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(mgrDraft.default_web_search)}
                  onChange={(e) =>
                    setMgrDraft({
                      ...mgrDraft,
                      default_web_search: e.target.checked,
                    })
                  }
                  className="w-4 h-4 accent-emerald-500 cursor-pointer"
                />
              </label>

              <div>
                <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                  发送与换行快捷键配置
                </label>
                <select
                  value={sendShortcutMode}
                  onChange={(e) =>
                    onChangeSendShortcutMode(e.target.value as SendShortcutMode)
                  }
                  className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)]"
                >
                  <option value="enter_send">
                    Enter 发送，Shift+Enter 换行
                  </option>
                  <option value="shift_enter_send">
                    Shift+Enter 发送，Enter (回车) 换行
                  </option>
                </select>
              </div>

              {/* Collapsible Node / Workspace Binding & Manager System Prompt */}
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setMgrClusterOpen(!mgrClusterOpen)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  <span>节点绑定与 @Manager 系统提示词</span>
                  {mgrClusterOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  )}
                </button>
                {mgrClusterOpen && (
                  <div className="p-3 border-t border-[var(--border-subtle)] space-y-2.5">
                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        默认绑定节点 ID（Pinned 模式可选）
                      </label>
                      <select
                        value={mgrDraft.default_node_id || ''}
                        onChange={(e) =>
                          setMgrDraft({
                            ...mgrDraft,
                            default_node_id: e.target.value || null,
                          })
                        }
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code"
                      >
                        <option value="">不绑定节点 (Floating 浮动调度)</option>
                        {clusterNodes.map((n) => (
                          <option key={n.metadata.id} value={n.metadata.id}>
                            {n.metadata.id} ({n.status.os || 'os'}/{n.status.arch || 'arch'} · {n.status.phase})
                          </option>
                        ))}
                        {mgrDraft.default_node_id &&
                          !clusterNodes.some(
                            (n) => n.metadata.id === mgrDraft.default_node_id
                          ) && (
                            <option value={mgrDraft.default_node_id}>
                              {mgrDraft.default_node_id} (当前离线)
                            </option>
                          )}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        默认工作区目录（Pinned 模式可选）
                      </label>
                      <input
                        type="text"
                        value={mgrDraft.default_workspace_root || ''}
                        onChange={(e) =>
                          setMgrDraft({
                            ...mgrDraft,
                            default_workspace_root: e.target.value || null,
                          })
                        }
                        placeholder="/path/to/default/workspace"
                        className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code"
                      />
                      {(() => {
                        const targetNode = clusterNodes.find(
                          (n) => n.metadata.id === mgrDraft.default_node_id
                        );
                        const allowedDirs =
                          targetNode?.status.allowed_workspace_dirs || [];
                        if (allowedDirs.length === 0) return null;
                        return (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span className="text-[10.5px] text-[var(--text-muted)]">
                              允许前缀：
                            </span>
                            {allowedDirs.map((dir) => (
                              <button
                                key={dir}
                                type="button"
                                onClick={() =>
                                  setMgrDraft({
                                    ...mgrDraft,
                                    default_workspace_root: dir.endsWith('/')
                                      ? dir
                                      : `${dir}/`,
                                  })
                                }
                                className="px-2 py-0.5 rounded-md bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] font-mono-code text-[10.5px] text-[var(--text-secondary)] cursor-pointer"
                              >
                                {dir}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <div>
                      <label className="block text-[11px] text-[var(--text-muted)] mb-1">
                        Manager 系统提示词
                      </label>
                      <textarea
                        rows={4}
                        value={mgrDraft.manager_system_prompt}
                        onChange={(e) =>
                          setMgrDraft({
                            ...mgrDraft,
                            manager_system_prompt: e.target.value,
                          })
                        }
                        className="w-full p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] font-mono-code text-[11.5px]"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-surface)] text-[var(--text-secondary)] text-xs font-medium cursor-pointer"
              >
                关闭
              </button>
              <button
                onClick={() => onSaveManagerSettings(mgrDraft)}
                className="px-4 py-1.5 rounded-xl bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] text-xs font-medium cursor-pointer"
              >
                保存设置
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
