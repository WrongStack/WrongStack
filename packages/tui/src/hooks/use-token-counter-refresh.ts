import type { CacheStats, EventBus, TokenCounter, Usage } from '@wrongstack/core';
import { useEffect, useState } from 'react';

export interface TokenRefreshData {
  usage: Usage;
  /** Last request prompt tokens from the counter, used when provider usage is unavailable. */
  currentRequest: { input: number; cacheRead: number };
  cost: { input: number; output: number; total: number; currency: 'USD' };
  cacheStats: CacheStats;
}

export function snapshotTokenCounter(tokenCounter: TokenCounter): TokenRefreshData {
  return {
    usage: tokenCounter.total(),
    currentRequest: tokenCounter.currentRequestTokens(),
    cost: tokenCounter.estimateCost(),
    cacheStats: tokenCounter.cacheStats(),
  };
}

/**
 * Subscribes to `token.accounted` events and forces a re-render so StatusBar
 * always shows fresh token/cost data without waiting for the slow polling
 * interval that would otherwise gate them.
 *
 * Without this hook, the StatusBar reads from a mutable `tokenCounter`
 * object on each render, but React only re-renders when state/props change.
 * The tokenCounter is mutated by `account()` calls that arrive asynchronously
 * from provider responses, causing stale data for up to 10 seconds.
 */
export function useTokenCounterRefresh(
  tokenCounter: TokenCounter | undefined,
  events: EventBus | undefined,
  sessionId?: string | undefined,
): TokenRefreshData | undefined {
  const [data, setData] = useState<TokenRefreshData | undefined>(() =>
    tokenCounter ? snapshotTokenCounter(tokenCounter) : undefined,
  );

  useEffect(() => {
    if (!tokenCounter) {
      setData(undefined);
      return;
    }

    const snapshot = () => snapshotTokenCounter(tokenCounter);

    // Keep the rendered values in sync when App receives a new counter instance
    // (for example after an in-place project/session switch), even before the
    // next provider response emits token.accounted.
    setData(snapshot());

    if (!events) return;

    const off = events.on('token.accounted', (event) => {
      if (sessionId && event.sessionId && event.sessionId !== sessionId) return;
      setData(snapshot());
    });

    return off;
  }, [tokenCounter, events, sessionId]);

  return data;
}
