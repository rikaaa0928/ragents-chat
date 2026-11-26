import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  ArrowUp,
  AtSign,
  Sparkles,
  Lock,
  Globe,
  CornerDownRight,
  Microscope,
  ChevronDown,
  ChevronUp,
  ArrowDown,
  Bot,
  Zap,
  Clock,
  Keyboard,
  X,
  ImagePlus,
  FileText,
  Loader2,
  RotateCcw,
  Copy,
  Check,
  Code2,
  Eye,
} from 'lucide-react';
import { Room, RoomAgent, ChatMessage, SendShortcutMode } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { copyTextToClipboard } from '../utils/clipboard';
import { useStickyAutoScroll } from '../hooks/useStickyAutoScroll';

export interface UploadedTempAttachment {
  dist_id?: string;
  distribute_phase?: 'distributing' | 'completed' | 'failed';
  distributed_bytes?: number;
  size?: number;
  filename?: string;
  agent_path: string;
  rel_path: string;
  raw_url: string;
  is_image: boolean;
}

interface DistributingFileStatus {
  dist_id: string;
  room_id: string;
  node_id: string;
  rel_path: string;
  filename: string;
  agent_path: string;
  phase: 'distributing' | 'completed' | 'failed';
  distributed_bytes: number;
  total_bytes: number;
  error?: string;
}

interface PendingAttachmentItem {
  id: string;
  file: File;
  previewUrl: string | null;
  isImage: boolean;
  status: 'uploading_server' | 'distributing_node' | 'ready' | 'failed';
  uploaded?: UploadedTempAttachment;
  distributedBytes?: number;
  totalBytes?: number;
  error?: string;
}

interface ChatAreaProps {
  room: Room | null;
  agents: RoomAgent[];
  messages: ChatMessage[];
  selectedMentions: Set<string>;
  sendShortcutMode: SendShortcutMode;
  onChangeSendShortcutMode: (mode: SendShortcutMode) => void;
  onToggleMention: (name: string) => void;
  onSendMessage: (content: string, isRealtime: boolean) => void;
  onUploadTempFile?: (file: File) => Promise<UploadedTempAttachment>;
  onRetryAgent?: (agentId: string, dismissMsgSeq?: number) => void;
  onInspectAgent: (agentId: string) => void;
  onOpenRecruitModal: () => void;
  restoredDraft?: { text: string; seq: number } | null;
}

function agentPathToTmpRelPath(agentPath: string): string {
  const trimmed = agentPath.trim();
  if (trimmed.startsWith('.ragents-tmp/')) {
    return trimmed.slice('.ragents-tmp/'.length);
  }
  return trimmed.replace(/^\/+/, '');
}

interface ExtractedAttachment {
  kind: 'Image' | 'File';
  agentPath: string;
  relPath: string;
  rawUrl: string;
}

function extractAttachmentsFromText(
  text: string,
  roomId?: string | null
): { bodyText: string; attachments: ExtractedAttachment[] } {
  if (!roomId) {
    return { bodyText: text, attachments: [] };
  }
  const pattern = /\[Attached (Image|File):\s*([^\]]+)\]/g;
  const attachments: ExtractedAttachment[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const agentPath = match[2].trim();
    const relPath = agentPathToTmpRelPath(agentPath);
    const rawUrl = `/api/v1/ext/workspace_fs/rooms/${encodeURIComponent(
      roomId
    )}/raw?zone=tmp&path=${encodeURIComponent(relPath)}`;
    attachments.push({
      kind: match[1] as 'Image' | 'File',
      agentPath,
      relPath,
      rawUrl,
    });
  }
  if (attachments.length === 0) {
    return { bodyText: text, attachments: [] };
  }
  const bodyText = text.replace(pattern, '').trim();
  return { bodyText, attachments };
}

const MessageAttachmentsGrid: React.FC<{
  attachments: ExtractedAttachment[];
}> = React.memo(({ attachments }) => {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {attachments.map((item, idx) => {
        if (item.kind === 'Image') {
          return (
            <a
              key={`${item.agentPath}-${idx}`}
              href={item.rawUrl}
              target="_blank"
              rel="noreferrer"
              className="group/att block rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-surface)] max-w-[240px] hover:border-blue-500/50 transition-colors"
              title={`点击查看原图 · Agent 读取路径: ${item.agentPath}`}
            >
              <img
                src={item.rawUrl}
                alt={item.agentPath}
                loading="lazy"
                className="max-h-44 w-auto object-contain bg-black/5 dark:bg-white/5 mx-auto"
              />
              <div className="px-2 py-1 text-[10px] font-mono-code text-[var(--text-muted)] truncate border-t border-[var(--border-subtle)]">
                🖼️ {item.agentPath}
              </div>
            </a>
          );
        }
        return (
          <a
            key={`${item.agentPath}-${idx}`}
            href={`${item.rawUrl}&download=1`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs font-mono-code text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <FileText className="w-3.5 h-3.5 text-blue-500 shrink-0" />
            <span className="truncate max-w-[220px]">{item.agentPath}</span>
          </a>
        );
      })}
    </div>
  );
});
MessageAttachmentsGrid.displayName = 'MessageAttachmentsGrid';

function stripLeadingRedundantMentions(content: string, mentions: string[]): string {
  let rest = String(content || '').trimStart();
  if (!mentions || mentions.length === 0) return rest;
  const sortedMentions = [...mentions]
    .map((n) => String(n).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  while (rest.startsWith('@')) {
    const exactMatch = sortedMentions.find((name) => {
      if (!rest.slice(1).toLowerCase().startsWith(name.toLowerCase())) return false;
      const nextChar = rest.slice(1 + name.length, 2 + name.length);
      return !nextChar || /[\s,，:：]/.test(nextChar);
    });
    if (exactMatch) {
      rest = rest.slice(1 + exactMatch.length).replace(/^[\s,，:：]+/, '');
      continue;
    }
    const match = rest.match(/^@([^\s,，:：;；!?！？()（）\[\]{}<>]+)([\s,，:：]*)/u);
    if (!match) break;
    const tag = match[1].toLowerCase();
    if (sortedMentions.some((m) => m.toLowerCase() === tag)) {
      rest = rest.slice(match[0].length);
    } else {
      break;
    }
  }
  return rest || String(content || '');
}

function findMentionedAgent(
  text: string,
  agents: RoomAgent[],
  agentLookup: Map<string, RoomAgent>
): RoomAgent | null {
  const sortedAgents = [...agents].sort((a, b) => b.name.length - a.name.length);
  const lowerText = text.toLowerCase();
  for (const agent of sortedAgents) {
    const needle = `@${agent.name.toLowerCase()}`;
    const idx = lowerText.indexOf(needle);
    if (idx !== -1) {
      const nextChar = text.slice(idx + needle.length, idx + needle.length + 1);
      if (!nextChar || /[\s,，:：;；!?！？()（）\[\]{}<>]/.test(nextChar)) {
        return agent;
      }
    }
  }
  const mentionedMatch = text.match(/@([^\s,，:：;；!?！？()（）\[\]{}<>]+)/u);
  if (mentionedMatch) {
    return agentLookup.get(mentionedMatch[1].toLowerCase()) || null;
  }
  return null;
}

interface ChatMessageRowProps {
  message: ChatMessage;
  roomId?: string | null;
  agents: RoomAgent[];
  agentLookup: Map<string, RoomAgent>;
  isMetaExpanded: boolean;
  isRawMode: boolean;
  isCopied: boolean;
  isDismissedSystem: boolean;
  onToggleMeta: (seq: number) => void;
  onToggleRaw: (seq: number) => void;
  onCopyMessage: (seq: number, text: string) => void;
  onDismissSystem: (sysKey: string) => void;
  onRetryAgent?: (agentId: string, dismissMsgSeq?: number) => void;
  onInspectAgent: (agentId: string) => void;
}

const ChatMessageRow: React.FC<ChatMessageRowProps> = React.memo(
  ({
    message: m,
    roomId,
    agents,
    agentLookup,
    isMetaExpanded,
    isRawMode,
    isCopied,
    isDismissedSystem,
    onToggleMeta,
    onToggleRaw,
    onCopyMessage,
    onDismissSystem,
    onRetryAgent,
    onInspectAgent,
  }) => {
    const isHuman = m.sender_kind === 'human';
    const isManager = m.sender_kind === 'manager';
    const isSystem = m.sender_kind === 'system';
    const mentions = m.mentions || [];
    const visibleTo = m.visible_to || [];
    const isWhisper = visibleTo.length > 0;
    const cleanedBody = stripLeadingRedundantMentions(m.content, mentions);
    const timeStr = new Date(m.created_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const matchedAgent =
      agentLookup.get(m.sender_id) ||
      agentLookup.get(String(m.sender_name).toLowerCase());
    const avatarIcon = isManager
      ? '🎩'
      : matchedAgent?.avatar || (isHuman ? '👤' : '🤖');

    if (isSystem) {
      if (isDismissedSystem) {
        return null;
      }
      const sysKey = `${roomId || ''}:${m.msg_seq}`;
      const retryTargetAgent =
        findMentionedAgent(cleanedBody, agents, agentLookup) ||
        (m.mentions || [])
          .map((name) => agentLookup.get(String(name).toLowerCase()))
          .find((a): a is RoomAgent => Boolean(a)) ||
        (agents.length === 1 ? agents[0] : null);
      const lowerBody = cleanedBody.toLowerCase();
      const canRetry =
        Boolean(onRetryAgent && retryTargetAgent) &&
        (cleanedBody.includes('报错') ||
          cleanedBody.includes('中断') ||
          lowerBody.includes('interrupted') ||
          lowerBody.includes('error') ||
          lowerBody.includes('failed'));

      return (
        <div className="flex justify-center">
          <div className="pl-3.5 pr-2 py-1.5 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-300 text-xs flex items-center gap-2 max-w-[94%]">
            <span className="break-words flex-1 min-w-0">
              #{m.msg_seq} · {cleanedBody}
            </span>
            {canRetry && retryTargetAgent && (
              <button
                type="button"
                onClick={() => {
                  onDismissSystem(sysKey);
                  onRetryAgent?.(retryTargetAgent.agent_id, m.msg_seq);
                }}
                title={`直接让 @${retryTargetAgent.name} 重试中断/失败的回合（无需重新输入）`}
                className="px-2.5 py-1 rounded-full bg-amber-500 hover:bg-amber-400 text-black font-semibold text-[11px] inline-flex items-center gap-1 shrink-0 cursor-pointer transition-colors shadow-xs"
              >
                <RotateCcw className="w-3 h-3 stroke-[2.5]" />
                <span>直接重试</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onDismissSystem(sysKey)}
              title="关闭并不再展示此系统通知"
              className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-amber-500/20 text-amber-600 dark:text-amber-300 shrink-0 cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      );
    }

    const { bodyText, attachments } = extractAttachmentsFromText(cleanedBody, roomId);

    /* Human Message: ChatGPT / Codex Right-Aligned Pill Bubble */
    if (isHuman) {
      return (
        <div className="group/human flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-2 text-[11px] text-[var(--text-muted)] px-1">
            <div className="inline-flex items-center gap-1 opacity-75 md:opacity-0 md:group-hover/human:opacity-100 focus-within:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => onCopyMessage(m.msg_seq, cleanedBody)}
                className="px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] inline-flex items-center gap-0.5 cursor-pointer"
                title="复制消息原文"
              >
                {isCopied ? (
                  <Check className="w-3 h-3 text-emerald-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
              <button
                type="button"
                onClick={() => onToggleRaw(m.msg_seq)}
                className="px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] inline-flex items-center gap-0.5 cursor-pointer"
                title={isRawMode ? '切换为 Markdown 渲染' : '查看 Markdown 原文'}
              >
                {isRawMode ? (
                  <Eye className="w-3 h-3" />
                ) : (
                  <Code2 className="w-3 h-3" />
                )}
              </button>
            </div>
            {m.sender_name && m.sender_name !== 'Human' && (
              <span className="font-semibold text-[var(--text-secondary)]">
                @{m.sender_name}
              </span>
            )}
            <span className="font-mono-code">#{m.msg_seq}</span>
            {m.is_realtime && mentions.some((tag) => String(tag).toLowerCase() !== 'human') ? (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium text-[10.5px]"
                title="实时消息：仅对本次 @点名 的成员实时注入，未点名成员按非实时处理"
              >
                <Zap className="w-2.5 h-2.5" />
                <span>实时</span>
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full bg-[var(--bg-surface)] text-[var(--text-muted)] font-medium text-[10.5px]"
                title="非实时消息：作为独立回合排队投递"
              >
                <Clock className="w-2.5 h-2.5" />
                <span>非实时</span>
              </span>
            )}
            {mentions.length > 0 && (
              <div className="flex items-center gap-1">
                {mentions.map((tag) => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.2 rounded-full bg-[var(--bg-surface)] text-[var(--text-primary)] font-medium text-[10.5px]"
                  >
                    @{tag}
                  </span>
                ))}
              </div>
            )}
            <span>{timeStr}</span>
          </div>

          <div className="max-w-[85%] sm:max-w-[78%] rounded-[22px] rounded-br-md bg-[var(--bg-human)] px-4 py-2.5 text-[var(--text-primary)] space-y-2">
            {bodyText &&
              (isRawMode ? (
                <div className="text-[14px] leading-relaxed whitespace-pre-wrap break-words font-mono-code">
                  {bodyText}
                </div>
              ) : (
                <MarkdownRenderer
                  content={bodyText}
                  variant="bubble"
                  agents={agents}
                  onInspectAgent={onInspectAgent}
                />
              ))}
            <MessageAttachmentsGrid attachments={attachments} />
          </div>
        </div>
      );
    }

    /* Agent or @Manager Message: Clean Codex Left-Aligned Response Block */
    return (
      <div
        className={`group flex items-start gap-3.5 ${
          isWhisper
            ? 'p-3.5 rounded-2xl border border-dashed border-violet-500/40 bg-violet-500/[0.04]'
            : ''
        }`}
      >
        {/* Avatar Circle */}
        <div
          onClick={() => m.sender_id && onInspectAgent(m.sender_id)}
          className={`w-7 h-7 rounded-full flex items-center justify-center text-sm shrink-0 mt-0.5 cursor-pointer border transition-transform hover:scale-105 ${
            isManager
              ? 'bg-violet-500/15 border-violet-500/30'
              : 'bg-[var(--bg-surface)] border-[var(--border-subtle)]'
          }`}
          title="点击在右侧透视该 Agent 的内部 Session"
        >
          {avatarIcon}
        </div>

        {/* Message Content Column */}
        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Header Meta Line */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold text-[13.5px] text-[var(--text-primary)]">
              @{m.sender_name}
            </span>

            {matchedAgent?.role_title && (
              <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline">
                · {matchedAgent.role_title}
              </span>
            )}

            <span className="font-mono-code text-[11px] text-[var(--text-muted)]">
              #{m.msg_seq}
            </span>

            {/* Mention Pills */}
            {mentions.map((tag) => (
              <span
                key={tag}
                className="px-1.5 py-0.2 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium text-[11px]"
              >
                ➔ @{tag}
              </span>
            ))}

            {/* Whisper Badge */}
            {isWhisper && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-300 text-[11px] font-medium">
                <Lock className="w-3 h-3" />
                暗语 (仅{' '}
                {[
                  m.sender_name,
                  ...visibleTo.filter(
                    (v) => v.toLowerCase() !== m.sender_name.toLowerCase()
                  ),
                ]
                  .map((v) => '@' + v)
                  .join(', ')}{' '}
                可见)
              </span>
            )}

            {/* Reply Badge */}
            {m.reply_to_seq && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--text-muted)]">
                <CornerDownRight className="w-3 h-3" />#{m.reply_to_seq}
              </span>
            )}

            <span className="text-[11px] text-[var(--text-muted)] ml-auto">
              {timeStr}
            </span>
          </div>

          {/* Message Body */}
          <div className="space-y-2">
            {bodyText &&
              (isRawMode ? (
                <div className="text-[13.5px] leading-[1.65] text-[var(--text-primary)] whitespace-pre-wrap break-words font-mono-code">
                  {bodyText}
                </div>
              ) : (
                <MarkdownRenderer
                  content={bodyText}
                  variant="default"
                  agents={agents}
                  onInspectAgent={onInspectAgent}
                />
              ))}
            <MessageAttachmentsGrid attachments={attachments} />
          </div>

          {/* Action & Collapsible Envelope Details Bar */}
          <div className="pt-1 flex flex-wrap items-center gap-2">
            {m.sender_id && (
              <button
                onClick={() => onInspectAgent(m.sender_id)}
                className="px-2 py-0.5 rounded-md text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-2)] border border-[var(--border-subtle)] inline-flex items-center gap-1 cursor-pointer transition-colors"
              >
                <Microscope className="w-3 h-3 text-emerald-500" />
                <span>透视内部 Session</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => onCopyMessage(m.msg_seq, cleanedBody)}
              className="px-2 py-0.5 rounded-md text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1 cursor-pointer transition-colors"
              title="复制 Markdown 原文"
            >
              {isCopied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-500" />
                  <span className="text-emerald-600 dark:text-emerald-400">
                    已复制
                  </span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>复制</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => onToggleRaw(m.msg_seq)}
              className="px-2 py-0.5 rounded-md text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1 cursor-pointer transition-colors"
              title={isRawMode ? '切换回 Markdown 渲染' : '查看 Markdown 原文'}
            >
              {isRawMode ? (
                <>
                  <Eye className="w-3 h-3 text-blue-500" />
                  <span>渲染</span>
                </>
              ) : (
                <>
                  <Code2 className="w-3 h-3" />
                  <span>原文</span>
                </>
              )}
            </button>

            <button
              onClick={() => onToggleMeta(m.msg_seq)}
              className="px-2 py-0.5 rounded-md text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1 cursor-pointer transition-colors"
            >
              {isWhisper ? (
                <Lock className="w-3 h-3 text-violet-500" />
              ) : (
                <Globe className="w-3 h-3" />
              )}
              <span>投递元数据</span>
              {isMetaExpanded ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          </div>

          {/* Expanded Message Delivery Metadata */}
          {isMetaExpanded && (
            <div className="mt-1 p-2.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11.5px] text-[var(--text-secondary)] font-mono-code space-y-1">
              <div>
                sender_id: <span className="text-[var(--text-primary)]">{m.sender_id}</span> · kind: {m.sender_kind}
              </div>
              <div>
                mentions: {mentions.length > 0 ? mentions.map((x) => '@' + x).join(', ') : '(无显式点名)'}
              </div>
              <div>
                visibility:{' '}
                {isWhisper
                  ? `暗语隔离 [${visibleTo.join(', ')}]`
                  : '全员可见 (Public Broadcast via chatroom_speak)'}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);
ChatMessageRow.displayName = 'ChatMessageRow';

interface ChatComposerProps {
  room: Room | null;
  agents: RoomAgent[];
  selectedMentions: Set<string>;
  sendShortcutMode: SendShortcutMode;
  onChangeSendShortcutMode: (mode: SendShortcutMode) => void;
  onToggleMention: (name: string) => void;
  onSendMessage: (content: string, isRealtime: boolean) => void;
  onUploadTempFile?: (file: File) => Promise<UploadedTempAttachment>;
  onOpenRecruitModal: () => void;
  onSendSubmitted: () => void;
  restoredDraft?: { text: string; seq: number } | null;
}

const ChatComposer: React.FC<ChatComposerProps> = React.memo(
  ({
    room,
    agents,
    selectedMentions,
    sendShortcutMode,
    onChangeSendShortcutMode,
    onToggleMention,
    onSendMessage,
    onUploadTempFile,
    onOpenRecruitModal,
    onSendSubmitted,
    restoredDraft,
  }) => {
    const [inputText, setInputText] = useState('');
    const [isRealtimeMsg, setIsRealtimeMsg] = useState(false);
    const [mentionBarOpen, setMentionBarOpen] = useState(false);
    const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentItem[]>([]);
    const [uploadingAttachments, setUploadingAttachments] = useState(false);
    const [roomDistributingFiles, setRoomDistributingFiles] = useState<DistributingFileStatus[]>([]);

    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const isComposingRef = useRef(false);
    const lastCompositionEndTimeRef = useRef(0);

    useEffect(() => {
      if (!restoredDraft || !restoredDraft.text) return;
      setInputText((prev) =>
        prev.trim() ? `${prev}\n${restoredDraft.text}` : restoredDraft.text
      );
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }, [restoredDraft?.seq]);

    const startUploadForPendingItem = async (item: PendingAttachmentItem) => {
      if (!onUploadTempFile) return;
      setPendingAttachments((prev) =>
        prev.map((x) =>
          x.id === item.id ? { ...x, status: 'uploading_server', error: undefined } : x
        )
      );
      try {
        const uploaded = await onUploadTempFile(item.file);
        const isReady = uploaded.distribute_phase === 'completed';
        const isFailed = uploaded.distribute_phase === 'failed';
        setPendingAttachments((prev) =>
          prev.map((x) =>
            x.id === item.id
              ? {
                  ...x,
                  uploaded,
                  status: isReady ? 'ready' : isFailed ? 'failed' : 'distributing_node',
                  distributedBytes: uploaded.distributed_bytes ?? 0,
                  totalBytes: uploaded.size ?? item.file.size,
                }
              : x
          )
        );
      } catch (err: any) {
        setPendingAttachments((prev) =>
          prev.map((x) =>
            x.id === item.id
              ? { ...x, status: 'failed', error: err?.message || '上传失败' }
              : x
          )
        );
      }
    };

    useEffect(() => {
      if (!room?.room_id) {
        setRoomDistributingFiles((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      let cancelled = false;
      let timer: ReturnType<typeof setInterval> | null = null;

      const fetchStatus = async () => {
        try {
          const headers: Record<string, string> = {};
          const tok = localStorage.getItem('ragents_auth_token');
          if (tok) headers['Authorization'] = `Bearer ${tok}`;
          const res = await fetch(
            `/api/v1/ext/workspace_fs/rooms/${encodeURIComponent(room.room_id)}/distribute-status`,
            { headers }
          );
          if (!res.ok || cancelled) return;
          const data = await res.json();
          const list: DistributingFileStatus[] = data.distributing_files || [];
          if (cancelled) return;
          const nextActive = list.filter((d) => d.phase !== 'completed');
          setRoomDistributingFiles((prev) => {
            if (prev.length === 0 && nextActive.length === 0) return prev;
            if (JSON.stringify(prev) === JSON.stringify(nextActive)) return prev;
            return nextActive;
          });

          if (list.length > 0) {
            const byId = new Map(list.map((d) => [d.dist_id, d]));
            setPendingAttachments((prev) => {
              if (prev.length === 0) return prev;
              return prev.map((item) => {
                const distId = item.uploaded?.dist_id;
                if (!distId) return item;
                const st = byId.get(distId);
                if (!st) {
                  return item.status === 'distributing_node'
                    ? { ...item, status: 'ready', distributedBytes: item.totalBytes }
                    : item;
                }
                return {
                  ...item,
                  status:
                    st.phase === 'completed'
                      ? 'ready'
                      : st.phase === 'failed'
                      ? 'failed'
                      : 'distributing_node',
                  distributedBytes: st.distributed_bytes,
                  totalBytes: st.total_bytes || item.file.size,
                  error: st.error,
                };
              });
            });
          }

          const hasActive = list.some((d) => d.phase === 'distributing');
          if (!hasActive && timer) {
            clearInterval(timer);
            timer = null;
          }
        } catch (_) {}
      };

      const ensurePolling = () => {
        fetchStatus();
        if (!timer) {
          timer = setInterval(fetchStatus, 450);
        }
      };

      fetchStatus();
      const onUploaded = (ev: any) => {
        if (!ev?.detail?.roomId || ev.detail.roomId === room.room_id) {
          ensurePolling();
        }
      };
      window.addEventListener('ragents-workspace-fs-uploaded', onUploaded);
      return () => {
        cancelled = true;
        if (timer) clearInterval(timer);
        window.removeEventListener('ragents-workspace-fs-uploaded', onUploaded);
      };
    }, [room?.room_id]);

    const retryDistributeOnNode = async (distId: string) => {
      if (!room?.room_id || !distId) return;
      const headers: Record<string, string> = {};
      const tok = localStorage.getItem('ragents_auth_token');
      if (tok) headers['Authorization'] = `Bearer ${tok}`;
      await fetch(
        `/api/v1/ext/workspace_fs/rooms/${encodeURIComponent(room.room_id)}/distribute-retry?dist_id=${encodeURIComponent(distId)}`,
        { method: 'POST', headers }
      );
      window.dispatchEvent(
        new CustomEvent('ragents-workspace-fs-uploaded', {
          detail: { roomId: room.room_id, dist_id: distId },
        })
      );
    };

    const addFilesToPending = (files: File[]) => {
      if (!files || files.length === 0) return;
      const items: PendingAttachmentItem[] = files.map((file) => {
        const isImage = file.type.startsWith('image/');
        const ext = file.name.includes('.')
          ? file.name.slice(file.name.lastIndexOf('.'))
          : isImage
          ? '.png'
          : '.bin';
        const normalizedFile =
          !file.name || file.name === 'image.png'
            ? new File([file], `paste-${Date.now()}${ext}`, { type: file.type })
            : file;
        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file: normalizedFile,
          previewUrl: isImage ? URL.createObjectURL(normalizedFile) : null,
          isImage,
          status: 'uploading_server',
          totalBytes: normalizedFile.size,
          distributedBytes: 0,
        };
      });
      setPendingAttachments((prev) => [...prev, ...items]);
      items.forEach((item) => {
        startUploadForPendingItem(item);
      });
    };

    const removePendingAttachment = (id: string) => {
      setPendingAttachments((prev) => {
        const target = prev.find((x) => x.id === id);
        if (target?.previewUrl) {
          URL.revokeObjectURL(target.previewUrl);
        }
        return prev.filter((x) => x.id !== id);
      });
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFilesToPending(files);
      }
    };

    const handleSend = async () => {
      const trimmed = inputText.trim();
      if ((!trimmed && pendingAttachments.length === 0) || !room || uploadingAttachments) {
        return;
      }

      let attachmentLines: string[] = [];
      if (pendingAttachments.length > 0 && onUploadTempFile) {
        setUploadingAttachments(true);
        try {
          for (const item of pendingAttachments) {
            const uploaded = item.uploaded ?? (await onUploadTempFile(item.file));
            const tagKind = uploaded.is_image || item.isImage ? 'Image' : 'File';
            attachmentLines.push(`[Attached ${tagKind}: ${uploaded.agent_path}]`);
          }
          pendingAttachments.forEach((item) => {
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          });
          setPendingAttachments([]);
        } catch (_) {
          setUploadingAttachments(false);
          return;
        }
        setUploadingAttachments(false);
      }

      const finalContent = [trimmed, ...attachmentLines].filter(Boolean).join('\n');
      if (!finalContent) return;

      setInputText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      onSendSubmitted();
      onSendMessage(finalContent, isRealtimeMsg);
    };

    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };

    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndTimeRef.current = performance.now();
    };

    const handleKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' || !isComposingRef.current) {
        lastCompositionEndTimeRef.current = 0;
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const justEndedComposition =
        lastCompositionEndTimeRef.current > 0 &&
        performance.now() - lastCompositionEndTimeRef.current < 100;

      if (
        nativeEvent.isComposing ||
        isComposingRef.current ||
        nativeEvent.keyCode === 229 ||
        e.keyCode === 229 ||
        e.key === 'Process' ||
        justEndedComposition
      ) {
        lastCompositionEndTimeRef.current = 0;
        return;
      }

      if (e.key === 'Enter') {
        const isMobileDevice =
          typeof window !== 'undefined' &&
          (window.innerWidth < 768 ||
            Boolean(window.matchMedia?.('(pointer: coarse)').matches));
        if (isMobileDevice) {
          return;
        }
        if (sendShortcutMode === 'enter_send') {
          if (!e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        } else {
          if (e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }
      }
    };

    return (
      <div className="px-2.5 sm:px-6 pb-[calc(2.25rem+env(safe-area-inset-bottom,0px))] sm:pb-4 pt-1 shrink-0 bg-[var(--bg-main)]">
        <div className="max-w-[780px] mx-auto">
          <div className="rounded-[20px] sm:rounded-[24px] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-sm focus-within:border-[var(--text-muted)] transition-colors overflow-hidden">
            {/* Collapsible @Mention Selector Bar inside Composer */}
            {room && mentionBarOpen && (
              <div className="px-3.5 pt-2.5 pb-1.5 flex items-center flex-wrap gap-1.5 border-b border-[var(--border-subtle)]">
                <span className="text-[11px] font-medium text-[var(--text-muted)] flex items-center gap-1 mr-1">
                  <AtSign className="w-3 h-3" />
                  点名唤醒:
                </span>

                {agents.map((a, idx) => {
                  const isSel = selectedMentions.has(a.name);
                  const isLead = idx === 0 && agents.length > 1;
                  return (
                    <button
                      key={a.agent_id}
                      type="button"
                      onClick={() => onToggleMention(a.name)}
                      className={`px-2.5 py-0.5 rounded-full text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                        isSel
                          ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)]'
                          : 'bg-[var(--bg-main)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)]'
                      }`}
                      title={
                        isLead
                          ? `@${a.name}（默认主导，点击可取消或切换点名目标）`
                          : `点名唤醒 @${a.name}`
                      }
                    >
                      <span>{a.avatar}</span>
                      <span>@{a.name}</span>
                      {isLead && (
                        <span className="text-[10px] opacity-75">主导</span>
                      )}
                    </button>
                  );
                })}

                {/* @Manager Chip */}
                <button
                  type="button"
                  onClick={() => onToggleMention('Manager')}
                  className={`px-2.5 py-0.5 rounded-full text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                    selectedMentions.has('Manager')
                      ? 'bg-violet-600 text-white'
                      : 'bg-[var(--bg-main)] text-violet-600 dark:text-violet-400 border border-violet-500/25 hover:bg-violet-500/10'
                  }`}
                >
                  <span>🎩</span>
                  <span>@Manager (群管家)</span>
                </button>
              </div>
            )}

            {/* Active Server -> Node File Distribution Banner */}
            {roomDistributingFiles.length > 0 && (
              <div className="px-3.5 py-2 border-b border-[var(--border-subtle)] bg-sky-500/5 flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                  <span>📡 正在将文件从服务器分发至节点 ({roomDistributingFiles.length})</span>
                  <span className="text-[10px] font-normal text-[var(--text-muted)]">已暂存服务器 · 节点后台拉取</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {roomDistributingFiles.map((df) => {
                    const pct = Math.min(
                      99,
                      Math.round(((df.distributed_bytes || 0) / (df.total_bytes || 1)) * 100)
                    );
                    const isFailed = df.phase === 'failed';
                    return (
                      <div
                        key={df.dist_id}
                        className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[var(--bg-main)] border border-[var(--border-subtle)] text-[11px]"
                      >
                        <span className="font-mono-code truncate max-w-[180px] text-[var(--text-primary)]">
                          {df.filename}
                        </span>
                        {isFailed ? (
                          <>
                            <span className="text-rose-500 font-semibold text-[10px]" title={df.error || ''}>
                              ❌ 分发失败
                            </span>
                            <button
                              type="button"
                              onClick={() => retryDistributeOnNode(df.dist_id)}
                              className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 text-[10px] font-semibold cursor-pointer"
                            >
                              重试分发
                            </button>
                          </>
                        ) : (
                          <span className="font-mono-code text-[10px] text-sky-600 dark:text-sky-400 font-semibold">
                            {pct}%
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Pending Image / File Attachments Strip */}
            {pendingAttachments.length > 0 && (
              <div className="px-3.5 pt-2.5 pb-1.5 flex items-center flex-wrap gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-main)]/40">
                {pendingAttachments.map((item) => {
                  const pct = Math.min(
                    99,
                    Math.round(
                      ((item.distributedBytes || 0) / (item.totalBytes || item.file.size || 1)) *
                        100
                    )
                  );
                  return (
                    <div
                      key={item.id}
                      className="relative group/pending flex items-center gap-2 p-1.5 pr-6 rounded-xl bg-[var(--bg-main)] border border-[var(--border-subtle)] text-xs"
                    >
                      {item.previewUrl ? (
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          className="w-10 h-10 rounded-lg object-cover border border-[var(--border-subtle)] shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-[var(--bg-surface)] flex items-center justify-center shrink-0">
                          <FileText className="w-4 h-4 text-blue-500" />
                        </div>
                      )}
                      <div className="min-w-0 max-w-[175px]">
                        <div className="font-medium text-[11px] text-[var(--text-primary)] truncate">
                          {item.file.name}
                        </div>
                        <div className="text-[9.5px] flex items-center gap-1.5">
                          {item.status === 'uploading_server' && (
                            <span className="text-amber-600 dark:text-amber-400 font-medium">
                              📤 正在上传至服务器暂存区...
                            </span>
                          )}
                          {item.status === 'distributing_node' && (
                            <span className="text-sky-600 dark:text-sky-400 font-mono-code font-medium">
                              📡 分发至节点中 {pct}%
                            </span>
                          )}
                          {item.status === 'ready' && (
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                              ✅ 已分发至节点临时区
                            </span>
                          )}
                          {item.status === 'failed' && (
                            <>
                              <span className="text-rose-500 font-medium" title={item.error || ''}>
                                ❌ 分发失败
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  item.uploaded?.dist_id
                                    ? retryDistributeOnNode(item.uploaded.dist_id)
                                    : startUploadForPendingItem(item)
                                }
                                className="px-1 py-0.2 rounded bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 font-semibold cursor-pointer"
                              >
                                重试
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePendingAttachment(item.id)}
                        className="absolute top-1 right-1 w-4 h-4 rounded-full bg-[var(--bg-surface)] hover:bg-rose-500 hover:text-white text-[var(--text-muted)] flex items-center justify-center cursor-pointer"
                        title="移除附件"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Textarea */}
            <div className="px-3.5 sm:px-4 pt-2 sm:pt-2.5 pb-1">
              <textarea
                ref={textareaRef}
                rows={2}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onPaste={handlePaste}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
                placeholder={
                  room
                    ? typeof window !== 'undefined' &&
                      (window.innerWidth < 768 ||
                        Boolean(window.matchMedia?.('(pointer: coarse)').matches))
                      ? '给聊天室发送消息（点击右下角「发送」按钮发送，回车换行，支持附带图片）...'
                      : sendShortcutMode === 'enter_send'
                      ? '给聊天室发送消息（点击「发送」或按 Enter 发送，Shift+Enter 换行，支持粘贴/选择图片）...'
                      : '给聊天室发送消息（点击「发送」或按 Shift+Enter 发送，Enter 换行，支持粘贴/选择图片）...'
                    : '请先选择或创建聊天室'
                }
                disabled={!room}
                className="w-full bg-transparent border-0 outline-none resize-none text-[16px] sm:text-[14px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] max-h-36 sm:max-h-40"
              />
            </div>

            {/* Composer Bottom Toolbar */}
            <div className="px-2.5 sm:px-3 pb-2 sm:pb-2.5 pt-1 flex items-center justify-between gap-1.5 sm:gap-2">
              <div className="flex items-center gap-1 sm:gap-1.5 min-w-0 overflow-x-auto no-scrollbar">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,*/*"
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    addFilesToPending(files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  disabled={!room || uploadingAttachments}
                  onClick={() => fileInputRef.current?.click()}
                  className="px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1 bg-[var(--bg-main)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                  title="选择图片或文件（也可在输入框直接 Ctrl+V / Cmd+V 粘贴图片）。消息发出时自动上传到节点临时目录，并在消息中仅附带文件路径供 Agent 调用 view_image 查看"
                >
                  <ImagePlus className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  <span>图片/文件</span>
                </button>

                <button
                  type="button"
                  onClick={() => setMentionBarOpen(!mentionBarOpen)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    mentionBarOpen || selectedMentions.size > 0
                      ? 'bg-[var(--bg-main)] text-[var(--text-primary)] border border-[var(--border-subtle)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                  title="展开/收起 @点名唤醒栏（默认点名主导 Agent，也可取消或改选其他成员）"
                >
                  <AtSign className="w-3.5 h-3.5 shrink-0" />
                  <span className="max-w-[120px] truncate">
                    {selectedMentions.size === 1
                      ? `点名 @${Array.from(selectedMentions)[0]}`
                      : selectedMentions.size > 1
                      ? `点名 (${selectedMentions.size})`
                      : '点名'}
                  </span>
                  {mentionBarOpen ? (
                    <ChevronUp className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setIsRealtimeMsg(!isRealtimeMsg)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer whitespace-nowrap shrink-0 border ${
                    isRealtimeMsg
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/35'
                      : 'bg-[var(--bg-main)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-subtle)]'
                  }`}
                  title={
                    isRealtimeMsg
                      ? '当前：实时消息（仅对本次 @点名 的成员实时注入，对其余未点名成员按非实时排队/窥屏处理）'
                      : '当前：非实时消息（默认，点击切换为实时消息）。非实时消息会等待 Agent 当前回合结束后按序投递'
                  }
                >
                  {isRealtimeMsg ? (
                    <>
                      <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span>实时消息</span>
                    </>
                  ) : (
                    <>
                      <Clock className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                      <span>非实时消息</span>
                    </>
                  )}
                </button>

                <div
                  className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-main)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] shrink-0"
                  title="设置发送与换行快捷键模式"
                >
                  <Keyboard className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                  <select
                    value={sendShortcutMode}
                    onChange={(e) =>
                      onChangeSendShortcutMode(e.target.value as SendShortcutMode)
                    }
                    className="bg-transparent border-0 outline-none text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer pr-1"
                  >
                    <option value="enter_send">
                      Enter 发送 / Shift+Enter 换行
                    </option>
                    <option value="shift_enter_send">
                      Shift+Enter 发送 / Enter 换行
                    </option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={onOpenRecruitModal}
                  className="px-2.5 py-1 rounded-full text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-main)] flex items-center gap-1 cursor-pointer transition-colors whitespace-nowrap shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                  <span className="hidden sm:inline">@Manager 招募专家</span>
                </button>
              </div>

              <button
                type="button"
                onClick={handleSend}
                disabled={
                  (!inputText.trim() && pendingAttachments.length === 0) ||
                  !room ||
                  uploadingAttachments
                }
                className={`h-9 px-3.5 sm:px-4 rounded-full font-semibold text-xs sm:text-[13px] flex items-center justify-center gap-1.5 transition-all cursor-pointer shrink-0 shadow-xs ${
                  (inputText.trim() || pendingAttachments.length > 0) &&
                  room &&
                  !uploadingAttachments
                    ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] hover:opacity-90 active:scale-95'
                    : 'bg-[var(--bg-surface-2)] text-[var(--text-muted)] cursor-not-allowed opacity-60'
                }`}
                title={
                  uploadingAttachments
                    ? '正在上传图片/附件到临时目录...'
                    : '发送消息'
                }
              >
                {uploadingAttachments ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span>上传中</span>
                  </>
                ) : (
                  <>
                    <ArrowUp className="w-4 h-4 stroke-[2.5] shrink-0" />
                    <span>发送</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);
ChatComposer.displayName = 'ChatComposer';

export const ChatArea: React.FC<ChatAreaProps> = React.memo(
  ({
    room,
    agents,
    messages,
    selectedMentions,
    sendShortcutMode,
    onChangeSendShortcutMode,
    onToggleMention,
    onSendMessage,
    onUploadTempFile,
    onRetryAgent,
    onInspectAgent,
    onOpenRecruitModal,
    restoredDraft,
  }) => {
    const [expandedMetaSeqs, setExpandedMetaSeqs] = useState<Set<number>>(new Set());
    const [rawMessageSeqs, setRawMessageSeqs] = useState<Set<number>>(new Set());
    const [copiedMessageSeq, setCopiedMessageSeq] = useState<number | null>(null);
    const [hasUnreadBelow, setHasUnreadBelow] = useState(false);
    const [dismissedSystemKeys, setDismissedSystemKeys] = useState<Set<string>>(() => {
      try {
        const raw = localStorage.getItem('ragents_dismissed_system_msgs');
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) return new Set(arr.map(String));
        }
      } catch (_) {}
      return new Set();
    });

    const dismissSystemMessage = useCallback((sysKey: string) => {
      setDismissedSystemKeys((prev) => {
        const next = new Set(prev);
        next.add(sysKey);
        try {
          localStorage.setItem(
            'ragents_dismissed_system_msgs',
            JSON.stringify(Array.from(next).slice(-500))
          );
        } catch (_) {}
        return next;
      });
    }, []);

    const {
      containerRef: scrollRef,
      contentRef: timelineContentRef,
      pinnedRef: pinnedToBottomRef,
      isPinned,
      scrollToBottom,
      scrollContainerProps,
    } = useStickyAutoScroll({
      repinThresholdPx: 12,
      resetKey: room?.room_id ?? null,
    });

    const lastMsgSeq = messages[messages.length - 1]?.msg_seq ?? 0;
    const prevLastMsgSeqRef = useRef(lastMsgSeq);
    const prevRoomIdRef = useRef(room?.room_id ?? null);

    useEffect(() => {
      if (prevRoomIdRef.current !== (room?.room_id ?? null)) {
        prevRoomIdRef.current = room?.room_id ?? null;
        prevLastMsgSeqRef.current = lastMsgSeq;
        setHasUnreadBelow(false);
        return;
      }
      if (lastMsgSeq > prevLastMsgSeqRef.current) {
        prevLastMsgSeqRef.current = lastMsgSeq;
        if (pinnedToBottomRef.current) {
          scrollToBottom();
        } else {
          setHasUnreadBelow(true);
        }
      } else {
        prevLastMsgSeqRef.current = lastMsgSeq;
      }
    }, [room?.room_id, lastMsgSeq, pinnedToBottomRef, scrollToBottom]);

    useEffect(() => {
      if (isPinned) {
        setHasUnreadBelow(false);
      }
    }, [isPinned]);

    const handleSendSubmitted = useCallback(() => {
      scrollToBottom(true);
    }, [scrollToBottom]);

    const toggleMsgMeta = useCallback((seq: number) => {
      setExpandedMetaSeqs((prev) => {
        const next = new Set(prev);
        if (next.has(seq)) next.delete(seq);
        else next.add(seq);
        return next;
      });
    }, []);

    const toggleRawMessage = useCallback((seq: number) => {
      setRawMessageSeqs((prev) => {
        const next = new Set(prev);
        if (next.has(seq)) next.delete(seq);
        else next.add(seq);
        return next;
      });
    }, []);

    const copyMessageContent = useCallback((seq: number, text: string) => {
      copyTextToClipboard(text).then((ok) => {
        if (!ok) return;
        setCopiedMessageSeq(seq);
        window.setTimeout(() => {
          setCopiedMessageSeq((cur) => (cur === seq ? null : cur));
        }, 1500);
      });
    }, []);

    // Stabilize agent metadata for message rows so runtime_state / token_usage
    // updates do NOT re-render the entire chat message history.
    const mentionSignature = agents
      .map((a) => `${a.agent_id}\0${a.name}\0${a.avatar}\0${a.role_title}\0${a.model}`)
      .join('\n');

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const stableMentionAgents = useMemo(() => agents, [mentionSignature]);

    const agentLookup = useMemo(() => {
      const map = new Map<string, RoomAgent>();
      stableMentionAgents.forEach((a) => {
        map.set(a.agent_id, a);
        map.set(a.name.toLowerCase(), a);
      });
      return map;
    }, [stableMentionAgents]);

    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden bg-[var(--bg-main)] relative">
        {/* Scrollable Conversation Timeline */}
        <div
          ref={scrollRef}
          {...scrollContainerProps}
          className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6"
        >
          <div ref={timelineContentRef} className="max-w-[780px] mx-auto space-y-6">
            {messages.length === 0 ? (
              <div className="py-24 text-center space-y-3">
                <div className="w-11 h-11 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center mx-auto text-[var(--text-primary)]">
                  <Bot className="w-5 h-5" />
                </div>
                <h3 className="text-base font-semibold text-[var(--text-primary)]">
                  开始多智能体协同对话
                </h3>
                <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto leading-relaxed">
                  直接发送消息与当前 Agent 协作，或点名{' '}
                  <code className="px-1 py-0.5 rounded bg-[var(--bg-surface)]">
                    @Manager
                  </code>{' '}
                  动态招募更多领域的专家智能体入群。
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <ChatMessageRow
                  key={m.msg_seq}
                  message={m}
                  roomId={room?.room_id}
                  agents={stableMentionAgents}
                  agentLookup={agentLookup}
                  isMetaExpanded={expandedMetaSeqs.has(m.msg_seq)}
                  isRawMode={rawMessageSeqs.has(m.msg_seq)}
                  isCopied={copiedMessageSeq === m.msg_seq}
                  isDismissedSystem={
                    m.sender_kind === 'system' &&
                    dismissedSystemKeys.has(`${room?.room_id || ''}:${m.msg_seq}`)
                  }
                  onToggleMeta={toggleMsgMeta}
                  onToggleRaw={toggleRawMessage}
                  onCopyMessage={copyMessageContent}
                  onDismissSystem={dismissSystemMessage}
                  onRetryAgent={onRetryAgent}
                  onInspectAgent={onInspectAgent}
                />
              ))
            )}
          </div>
        </div>

        {/* Floating Jump-to-Bottom Pill */}
        {hasUnreadBelow && !isPinned && (
          <div className="absolute bottom-36 sm:bottom-32 left-1/2 -translate-x-1/2 z-10">
            <button
              onClick={() => scrollToBottom(true)}
              className="px-3.5 py-1.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-default)] shadow-md text-xs font-medium flex items-center gap-1.5 cursor-pointer hover:bg-[var(--bg-surface)]"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>有新消息 · 回到最新</span>
            </button>
          </div>
        )}

        {/* Bottom Floating Codex Composer */}
        <ChatComposer
          room={room}
          agents={agents}
          selectedMentions={selectedMentions}
          sendShortcutMode={sendShortcutMode}
          onChangeSendShortcutMode={onChangeSendShortcutMode}
          onToggleMention={onToggleMention}
          onSendMessage={onSendMessage}
          onUploadTempFile={onUploadTempFile}
          onOpenRecruitModal={onOpenRecruitModal}
          onSendSubmitted={handleSendSubmitted}
          restoredDraft={restoredDraft}
        />
      </div>
    );
  }
);
ChatArea.displayName = 'ChatArea';
