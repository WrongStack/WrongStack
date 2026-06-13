// Eternal-autonomy iteration broadcast wiring.
//
// The CLI's `runWebUI` owns the eternal-autonomy engine and exposes a
// `subscribeEternalIteration` callback that lets the webui hook into
// the journal-entry stream. This module extracts the wiring in
// isolation so it can be unit-tested without spinning up the full
// server (clients, WS, HTTP bring-up).
//
// `createEternalSubscription` is the helper that:
//   1. Calls the caller-supplied `subscribe` function with a broadcast
//      closure bound to the current `clients` Map.
//   2. Captures the returned disposer so `tearDown` can invoke it on
//      server shutdown.
//
// Both the disposer and the `JournalEntry` are projected by the caller
// — this module intentionally knows nothing about the engine itself.

import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';
import type { JournalEntry } from '@wrongstack/core';

export type EternalSubscribe = (
  fn: (entry: JournalEntry) => void,
) => () => void;

// `clients` is generic so callers that use a structurally-similar
// `ConnectedClient` (the CLI's own Map<WebSocket, { ws; sessionId }>,
// for example) don't have to alias their type to webui's
// `ConnectedClient`. The helper doesn't read the value at all —
// `broadcast` gets to decide whether to use the map or not — so we
// only need the key type (WebSocket) to be present, which is
// enforced by the constraint.
export type EternalBroadcast<C> = (clients: Map<WebSocket, C>, msg: WSServerMessage) => void;

export interface EternalSubscription {
  /** Tear down the underlying engine subscription. Idempotent. */
  dispose: () => void;
}

export function createEternalSubscription<C>(
  subscribe: EternalSubscribe,
  broadcast: EternalBroadcast<C>,
  clientsRef: () => Map<WebSocket, C>,
): EternalSubscription {
  let disposed = false;
  const dispose = subscribe((entry) => {
    if (disposed) return;
    broadcast(clientsRef(), {
      type: 'eternal.iteration',
      payload: { entry },
    });
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  };
}
