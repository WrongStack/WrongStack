import type { StreamEvent } from '@wrongstack/contracts/types';
import {
  CodexWebSocketRecoveryError,
  type WebSocketRecoveryCode,
} from './codex-websocket-recovery.js';
import WebSocket from './ws-runtime.js';

export { CodexWebSocketFallbackError } from './codex-websocket-recovery.js';

import { CodexWebSocketConnection } from './codex-websocket-connection.js';
import type {
  CodexResponsesParser,
  CodexWebSocketFactory,
  CodexWebSocketLike,
  CodexWebSocketOptions,
  CodexWebSocketStreamOptions,
} from './codex-websocket-types.js';
import { CODEX_ROUTING_HINT_HEADER } from './openai-codex-request.js';

export type {
  CodexResponseMetadata,
  CodexResponsesParser,
  CodexWebSocketFactory,
  CodexWebSocketLike,
  CodexWebSocketOptions,
  CodexWebSocketStreamOptions,
} from './codex-websocket-types.js';

const MAX_SESSIONS = 64;
/**
 * Opening-handshake deadline. The SSE path bounds its header phase at 60s;
 * without this an upgrade request that never gets a reply hung until the OS
 * gave up on the socket, since the frame watchdog only arms after `open`.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Bounded, per-session WebSocket reuse. A session has one in-flight request at
 * a time; later requests queue behind it so frames cannot cross conversations.
 */
export class CodexWebSocketPool {
  private readonly connections = new Map<string, CodexWebSocketConnection>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly factory: CodexWebSocketFactory,
    private readonly maxSessions = MAX_SESSIONS,
  ) {}

  async *stream(
    opts: CodexWebSocketStreamOptions,
    parse: CodexResponsesParser,
  ): AsyncIterable<StreamEvent> {
    const key = opts.request.cache?.threadId ?? opts.request.cache?.sessionId ?? '__default__';
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, chain);
    await previous.catch(() => undefined);
    try {
      let recoveryReason: WebSocketRecoveryCode | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (opts.signal.aborted)
          throw opts.signal.reason ?? new Error('Codex WebSocket request aborted');
        let connection = this.connections.get(key);
        // Handshake headers are fixed for a connection's life, so a session
        // that switched model would keep routing by the old one. The switch
        // already costs the cached prefix; a fresh handshake costs nothing more.
        if (connection && connection.routingHint !== opts.headers[CODEX_ROUTING_HINT_HEADER]) {
          connection.close();
          this.connections.delete(key);
          connection = undefined;
        }
        if (!connection) {
          connection = new CodexWebSocketConnection(
            this.factory,
            opts.url,
            opts.headers,
            opts.onHeaders,
          );
          this.connections.set(key, connection);
          while (this.connections.size > this.maxSessions) {
            const oldest = this.connections.keys().next().value;
            if (oldest === undefined || oldest === key) break;
            // Eviction must not cut another session's live response.
            this.connections.get(oldest)?.retire();
            this.connections.delete(oldest);
          }
        }
        try {
          yield* connection.stream(
            opts.body,
            recoveryReason ? { ...opts, prewarm: false, recoveryReason } : opts,
            parse,
          );
          return;
        } catch (error) {
          connection.close();
          if (this.connections.get(key) === connection) this.connections.delete(key);
          if (
            attempt === 0 &&
            error instanceof CodexWebSocketRecoveryError &&
            error.canReconnect &&
            !opts.signal.aborted
          ) {
            recoveryReason = error.code;
            continue;
          }
          throw error;
        }
      }
    } finally {
      release();
      if (this.locks.get(key) === chain) this.locks.delete(key);
    }
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.locks.clear();
  }

  /**
   * Drop every pooled connection from reuse (e.g. after token rotation, whose
   * old bearer they captured at handshake) while letting in-flight responses
   * finish. Per-key locks are kept, so a queued request still waits its turn
   * and then opens a fresh socket.
   */
  retireAll(): void {
    for (const connection of this.connections.values()) connection.retire();
    this.connections.clear();
  }
}

export function defaultCodexWebSocketFactory(
  url: string,
  options: CodexWebSocketOptions,
): CodexWebSocketLike {
  return new WebSocket(url, {
    headers: options.headers,
    followRedirects: options.followRedirects ?? false,
    handshakeTimeout: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    // `ws` accepts an AbortSignal: hand the caller's signal to the transport so
    // a handshake-time abort also tears down the underlying request.
    signal: options.signal,
  }) as CodexWebSocketLike;
}
