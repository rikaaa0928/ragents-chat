import React, { useEffect, useMemo, useState } from 'react';
import Markdown, { Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { RoomAgent } from '../types';

export interface MarkdownRendererProps {
  content: string;
  variant?: 'default' | 'bubble' | 'compact';
  streaming?: boolean;
  agents?: RoomAgent[];
  onInspectAgent?: (agentId: string) => void;
  className?: string;
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [
  [
    rehypeHighlight,
    {
      detect: false,
      aliases: {
        ini: ['toml'],
        bash: ['sh', 'zsh'],
        typescript: ['tsx'],
        javascript: ['jsx'],
        yaml: ['yml'],
      },
    },
  ],
];

const safeUrlTransform = (url: string): string => {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return '';
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) {
    return trimmed;
  }
  const transformed = defaultUrlTransform(trimmed);
  if (!transformed) return '';
  const lower = transformed.toLowerCase();
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('mailto:') ||
    lower.startsWith('/') ||
    lower.startsWith('#')
  ) {
    return transformed;
  }
  return '';
};

function balanceStreamingFences(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let openFenceChar: '`' | '~' | null = null;
  let openFenceLen = 0;

  for (const line of lines) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const fence = match[1];
    const rest = match[2] || '';
    const char = fence[0] as '`' | '~';
    if (!openFenceChar) {
      if (char === '`' && rest.includes('`')) continue;
      openFenceChar = char;
      openFenceLen = fence.length;
    } else if (
      char === openFenceChar &&
      fence.length >= openFenceLen &&
      rest.trim() === ''
    ) {
      openFenceChar = null;
      openFenceLen = 0;
    }
  }

  if (openFenceChar) {
    const closer = openFenceChar.repeat(openFenceLen);
    return raw.endsWith('\n') ? `${raw}${closer}` : `${raw}\n${closer}`;
  }
  return raw;
}

function useThrottledString(value: string, enabled: boolean, delayMs = 60): string {
  const [throttled, setThrottled] = useState(value);
  const lastUpdatedRef = React.useRef<number>(0);

  useEffect(() => {
    if (!enabled) {
      setThrottled(value);
      lastUpdatedRef.current = Date.now();
      return;
    }
    const elapsed = Date.now() - lastUpdatedRef.current;
    if (elapsed >= delayMs) {
      setThrottled(value);
      lastUpdatedRef.current = Date.now();
      return;
    }
    const timer = window.setTimeout(() => {
      setThrottled(value);
      lastUpdatedRef.current = Date.now();
    }, delayMs - elapsed);
    return () => window.clearTimeout(timer);
  }, [value, enabled, delayMs]);

  return enabled ? throttled : value;
}

function extractReactText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractReactText).join('');
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractReactText(props.children);
  }
  return '';
}

function extractCodeLanguage(children: React.ReactNode): string {
  const inspect = (child: React.ReactNode): string => {
    if (!React.isValidElement(child)) return '';
    const props = child.props as { className?: string; children?: React.ReactNode };
    const cls = String(props.className || '');
    const m = cls.match(/(?:language-|lang-)([A-Za-z0-9_+-]+)/);
    if (m) return m[1];
    return '';
  };

  if (Array.isArray(children)) {
    for (const c of children) {
      const lang = inspect(c);
      if (lang) return lang;
    }
    return '';
  }
  return inspect(children);
}

const MarkdownCodeBlock: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const rawText = useMemo(() => extractReactText(children), [children]);
  const language = useMemo(() => extractCodeLanguage(children), [children]);
  const lineCount = useMemo(() => {
    const trimmed = rawText.replace(/\n$/, '');
    return trimmed ? trimmed.split(/\r?\n/).length : 1;
  }, [rawText]);

  const handleCopy = () => {
    const textToCopy = rawText.replace(/\n$/, '');
    navigator.clipboard
      ?.writeText(textToCopy)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="ragents-md-codeblock my-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-code)] overflow-hidden">
      <div className="px-3 py-1.5 flex items-center justify-between gap-2 bg-[var(--bg-surface)]/80 border-b border-[var(--border-subtle)] text-[11px] select-none">
        <div className="flex items-center gap-2 min-w-0">
          {lineCount > 24 && (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-0.5 cursor-pointer"
              title={collapsed ? '展开代码块' : '折叠代码块'}
            >
              {collapsed ? (
                <ChevronRight className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          <span className="font-mono-code font-medium text-[var(--text-secondary)] truncate">
            {language || 'text'}
          </span>
          <span className="text-[10px] text-[var(--text-muted)] font-mono-code">
            {lineCount}行
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="px-2 py-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] text-[10.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1 cursor-pointer transition-colors shrink-0"
          title="复制代码"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-500" />
              <span className="text-emerald-600 dark:text-emerald-400">已复制</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>

      {!collapsed && (
        <pre className="ragents-md-pre m-0 p-3 overflow-x-auto text-[12px] leading-[1.55] font-mono-code text-[var(--text-primary)]">
          {children}
        </pre>
      )}
    </div>
  );
};

interface MentionLookupEntry {
  agent: RoomAgent;
  lowerNeedle: string;
}

function renderMentionsInString(
  text: string,
  entries: MentionLookupEntry[],
  onInspectAgent?: (agentId: string) => void
): React.ReactNode {
  if (!text || entries.length === 0 || !text.includes('@')) {
    return text;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const lower = text.toLowerCase();

  while (cursor < text.length) {
    const atIdx = text.indexOf('@', cursor);
    if (atIdx === -1) {
      parts.push(text.slice(cursor));
      break;
    }

    // Require boundary before '@' so email addresses / word@foo aren't split
    const prevChar = atIdx > 0 ? text[atIdx - 1] : '';
    const validStart =
      atIdx === 0 || /[\s(（\[【{"'‘“:：,，;；\-—>、。！!]/.test(prevChar);

    let matched: MentionLookupEntry | null = null;
    if (validStart) {
      for (const entry of entries) {
        if (lower.startsWith(entry.lowerNeedle, atIdx)) {
          const afterIdx = atIdx + entry.lowerNeedle.length;
          const nextChar = afterIdx < text.length ? text[afterIdx] : '';
          if (
            !nextChar ||
            /[\s,，.。:：;；!?！？)）\]】}"'’”\-—/、]/.test(nextChar)
          ) {
            matched = entry;
            break;
          }
        }
      }
    }

    if (!matched) {
      parts.push(text.slice(cursor, atIdx + 1));
      cursor = atIdx + 1;
      continue;
    }

    if (atIdx > cursor) {
      parts.push(text.slice(cursor, atIdx));
    }

    const displayMention = text.slice(atIdx, atIdx + matched.lowerNeedle.length);
    const targetAgent = matched.agent;
    parts.push(
      <button
        key={`mention-${atIdx}-${targetAgent.agent_id}`}
        type="button"
        onClick={
          onInspectAgent ? () => onInspectAgent(targetAgent.agent_id) : undefined
        }
        className={`inline-flex items-center px-1.5 py-0 mx-0.5 rounded-md bg-blue-500/12 text-blue-600 dark:text-blue-400 font-medium text-[0.92em] align-baseline ${
          onInspectAgent
            ? 'hover:bg-blue-500/20 cursor-pointer'
            : 'cursor-default'
        }`}
        title={
          onInspectAgent
            ? `点击透视 @${targetAgent.name} (${targetAgent.role_title || targetAgent.model})`
            : `@${targetAgent.name}`
        }
      >
        {displayMention}
      </button>
    );
    cursor = atIdx + matched.lowerNeedle.length;
  }

  return parts.length === 1 ? parts[0] : parts;
}

function mapMentionChildren(
  children: React.ReactNode,
  entries: MentionLookupEntry[],
  onInspectAgent?: (agentId: string) => void
): React.ReactNode {
  if (entries.length === 0) return children;
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      return renderMentionsInString(child, entries, onInspectAgent);
    }
    return child;
  });
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(
  ({
    content,
    variant = 'default',
    streaming = false,
    agents = [],
    onInspectAgent,
    className = '',
  }) => {
    const throttled = useThrottledString(content, streaming, 60);
    const preparedText = useMemo(() => {
      const text = String(throttled || '');
      return streaming ? balanceStreamingFences(text) : text;
    }, [throttled, streaming]);

    const mentionEntries = useMemo<MentionLookupEntry[]>(() => {
      if (!agents || agents.length === 0) return [];
      return [...agents]
        .filter((a) => Boolean(a?.name?.trim()))
        .sort((a, b) => b.name.length - a.name.length)
        .map((agent) => ({
          agent,
          lowerNeedle: `@${agent.name.toLowerCase()}`,
        }));
    }, [agents]);

    const components = useMemo<Components>(
      () => ({
        pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
        table: ({ children, ...props }) => (
          <div className="ragents-md-table-wrap my-2.5 overflow-x-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-main)]">
            <table {...props}>{children}</table>
          </div>
        ),
        a: ({ href, children, ...props }) => (
          <a
            {...props}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="ragents-md-link"
          >
            {children}
          </a>
        ),
        img: ({ src, alt, ...props }) => (
          <img
            {...props}
            src={src}
            alt={alt || ''}
            loading="lazy"
            className="my-2 max-h-80 max-w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] object-contain"
          />
        ),
        input: ({ type, checked, ...props }) => {
          if (type === 'checkbox') {
            return (
              <input
                type="checkbox"
                checked={Boolean(checked)}
                readOnly
                tabIndex={-1}
                className="mr-1.5 align-middle accent-blue-500 pointer-events-none"
              />
            );
          }
          return <input type={type} checked={checked} {...props} />;
        },
        p: ({ children, ...props }) => (
          <p {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </p>
        ),
        li: ({ children, ...props }) => (
          <li {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </li>
        ),
        blockquote: ({ children, ...props }) => (
          <blockquote {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </blockquote>
        ),
        td: ({ children, ...props }) => (
          <td {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </td>
        ),
        th: ({ children, ...props }) => (
          <th {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </th>
        ),
        h1: ({ children, ...props }) => (
          <h1 {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </h2>
        ),
        h3: ({ children, ...props }) => (
          <h3 {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </h3>
        ),
        h4: ({ children, ...props }) => (
          <h4 {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </h4>
        ),
        h5: ({ children, ...props }) => (
          <h5 {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </h5>
        ),
        h6: ({ children, ...props }) => (
          <h6 {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </h6>
        ),
        strong: ({ children, ...props }) => (
          <strong {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </strong>
        ),
        em: ({ children, ...props }) => (
          <em {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </em>
        ),
        del: ({ children, ...props }) => (
          <del {...props}>
            {mapMentionChildren(children, mentionEntries, onInspectAgent)}
          </del>
        ),
      }),
      [mentionEntries, onInspectAgent]
    );

    const variantClass =
      variant === 'compact'
        ? 'markdown-body--compact'
        : variant === 'bubble'
        ? 'markdown-body--bubble'
        : 'markdown-body--default';

    return (
      <div className={`markdown-body ${variantClass} ${className}`}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS as never}
          urlTransform={safeUrlTransform}
          components={components}
        >
          {preparedText}
        </Markdown>
      </div>
    );
  }
);

MarkdownRenderer.displayName = 'MarkdownRenderer';
