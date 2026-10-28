import React, { useEffect, useRef } from 'react';
import {
  ChatPrincipal,
  ClusterNode,
  Room,
  RoomAgent,
  UiContribution,
} from '../types';

interface ExtensionSlotHostProps {
  contribution: UiContribution;
  slot: string;
  theme: 'light' | 'dark';
  principal: ChatPrincipal | null;
  room: Room | null;
  agents: RoomAgent[];
  clusterNodes: ClusterNode[];
  apiFetch: (path: string, options?: RequestInit) => Promise<any>;
  onInsertComposerText: (text: string) => void;
  onAuthSuccess: (token?: string) => Promise<void>;
  onShowError: (msg: string) => void;
  onClose: () => void;
}

export const ExtensionSlotHost: React.FC<ExtensionSlotHostProps> = ({
  contribution,
  slot,
  theme,
  principal,
  room,
  agents,
  clusterNodes,
  apiFetch,
  onInsertComposerText,
  onAuthSuccess,
  onShowError,
  onClose,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;

    const extFetch = (subpath: string, init: RequestInit = {}) => {
      const normalized = subpath.startsWith('/') ? subpath : `/${subpath}`;
      return apiFetch(`/api/v1/ext/${contribution.plugin_id}${normalized}`, init);
    };

    const hostCtx = {
      slot,
      theme,
      principal,
      room,
      agents,
      clusterNodes,
      extFetch,
      insertComposerText: onInsertComposerText,
      onAuthSuccess,
      showError: onShowError,
      close: onClose,
    };

    (async () => {
      try {
        const mod = await import(/* @vite-ignore */ contribution.entry_url);
        if (!cancelled && el && typeof mod.mount === 'function') {
          await mod.mount(el, hostCtx);
        }
      } catch (err: unknown) {
        if (!cancelled && el) {
          el.innerHTML = `<div class="p-4 text-xs text-rose-500">加载扩展模块失败 (${contribution.plugin_id}): ${
            err instanceof Error ? err.message : String(err)
          }</div>`;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    contribution.entry_url,
    contribution.plugin_id,
    slot,
    room?.room_id,
    principal?.user_id,
  ]);

  return <div ref={containerRef} className="w-full h-full" />;
};
