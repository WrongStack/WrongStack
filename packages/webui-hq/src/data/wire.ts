/**
 * Wire — the only place the transport meets the store.
 *
 * Two responsibilities:
 *  1. Translate `/ws/browser` frames into store actions, via the shared
 *     `@wrongstack/webui-protocol` projectors (never by reading raw fields).
 *  2. Own the authoritative-refresh gate: exactly one `/api/snapshot` fetch
 *     per reconnect that the server could not gap-fill.
 */
import type { HqSnapshot } from '@wrongstack/core/hq';
import {
  projectHqAlertMessage,
  projectHqCommandStatusMessage,
  projectHqEventMessage,
  projectHqFleetMessage,
} from '@wrongstack/webui-protocol';
import { fetchJson } from './api.js';
import { upgradeStoredTokenToCookie } from './auth/index.js';
import {
  getHqSocket,
  type HqSocketMessage,
  type HqSocketOptions,
  type HqSocketState,
} from './transport/hq-socket.js';
import { useHqStore } from './store/index.js';

type HqStoreApi = typeof useHqStore;

/**
 * Fold one socket frame into the store.
 *
 * `hq.resume_reject` is the server saying "your gap is too large / the log is
 * gone / your cursor is too old". Both halves matter: the cursors are dropped
 * so the next reconnect starts from the post-refresh state, and the refresh
 * flag is raised so the gate below fetches the authoritative snapshot once.
 * The reset is co-located with the raise so it can never be reached by some
 * other, non-authoritative refresh path.
 */
export function applySocketMessage(store: HqStoreApi, message: HqSocketMessage): void {
  const state = store.getState();
  switch (message.type) {
    case 'hq.snapshot': {
      const projection = projectHqFleetMessage(message);
      if (projection) state.applySnapshot(projection.snapshot);
      return;
    }
    case 'hq.event': {
      const projection = projectHqEventMessage(message);
      if (projection) state.applyEvent(projection.event);
      return;
    }
    case 'hq.alert': {
      const projection = projectHqAlertMessage(message);
      if (projection) state.applyAlert(projection.alert);
      return;
    }
    case 'hq.command_status': {
      const projection = projectHqCommandStatusMessage(message);
      if (projection) state.applyCommandStatus(projection.command);
      return;
    }
    case 'hq.resume_gap': {
      // The server never emits `truncated: true`; an oversized gap arrives as
      // `hq.resume_reject` plus a snapshot handoff instead.
      for (const envelope of message.envelopes) {
        const projection = projectHqEventMessage({ type: 'hq.event', event: envelope });
        if (projection) state.applyEvent(projection.event);
      }
      return;
    }
    case 'hq.resume_reject': {
      state.resetResumeCursors();
      state.setNeedsSnapshotRefresh(true);
      return;
    }
    default:
      // Heartbeats and any frame a newer server introduces are ignored on
      // purpose — an unknown type must never break an older dashboard.
      return;
  }
}

/**
 * Arm the once-per-reconnect snapshot refresh.
 *
 * The flag is cleared SYNCHRONOUSLY before the fetch starts, and a second
 * in-flight attempt is refused, so a subscriber firing twice (StrictMode,
 * React batching) cannot queue a second request.
 *
 * The gate must never key on `snapshot.generatedAt`: the server mints a fresh
 * timestamp on every `buildSnapshot()` call, so the refresh response itself
 * would re-arm the gate and the fetch would loop forever.
 */
export function armSnapshotRefresh(store: HqStoreApi): () => void {
  let inFlight: Promise<void> | null = null;

  const refresh = (): void => {
    if (inFlight !== null) return;
    store.getState().setNeedsSnapshotRefresh(false);
    inFlight = fetchJson<HqSnapshot>('/api/snapshot')
      .then((snapshot) => {
        store.getState().applySnapshot(snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  return store.subscribe((state, previous) => {
    if (state.needsSnapshotRefresh && !previous.needsSnapshotRefresh) refresh();
  });
}

/** Seed the first paint from HTTP. Never overwrites a snapshot the WS already delivered. */
export function hydrateFromHttp(store: HqStoreApi): () => void {
  let cancelled = false;
  fetchJson<HqSnapshot>('/api/snapshot')
    .then((snapshot) => {
      if (!cancelled) store.getState().hydrateSnapshot(snapshot);
    })
    .catch(() => {
      // A 401 already raised the gate via `fetchJson`; the socket's reconnect
      // loop handles plain network failures.
    });
  return () => {
    cancelled = true;
  };
}

/**
 * Opportunistic cookie re-mint for reconnects.
 *
 * The HttpOnly session cookie is the ONLY credential a browser WebSocket can
 * carry — `Authorization` headers do not exist on `WebSocket`, and the URL
 * token is deliberately stripped off loopback. Server sessions are in-memory
 * (30-min idle eviction, wiped by any server restart, rotated with the cookie
 * secret), and the boot-time cookie upgrade in `main.tsx` runs exactly once
 * per page load — so a tab left open across any of those events used to lose
 * its live feed forever: the socket sat "reconnecting…" until a manual
 * reload, which reads as "logged out". This re-mints the cookie from the
 * still-stored browser token, throttled, whenever the transport starts
 * reconnecting. A genuinely dead token fails the upgrade silently (the
 * stored token is untouched), and a later REST 401 raises the gate as before.
 */
export function createReconnectReauthorizer(
  upgrade: () => Promise<boolean> = upgradeStoredTokenToCookie,
  minIntervalMs = 30_000,
  now: () => number = Date.now,
): (state: HqSocketState) => void {
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  return (state) => {
    if (state !== 'reconnecting') return;
    const at = now();
    if (at - lastAttemptAt < minIntervalMs) return;
    lastAttemptAt = at;
    void upgrade().catch(() => undefined);
  };
}

/**
 * Connect the live data plane. Returns a teardown that removes every
 * subscription (the socket singleton itself is torn down by `closeHqSocket`).
 */
export function connectHqDataPlane(options?: HqSocketOptions): () => void {
  const socket = getHqSocket({
    resumeCursor: () => useHqStore.getState().resumeCursors,
    ...options,
  });

  const unsubscribeRefresh = armSnapshotRefresh(useHqStore);
  const cancelHydrate = hydrateFromHttp(useHqStore);
  const reauthorizeOnReconnect = createReconnectReauthorizer();
  const unsubscribeReauth = socket.onStateChange(reauthorizeOnReconnect);
  const unsubscribeState = socket.onStateChange((state) => {
    useHqStore.getState().setConnected(state === 'connected');
  });
  const unsubscribeMessages = socket.on((message) => {
    applySocketMessage(useHqStore, message);
  });

  return () => {
    unsubscribeMessages();
    unsubscribeState();
    unsubscribeReauth();
    unsubscribeRefresh();
    cancelHydrate();
  };
}
