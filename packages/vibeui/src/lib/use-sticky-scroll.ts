'use client';

import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';

/** Within this many pixels of the bottom the conversation counts as "following". */
export const STICK_THRESHOLD_PX = 100;

export function isNearBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
}

/**
 * Keeps a scroll container pinned to the newest content while the user follows
 * along. Disable following on non-conversation surfaces such as the welcome screen.
 * Scrolling up releases it and offers "Latest"; `resetKey` (the session
 * id) re-pins. `followDeps` lists whatever grows the content.
 */
export function useStickyScroll<T extends HTMLElement>(
  followDeps: DependencyList,
  resetKey: string,
  enabled = true,
) {
  const ref = useRef<T>(null);
  const stick = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    stick.current = true;
    setShowLatest(false);
    if (!enabled && ref.current) ref.current.scrollTop = 0;
  }, [resetKey, enabled]);
  useEffect(() => {
    if (enabled && stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [enabled, resetKey, ...followDeps]);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    stick.current = isNearBottom(el);
    setShowLatest(!stick.current);
  }, [enabled]);
  const jumpToLatest = useCallback(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    stick.current = true;
    setShowLatest(false);
  }, []);
  /** Stop following before jumping elsewhere (e.g. to a search hit). */
  const release = useCallback(() => {
    stick.current = false;
    setShowLatest(true);
  }, []);
  return { ref, showLatest, onScroll, jumpToLatest, release };
}
