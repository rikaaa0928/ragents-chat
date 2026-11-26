import { useCallback, useEffect, useRef, useState } from 'react';

export interface StickyAutoScrollOptions {
  /** Maximum distance from bottom (px) to auto-repin when user explicitly scrolls DOWN to the bottom. */
  repinThresholdPx?: number;
  /** Reset and snap to bottom whenever this key changes. */
  resetKey?: string | number | null;
  /** Whether the scroll container is currently mounted/visible. */
  enabled?: boolean;
}

export function useStickyAutoScroll({
  repinThresholdPx = 12,
  resetKey,
  enabled = true,
}: StickyAutoScrollOptions = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);

  const userInteractingRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const peakScrollTopWhilePinnedRef = useRef(0);
  const programmaticGraceUntilRef = useRef(0);
  const programmaticRafRef = useRef<number | null>(null);

  const cancelPendingProgrammatic = useCallback(() => {
    programmaticGraceUntilRef.current = 0;
    if (programmaticRafRef.current !== null) {
      cancelAnimationFrame(programmaticRafRef.current);
      programmaticRafRef.current = null;
    }
  }, []);

  const setPinnedState = useCallback((next: boolean) => {
    if (pinnedRef.current !== next) {
      pinnedRef.current = next;
      setIsPinned(next);
    }
  }, []);

  const scrollToBottom = useCallback(
    (force = false) => {
      const el = containerRef.current;
      if (!el) return;
      if (!force && userInteractingRef.current) return;

      cancelPendingProgrammatic();
      setPinnedState(true);

      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
      peakScrollTopWhilePinnedRef.current = el.scrollTop;
      programmaticGraceUntilRef.current = performance.now() + 80;

      programmaticRafRef.current = requestAnimationFrame(() => {
        programmaticRafRef.current = null;
        const cur = containerRef.current;
        if (!cur || !pinnedRef.current || userInteractingRef.current) return;
        cur.scrollTop = cur.scrollHeight;
        lastScrollTopRef.current = cur.scrollTop;
        lastScrollHeightRef.current = cur.scrollHeight;
        peakScrollTopWhilePinnedRef.current = cur.scrollTop;
        programmaticGraceUntilRef.current = performance.now() + 80;
      });
    },
    [cancelPendingProgrammatic, setPinnedState]
  );

  // Reset to pinned bottom when room or inspected session changes
  useEffect(() => {
    if (!enabled) return;
    userInteractingRef.current = false;
    lastScrollTopRef.current = 0;
    lastScrollHeightRef.current = 0;
    peakScrollTopWhilePinnedRef.current = 0;
    scrollToBottom(true);
    return cancelPendingProgrammatic;
  }, [resetKey, enabled, scrollToBottom, cancelPendingProgrammatic]);

  // Global release listener so scrollbar thumb drags NEVER fight React/SSE updates
  useEffect(() => {
    const handlePointerRelease = () => {
      if (!userInteractingRef.current) return;
      userInteractingRef.current = false;
      const el = containerRef.current;
      if (!el) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (!pinnedRef.current && distanceFromBottom <= 8) {
        setPinnedState(true);
        peakScrollTopWhilePinnedRef.current = el.scrollTop;
      }
      lastScrollTopRef.current = el.scrollTop;
      lastScrollHeightRef.current = el.scrollHeight;
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (userInteractingRef.current && e.pointerType === 'mouse' && e.buttons === 0) {
        handlePointerRelease();
      }
    };

    window.addEventListener('pointerup', handlePointerRelease, { passive: true });
    window.addEventListener('mouseup', handlePointerRelease, { passive: true });
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointercancel', handlePointerRelease, { passive: true });
    window.addEventListener('touchend', handlePointerRelease, { passive: true });
    window.addEventListener('touchcancel', handlePointerRelease, { passive: true });
    window.addEventListener('blur', handlePointerRelease);
    return () => {
      window.removeEventListener('pointerup', handlePointerRelease);
      window.removeEventListener('mouseup', handlePointerRelease);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointercancel', handlePointerRelease);
      window.removeEventListener('touchend', handlePointerRelease);
      window.removeEventListener('touchcancel', handlePointerRelease);
      window.removeEventListener('blur', handlePointerRelease);
    };
  }, [setPinnedState]);

  // Keep pinned at bottom when inner content height grows (streaming text wraps, images load)
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    const contentEl = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const snapIfPinned = () => {
      const cur = containerRef.current;
      if (!cur || !pinnedRef.current || userInteractingRef.current) return;
      const distanceFromBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      if (distanceFromBottom > 2) {
        cur.scrollTop = cur.scrollHeight;
        lastScrollTopRef.current = cur.scrollTop;
        lastScrollHeightRef.current = cur.scrollHeight;
        peakScrollTopWhilePinnedRef.current = cur.scrollTop;
        programmaticGraceUntilRef.current = performance.now() + 80;
      }
    };

    const ro = new ResizeObserver(snapIfPinned);
    ro.observe(el);
    if (contentEl) {
      ro.observe(contentEl);
    }
    return () => ro.disconnect();
  }, [enabled, resetKey]);

  const handlePointerDown = useCallback(() => {
    userInteractingRef.current = true;
    cancelPendingProgrammatic();
  }, [cancelPendingProgrammatic]);

  const handleTouchStart = useCallback(() => {
    userInteractingRef.current = true;
    cancelPendingProgrammatic();
  }, [cancelPendingProgrammatic]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (e.deltaY < 0) {
        cancelPendingProgrammatic();
        setPinnedState(false);
      }
    },
    [cancelPendingProgrammatic, setPinnedState]
  );

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const now = performance.now();
    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const heightShrank = scrollHeight < lastScrollHeightRef.current - 2;
    const prevScrollTop = lastScrollTopRef.current;

    lastScrollTopRef.current = scrollTop;
    lastScrollHeightRef.current = scrollHeight;

    // Ignore async scroll events immediately caused by our own scrollToBottom()
    if (
      now < programmaticGraceUntilRef.current &&
      !userInteractingRef.current &&
      scrollTop >= prevScrollTop - 2
    ) {
      peakScrollTopWhilePinnedRef.current = Math.max(
        peakScrollTopWhilePinnedRef.current,
        scrollTop
      );
      return;
    }

    programmaticGraceUntilRef.current = 0;

    if (pinnedRef.current) {
      if (
        !heightShrank &&
        (scrollTop < prevScrollTop - 0.5 ||
          scrollTop < peakScrollTopWhilePinnedRef.current - 2)
      ) {
        setPinnedState(false);
        return;
      }
      peakScrollTopWhilePinnedRef.current = Math.max(
        peakScrollTopWhilePinnedRef.current,
        scrollTop
      );
    } else if (
      !heightShrank &&
      ((scrollTop > prevScrollTop + 0.5 && distanceFromBottom <= repinThresholdPx) ||
        distanceFromBottom <= 2)
    ) {
      setPinnedState(true);
      peakScrollTopWhilePinnedRef.current = scrollTop;
    }
  }, [repinThresholdPx, setPinnedState]);

  return {
    containerRef,
    contentRef,
    pinnedRef,
    isPinned,
    scrollToBottom,
    scrollContainerProps: {
      onScroll: handleScroll,
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onTouchStart: handleTouchStart,
    },
  };
}
