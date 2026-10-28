import React, { useState, useRef, useEffect } from 'react';
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
} from 'lucide-react';
import { Room, RoomAgent, ChatMessage, SendShortcutMode } from '../types';

export interface UploadedTempAttachment {
  agent_path: string;
  rel_path: string;
  raw_url: string;
  is_image: boolean;
}

interface PendingAttachmentItem {
  id: string;
  file: File;
  previewUrl: string | null;
  isImage: boolean;
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

function renderMessageWithAttachments(text: string, roomId?: string | null): React.ReactNode {
  const pattern = /\[Attached (Image|File):\s*([^\]]+)\]/g;
  const matches: Array<{ kind: 'Image' | 'File'; agentPath: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matches.push({
      kind: match[1] as 'Image' | 'File',
      agentPath: match[2].trim(),
    });
  }
  if (matches.length === 0 || !roomId) {
    return text;
  }

  const textWithoutTags = text.replace(pattern, '').trim();
  return (
    <div className="space-y-2">
      {textWithoutTags && <div>{textWithoutTags}</div>}
      <div className="flex flex-wrap gap-2 pt-0.5">
        {matches.map((item, idx) => {
          const relPath = agentPathToTmpRelPath(item.agentPath);
          const rawUrl = `/api/v1/ext/workspace_fs/rooms/${encodeURIComponent(
            roomId
          )}/raw?zone=tmp&path=${encodeURIComponent(relPath)}`;
          if (item.kind === 'Image') {
            return (
              <a
                key={`${item.agentPath}-${idx}`}
                href={rawUrl}
                target="_blank"
                rel="noreferrer"
                className="group/att block rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-surface)] max-w-[240px] hover:border-blue-500/50 transition-colors"
                title={`点击查看原图 · Agent 读取路径: ${item.agentPath}`}
              >
                <img
                  src={rawUrl}
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
              href={`${rawUrl}&download=1`}
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
    </div>
  );
}

function stripLeadingRedundantMentions(content: string, mentions: string[]): string {
  let rest = String(content || '').trimStart();
  if (!mentions || mentions.length === 0) return rest;
  const lowerSet = new Set(mentions.map((n) => String(n).toLowerCase()));
  while (rest.startsWith('@')) {
    const match = rest.match(/^@([A-Za-z0-9_-]+)([\s,，:：]*)/);
    if (!match) break;
    const tag = match[1].toLowerCase();
    if (lowerSet.has(tag)) {
      rest = rest.slice(match[0].length);
    } else {
      break;
    }
  }
  return rest || String(content || '');
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  room,
  agents,
  messages,
  selectedMentions,
  sendShortcutMode,
  onChangeSendShortcutMode,
  onToggleMention,
  onSendMessage,
  onUploadTempFile,
  onInspectAgent,
  onOpenRecruitModal,
  restoredDraft,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRealtimeMsg, setIsRealtimeMsg] = useState(false); // 默认为非实时消息
  const [mentionBarOpen, setMentionBarOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachmentItem[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [expandedMetaSeqs, setExpandedMetaSeqs] = useState<Set<number>>(new Set());
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

  const dismissSystemMessage = (sysKey: string) => {
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
  };
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndTimeRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const pinnedToBottomRef = useRef(true);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    pinnedToBottomRef.current = true;
    setPinnedToBottom(true);
    setShowJumpBottom(false);
    requestAnimationFrame(() => {
      const cur = scrollRef.current;
      if (cur && pinnedToBottomRef.current) {
        cur.scrollTop = cur.scrollHeight;
        lastScrollTopRef.current = cur.scrollTop;
      }
    });
  };

  useEffect(() => {
    pinnedToBottomRef.current = true;
    scrollToBottom();
  }, [room?.room_id]);

  useEffect(() => {
    if (!restoredDraft || !restoredDraft.text) return;
    setInputText((prev) =>
      prev.trim() ? `${prev}\n${restoredDraft.text}` : restoredDraft.text
    );
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [restoredDraft?.seq]);

  useEffect(() => {
    if (pinnedToBottomRef.current || pinnedToBottom) {
      scrollToBottom();
    } else {
      setShowJumpBottom(true);
    }
  }, [messages.length, messages[messages.length - 1]?.msg_seq]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 4;
    lastScrollTopRef.current = el.scrollTop;

    if (distanceFromBottom <= 56) {
      pinnedToBottomRef.current = true;
      setPinnedToBottom(true);
      setShowJumpBottom(false);
    } else if (scrolledUp) {
      pinnedToBottomRef.current = false;
      setPinnedToBottom(false);
    }
  };

  const toggleMsgMeta = (seq: number) => {
    setExpandedMetaSeqs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
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
      };
    });
    setPendingAttachments((prev) => [...prev, ...items]);
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
          const uploaded = await onUploadTempFile(item.file);
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
    setPinnedToBottom(true);
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

  const agentLookup = new Map<string, RoomAgent>();
  agents.forEach((a) => {
    agentLookup.set(a.agent_id, a);
    agentLookup.set(a.name.toLowerCase(), a);
  });

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden bg-[var(--bg-main)] relative">
      {/* Scrollable Conversation Timeline */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6"
      >
        <div className="max-w-[780px] mx-auto space-y-6">
          {messages.length === 0 ? (
            <div className="py-24 text-center space-y-3">
              <div className="w-11 h-11 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center mx-auto text-[var(--text-primary)]">
                <Bot className="w-5 h-5" />
              </div>
              <h3 className="text-base font-semibold text-[var(--text-primary)]">
                开始多智能体协同对话
              </h3>
              <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto leading-relaxed">
                直接发送消息与当前 Agent 协作，或点名 <code className="px-1 py-0.5 rounded bg-[var(--bg-surface)]">@Manager</code> 动态招募更多领域的专家智能体入群。
              </p>
            </div>
          ) : (
            messages.map((m) => {
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
              const isMetaExpanded = expandedMetaSeqs.has(m.msg_seq);

              if (isSystem) {
                const sysKey = `${room.room_id}:${m.msg_seq}`;
                if (dismissedSystemKeys.has(sysKey)) {
                  return null;
                }
                return (
                  <div key={m.msg_seq} className="flex justify-center">
                    <div className="pl-3.5 pr-2 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-300 text-xs flex items-center gap-2 max-w-[92%]">
                      <span className="break-words">
                        #{m.msg_seq} · {cleanedBody}
                      </span>
                      <button
                        type="button"
                        onClick={() => dismissSystemMessage(sysKey)}
                        title="关闭并不再展示此系统通知"
                        className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-amber-500/20 text-amber-600 dark:text-amber-300 shrink-0 cursor-pointer transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              }

              /* Human Message: ChatGPT / Codex Right-Aligned Pill Bubble */
              if (isHuman) {
                return (
                  <div key={m.msg_seq} className="flex flex-col items-end gap-1.5">
                    <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] px-1">
                      {m.sender_name && m.sender_name !== 'Human' && (
                        <span className="font-semibold text-[var(--text-secondary)]">
                          @{m.sender_name}
                        </span>
                      )}
                      <span className="font-mono-code">#{m.msg_seq}</span>
                      {m.is_realtime ? (
                        <span
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium text-[10.5px]"
                          title="实时消息：直接注入 Agent 当前运行循环或立即唤醒"
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

                    <div className="max-w-[85%] sm:max-w-[78%] rounded-[22px] rounded-br-md bg-[var(--bg-human)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
                      {renderMessageWithAttachments(cleanedBody, room?.room_id)}
                    </div>
                  </div>
                );
              }

              /* Agent or @Manager Message: Clean Codex Left-Aligned Response Block */
              return (
                <div
                  key={m.msg_seq}
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
                    <div className="text-[14px] leading-[1.65] text-[var(--text-primary)] whitespace-pre-wrap break-words">
                      {renderMessageWithAttachments(cleanedBody, room?.room_id)}
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
                        onClick={() => toggleMsgMeta(m.msg_seq)}
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
            })
          )}
        </div>
      </div>

      {/* Floating Jump-to-Bottom Pill */}
      {showJumpBottom && (
        <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={scrollToBottom}
            className="px-3.5 py-1.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-default)] shadow-md text-xs font-medium flex items-center gap-1.5 cursor-pointer hover:bg-[var(--bg-surface)]"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>有新消息 · 回到最新</span>
          </button>
        </div>
      )}

      {/* Bottom Floating Codex Composer */}
      <div className="px-4 sm:px-6 pb-4 pt-1 shrink-0 bg-[var(--bg-main)]">
        <div className="max-w-[780px] mx-auto">
          <div className="rounded-[24px] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-sm focus-within:border-[var(--text-muted)] transition-colors overflow-hidden">
            {/* Collapsible @Mention Selector Bar inside Composer */}
            {room && mentionBarOpen && (
              <div className="px-3.5 pt-2.5 pb-1.5 flex items-center flex-wrap gap-1.5 border-b border-[var(--border-subtle)]">
                <span className="text-[11px] font-medium text-[var(--text-muted)] flex items-center gap-1 mr-1">
                  <AtSign className="w-3 h-3" />
                  点名唤醒:
                </span>

                {agents.map((a) => {
                  const isSel = selectedMentions.has(a.name);
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
                    >
                      <span>{a.avatar}</span>
                      <span>@{a.name}</span>
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

            {/* Pending Image / File Attachments Strip (Uploaded to Temp Dir on Send) */}
            {pendingAttachments.length > 0 && (
              <div className="px-3.5 pt-2.5 pb-1.5 flex items-center flex-wrap gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-main)]/40">
                {pendingAttachments.map((item) => (
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
                    <div className="min-w-0 max-w-[140px]">
                      <div className="font-medium text-[11px] text-[var(--text-primary)] truncate">
                        {item.file.name}
                      </div>
                      <div className="text-[9.5px] text-[var(--text-muted)]">
                        发送时上传至临时区并传递路径
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
                ))}
              </div>
            )}

            {/* Textarea */}
            <div className="px-4 pt-2.5 pb-1">
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
                    ? sendShortcutMode === 'enter_send'
                      ? '给聊天室发送消息（Enter 发送，Shift+Enter 换行，支持粘贴或选择图片上传临时区）...'
                      : '给聊天室发送消息（Shift+Enter 发送，Enter 换行，支持粘贴或选择图片上传临时区）...'
                    : '请先选择或创建聊天室'
                }
                disabled={!room}
                className="w-full bg-transparent border-0 outline-none resize-none text-[14px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-muted)] max-h-40"
              />
            </div>

            {/* Composer Bottom Toolbar */}
            <div className="px-3 pb-2.5 pt-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto">
                {/* Hidden File Input for Image / File Attachment */}
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
                  title="展开/收起 @点名唤醒栏"
                >
                  <AtSign className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    点名 {selectedMentions.size > 0 ? `(${selectedMentions.size})` : ''}
                  </span>
                  {mentionBarOpen ? (
                    <ChevronUp className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
                  )}
                </button>

                {/* Message Type Selector: 非实时消息 (default) vs 实时消息 */}
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
                      ? '当前：实时消息（点击切换为非实时消息）。实时消息会直接注入 Agent 正在运行的思考循环中'
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

                {/* Send / Newline Shortcut Configuration Selector */}
                <div
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-main)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] shrink-0"
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

              {/* Circular Up-Arrow Send Button (Codex Signature) */}
              <button
                type="button"
                onClick={handleSend}
                disabled={
                  (!inputText.trim() && pendingAttachments.length === 0) ||
                  !room ||
                  uploadingAttachments
                }
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 ${
                  (inputText.trim() || pendingAttachments.length > 0) &&
                  room &&
                  !uploadingAttachments
                    ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-text)] hover:opacity-90'
                    : 'bg-[var(--bg-surface-2)] text-[var(--text-muted)] cursor-not-allowed opacity-50'
                }`}
                title={
                  uploadingAttachments
                    ? '正在上传图片/附件到临时目录...'
                    : sendShortcutMode === 'enter_send'
                    ? '发送消息 (Enter)'
                    : '发送消息 (Shift+Enter)'
                }
              >
                {uploadingAttachments ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
