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
import type { ConnectedClient, WSServerMessage } from './types.js';
import type { JournalEntry } from '@wrongstack/core';

export type EternalSubscribe = (
  fn: (entry: JournalEntry) => void,
) => () => void;

export type EternalBroadcast = (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;

export interface EternalSubscription {
  /** Tear down the underlying engine subscription. Idempotent. */
  dispose: () => void;
}

export function createEternalSubscription(
  subscribe: EternalSubscribe,
  broadcast: EternalBroadcast,
  clientsRef: () => Map<WebSocket, ConnectedClient>,
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
