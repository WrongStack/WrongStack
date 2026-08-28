/**
 * useMemoryForFile — file-drawer hook.
 *
 * Subscribes to `memory.sage.forFile` responses and exposes the latest
 * file-scoped memory matches for the drawer UI. Read-only: opening a file
 * must never mutate the memory store (PR #4 contract).
 *
 * The hook is deliberately lightweight: it owns a single subscription and
 * exposes a `refetch` so the UI can re-query when the cursor moves or the
 * "Show Recoverable" toggle flips.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getWSClient, type WSSendOptions } from '@/lib/ws-client';
import type { MemoryForFileResponse } from '@/types';

interface UseMemoryForFileOptions {
  /** Project-relative file path. When null the hook stays idle. */
  filePath: string | null;
  /** Optional cursor range — symbol anchors overlapping get a boost. */
  lineStart?: number;
  lineEnd?: number;
  /** Per-bucket cap. Default 50. */
  limit?: number;
  /** Default true. Include superseded memories (with supersededByActiveId). */
  showSuperseded?: boolean;
  /**
   * Default false. Set true (typically via a "Show recoverable" UI toggle)
   * to surface `status='deleted'` memories for one-click recovery.
   */
  showDeleted?: boolean;
  /** When true, the request is fired automatically when inputs change. */
  autoFetch?: boolean;
  /** Optional WS send options (correlation id, abort, …). */
  sendOptions?: WSSendOptions;
}

interface UseMemoryForFileResult {
  data: MemoryForFileResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * The server answers with the *normalized* project-relative path, which can
 * differ from what the caller sent (backslashes on Windows, a `./` prefix,
 * doubled separators). Comparing the raw strings made every such response
 * look like it belonged to another consumer, and the cross-instance guard
 * below dropped it — leaving the drawer stuck on "Loading…". Normalize both
 * sides before deciding a response is foreign.
 */
function normalizePathForCompare(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

const EMPTY_RESPONSE: MemoryForFileResponse = {
  filePath: '',
  primaryMatches: [],
  symbolMatches: [],
  relatedMatches: [],
  totalCount: 0,
  activeCount: 0,
  supersededCount: 0,
  reviewPendingCount: 0,
};

export function useMemoryForFile(options: UseMemoryForFileOptions): UseMemoryForFileResult {
  const {
    filePath,
    lineStart,
    lineEnd,
    limit = 50,
    showSuperseded = true,
    showDeleted = false,
    autoFetch = true,
    // `sendOptions` is JSON.stringified into a stable key so that an
    // inline object identity change from the parent doesn't refire the
    // effect every render. The actual options value flows into
    // `fetchNow` via a ref (see below) — a primitive JSON form is enough
    // to detect real changes.
    sendOptions,
  } = options;
  const sendOptionsKey = sendOptions ? JSON.stringify(sendOptions) : '';

  const [data, setData] = useState<MemoryForFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest response wins — older responses are dropped to avoid race noise.
  const requestSeq = useRef(0);
  // Track the currently-active subscription so manual `refetch()` doesn't
  // leak handlers into the singleton WS client's handler Set.
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // `fetchNow` reads sendOptions through a ref so it doesn't take the
  // object identity as a dep (a caller passing `{...}` inline would
  // otherwise refire on every render).
  const sendOptionsRef = useRef(sendOptions);
  sendOptionsRef.current = sendOptions;

  const fetchNow = useCallback(() => {
    if (!filePath) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);

    const client = getWSClient();
    if (!client) {
      setError('WebSocket client unavailable');
      setLoading(false);
      return;
    }

    // Tear down any previous subscription before installing a new one —
    // manual `refetch()` would otherwise pile handlers onto the singleton
    // WS client without ever removing the old ones.
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;

    // Capture the file path this request is for, so a late response from
    // a *different* hook instance (or a previous query for another file)
    // can't cross-wire into this hook's state.
    const requestedFilePath = filePath;

    const unsubscribe = client.on('memory.sage.forFile', (message) => {
      if (seq !== requestSeq.current) return; // stale (re-fired)
      const response = message.payload.response;
      // Cross-instance guard: even if our seq is current, a response for
      // a different file belongs to a different consumer.
      if (
        response &&
        normalizePathForCompare(response.filePath) !==
          normalizePathForCompare(requestedFilePath)
      )
        return;
      if (message.payload.error) {
        setError(message.payload.error);
        setData(null);
      } else {
        setData(response ?? EMPTY_RESPONSE);
        setError(null);
      }
      setLoading(false);
    });

    unsubscribeRef.current = unsubscribe;

    // Build the request payload — strip undefined fields so the server
    // sees only what was explicitly set (matches the tool-side contract).
    const payload = {
      filePath,
      limit,
      showSuperseded,
      showDeleted,
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
    };

    try {
      client.findMemoriesForFile(payload, sendOptionsRef.current ?? undefined);
    } catch (err) {
      unsubscribe();
      if (unsubscribeRef.current === unsubscribe) unsubscribeRef.current = null;
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
  }, [filePath, lineStart, lineEnd, limit, showSuperseded, showDeleted]);

  useEffect(() => {
    if (!autoFetch) return;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    fetchNow();
    return () => {
      // Bump sequence so any in-flight response is dropped.
      requestSeq.current++;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [autoFetch, fetchNow, sendOptionsKey]);

  // refetch is stable across renders so callers can drop it into a
  // dependency array without causing effect loops. Manual refetch
  // tears down the previous handler before installing the new one
  // (see `fetchNow`).
  const refetch = useCallback(() => {
    fetchNow();
  }, [fetchNow]);

  // Unmount-only cleanup: ensure we never leave a handler attached.
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  return { data, loading, error, refetch };
}
