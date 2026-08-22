import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono';
import '@xyflow/react/dist/style.css';
import type { HqSnapshot } from '@wrongstack/core/hq';
import {
  projectHqAlertMessage,
  projectHqCommandStatusMessage,
  projectHqEventMessage,
  projectHqFleetMessage,
} from '@wrongstack/webui-protocol';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HqApp } from './app.js';
import {
  exchangeBootstrapIfNeeded,
  scrubTokenFromUrl,
  upgradeStoredTokenToCookie,
} from './lib/auth.js';
import { getHqClient } from './lib/hq-ws-client.js';
import { fetchJson, useHqStore } from './store.js';

const container = document.getElementById('root');
if (container !== null) {
  // Bootstrap exchange: if the URL carries a one-time code in the fragment,
  // exchange it for an HttpOnly session cookie before starting the SPA.
  // The fragment is scrubbed on success and the cookie carries forward on
  // all subsequent HTTP and WebSocket requests.
  void exchangeBootstrapIfNeeded().finally(() => {
    scrubTokenFromUrl();

    // WS-065: mint the HttpOnly session cookie for any stored token. The
    // stored copy is deliberately KEPT — it is the reload-survival fallback
    // when the server's in-memory session is gone (restart, idle eviction).
    // Deliberately not awaited — it must not delay first paint, and both
    // orderings are correct: a WS URL built before the swap still carries a
    // valid token, one built after rides the cookie.
    void upgradeStoredTokenToCookie();

    const client = getHqClient({
      resumeCursor: () => useHqStore.getState().resumeCursors,
    });
    client.onStateChange((connectionState) => {
      useHqStore.getState()._setConnected(connectionState === 'connected');
    });
    // `needsSnapshotRefresh` is the single channel through which the store
    // requests an authoritative `/api/snapshot` fetch. It is set exactly
    // once per WS reconnect — when the server replies with `hq.resume_reject`
    // (gap too large, log unavailable, last-seen too old). The subscriber
    // below consumes the transition `false → true` exactly once and fetches
    // the HTTP snapshot. The `hq.resume_reject` handler also drops the live
    // resume cursors so the next reconnect's gap-fill starts from the
    // post-refresh state. A previous iteration also subscribed on
    // `snapshot.generatedAt`; that channel must NOT trigger a refresh
    // because the server mints a fresh `generatedAt` on every
    // `buildSnapshot()` call (snapshot.ts:136), so the HTTP refresh response
    // would always re-arm the gate.
    let inFlightRefresh: Promise<void> | null = null;
    const triggerRefresh = (): void => {
      if (inFlightRefresh !== null) return;
      // Clear the flag synchronously so a second subscribe firing during
      // the in-flight fetch (StrictMode, React batching, etc.) does not
      // queue another fetch.
      useHqStore.getState()._setNeedsSnapshotRefresh(false);
      inFlightRefresh = fetchJson<HqSnapshot>('/api/snapshot')
        .then((snapshot) => {
          useHqStore.getState()._onSnapshot(snapshot);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlightRefresh = null;
        });
    };
    useHqStore.subscribe((state, prev) => {
      if (state.needsSnapshotRefresh && !prev.needsSnapshotRefresh) {
        triggerRefresh();
      }
    });
    client.on((msg) => {
      if (msg.type === 'hq.snapshot') {
        const projection = projectHqFleetMessage(msg);
        if (projection) useHqStore.getState()._onSnapshot(projection.snapshot);
      } else if (msg.type === 'hq.event') {
        const projection = projectHqEventMessage(msg);
        if (projection) useHqStore.getState()._onEvent(projection.event);
      } else if (msg.type === 'hq.alert') {
        const projection = projectHqAlertMessage(msg);
        if (projection) useHqStore.getState()._onAlert(projection.alert);
      } else if (msg.type === 'hq.command_status') {
        const projection = projectHqCommandStatusMessage(msg);
        if (projection) useHqStore.getState()._onCommandStatus(projection.command);
      } else if (msg.type === 'hq.resume_gap') {
        for (const event of msg.envelopes) {
          const projection = projectHqEventMessage({ type: 'hq.event', event });
          if (projection) useHqStore.getState()._onEvent(projection.event);
        }
        // The server never emits `truncated: true`; oversized gaps are
        // signalled via `hq.resume_reject` and a snapshot handoff.
      } else if (msg.type === 'hq.resume_reject') {
        // Authoritative refresh path: drop live resume cursors so the next
        // reconnect's gap-fill starts from the post-refresh state. Co-located
        // with the trigger so the reset is not coupled to the fetch lifecycle
        // and cannot be reached by a non-authoritative refresh path.
        useHqStore.getState()._resetResumeCursors();
        useHqStore.getState()._setNeedsSnapshotRefresh(true);
      }
    });

    const root = createRoot(container);
    root.render(
      <React.StrictMode>
        <HqApp />
      </React.StrictMode>,
    );
  });
}
