import { getWSClient } from '@/lib/ws-client';
import { isActiveSessionMessage } from '@/lib/ws-client-utils';
import type { WSServerMessage } from '@/types';
import { useCallback, useEffect, useRef, useState } from 'react';

const FIRST_SNAPSHOT_TIMEOUT_MS = 5_000;

/**
 * Per-payload shape returned by the server's `context.debug` WS message.
 * Kept loose (the modal re-types the fields it cares about) so a future
 * server-side addition does not break every consumer of the hook.
 */
export interface LiveContextDebugPayload {
  total: number;
  mode?: string | undefined;
  policy?: unknown | undefined;
  systemPrompt: number;
  tools: {
    total: number;
    count: number;
    breakdown: Array<{ name: string; tokens: number }>;
  };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
}

export interface UseLiveContextDebugOptions {
  /**
   * When `false`, the hook idles: no subscription, no polling, no
   * requests. Defaults to `true` so a typical modal consumer can call
   * the hook unconditionally.
   */
  active?: boolean | undefined;
  /**
   * Polling cadence in milliseconds. 2 s is fast enough to look
   * "live" during in-flight agent runs without flooding the server
   * when nothing is moving. Tune per consumer if needed.
   */
  intervalMs?: number | undefined;
  /**
   * When `true` (the default), pause polling while `document.hidden`
   * and fire one catch-up request on visibility regain. Off by default
   * in non-DOM test environments.
   */
  pauseWhenHidden?: boolean | undefined;
}

export interface UseLiveContextDebugResult<T extends LiveContextDebugPayload> {
  /**
   * Latest snapshot, or `null` until the first response arrives. Each
   * incoming payload overwrites the prior one — the most recent server
   * payload always wins, so consumers never see a stale value after a
   * refresh.
   */
  data: T | null;
  /**
   * `true` only while the first snapshot is in flight. Subsequent
   * snapshots never re-trigger the loading indicator, so a refresh
   * does not blank the UI mid-update.
   */
  loading: boolean;
  /** Last error message, or `null`. Resets on every successful snapshot. */
  error: string | null;
  /**
   * Imperative restart: bumps a generation counter that triggers an
   * immediate request and re-arms the polling cadence. Use for an
   * explicit "refresh" button.
   */
  refresh: () => void;
  /**
   * Wall-clock time of the most recent successful snapshot, or `null`.
   * Useful for "last updated 3s ago" affordances.
   */
  lastUpdatedAt: number | null;
}

/**
 * Subscribe-and-poll wrapper around the server `context.debug` WS
 * message. While `active` is true the hook:
 *
 *   1. Subscribes to `context.debug` for the hook's lifetime.
 *   2. Sends an immediate request.
 *   3. Polls every `intervalMs` (default 2 s).
 *   4. Pauses on `document.hidden` and catches up on regain, unless
 *      `pauseWhenHidden` is `false`.
 *
 * Latest snapshot wins. Transient `send()` failures (closed socket
 * during reconnect) are swallowed — the next tick retries.
 *
 * @example
 *   const { data, loading, error, refresh } = useLiveContextDebug(wsUrl, {
 *     active: open,
 *   });
 */
export function useLiveContextDebug<T extends LiveContextDebugPayload = LiveContextDebugPayload>(
  wsUrl: string,
  options: UseLiveContextDebugOptions = {},
): UseLiveContextDebugResult<T> {
  const { active = true, intervalMs = 2000, pauseWhenHidden = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  // Increment to restart the fetch cycle (refresh button). Changing the
  // value re-runs the effect, which re-arms the subscription + cadence.
  const [refreshGen, setRefreshGen] = useState(0);
  // Tracks whether at least one snapshot has arrived; controls whether
  // the loading indicator is shown. Survives across refreshes so an
  // in-flight refresh does not blank the UI.
  const hasSnapshotRef = useRef(false);

  const refresh = useCallback(() => {
    setRefreshGen((g) => g + 1);
  }, []);

  useEffect(() => {
    if (!active) {
      hasSnapshotRef.current = false;
      setData(null);
      setError(null);
      setLastUpdatedAt(null);
      setRefreshGen(0);
      return;
    }

    const ws = getWSClient(wsUrl);
    if (!ws?.send || !ws.on) {
      setError('WebSocket not connected');
      setLoading(false);
      return;
    }

    if (!hasSnapshotRef.current) {
      setLoading(true);
    }
    setError(null);

    const handler = (msg: { type: string; payload?: unknown }) => {
      if (msg.type !== 'context.debug') return;
      if (!isActiveSessionMessage(msg as WSServerMessage)) return;
      const payload = msg.payload as T | undefined;
      if (!payload || typeof payload !== 'object' || !('tools' in payload) || !('messages' in payload)) {
        return;
      }
      hasSnapshotRef.current = true;
      setData(payload);
      setError(null);
      setLoading(false);
      setLastUpdatedAt(Date.now());
    };
    const unsubscribe = ws.on('context.debug', handler);

    /** Issue a request, swallowing transient send errors (e.g. closed
     *  socket during reconnect). The subscription picks up the next
     *  reply once the link is healthy. */
    const requestSnapshot = () => {
      try {
        const withSession =
          'withSession' in ws && typeof ws.withSession === 'function'
            ? (ws.withSession as (p: Record<string, unknown>) => Record<string, unknown>)({})
            : {};
        ws.send(
          { type: 'context.debug', ...(Object.keys(withSession).length > 0 ? { payload: withSession } : {}) },
          { echoToChat: false, queueIfDisconnected: false },
        );
      } catch {
        // Next tick of the poll will retry; do not surface a transient
        // send failure as a fatal error.
      }
    };

    requestSnapshot();
    const timeout = setTimeout(() => {
      if (!hasSnapshotRef.current) {
        setLoading(false);
        setError((prev) => prev ?? 'Timed out waiting for context snapshot');
      }
    }, FIRST_SNAPSHOT_TIMEOUT_MS);

    let timer: ReturnType<typeof setInterval> | null = null;
    const startTimer = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (pauseWhenHidden && typeof document !== 'undefined' && document.hidden) return;
        requestSnapshot();
      }, intervalMs);
    };
    const stopTimer = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopTimer();
      } else {
        requestSnapshot();
        startTimer();
      }
    };
    startTimer();
    if (pauseWhenHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      clearTimeout(timeout);
      stopTimer();
      unsubscribe();
      if (pauseWhenHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [active, wsUrl, refreshGen, intervalMs, pauseWhenHidden]);

  return { data, loading, error, refresh, lastUpdatedAt };
}
