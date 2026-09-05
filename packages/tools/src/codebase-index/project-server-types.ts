import type * as net from 'node:net';
import type { OpShapes } from './worker-protocol.js';

export interface ClientState {
  socket: net.Socket;
  /**
   * Raw inbound bytes. Frames may be newline-delimited JSON or length-
   * prefixed binary (magic 0x57); the mode is sniffed per frame. Kept as
   * bytes because a JSON text line may split a multibyte UTF-8 sequence at a
   * chunk boundary — the StringDecoder handles that at parse time.
   */
  buffer: Buffer;
  cancelled: Set<number>;
  cancel: Map<number, () => void>;
  watchExternal: boolean;
  debounceMs: number;
  coalesceWindowMs: number;
  lastSeenAt: number;
  /** True once this client has sent at least one binary frame. */
  binary: boolean;
}

export interface FullIndexSubscriber {
  state: ClientState;
  id: number;
}

export interface ActiveFullIndex {
  promise: Promise<OpShapes['index']['result']>;
  controller: AbortController;
  subscribers: Set<FullIndexSubscriber>;
}
