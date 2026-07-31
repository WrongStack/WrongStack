/**
 * WebSocketClientTransport — remote ACP transport for `ACPSession`.
 *
 * Connects to a remote ACP agent over a WebSocket (cloud-hosted agents,
 * separate-process agents reachable over the network). Each WebSocket
 * message carries exactly one JSON-RPC 2.0 object — message boundaries
 * are preserved by the WS framing, so (unlike stdio) no newline delimiter
 * is needed.
 *
 * Uses the Node ≥ 22 built-in global `WebSocket` (undici), so there is no
 * runtime dependency. Per-connection auth headers are not supported by the
 * WHATWG WebSocket client; authenticate over the protocol instead
 * (`ACPSession.authenticate`) or embed a token in the URL query string.
 *
 * Spec: https://agentclientprotocol.com/protocol/v1/overview (remote transport)
 */

import type { ACPClientTransport } from '../agent/stdio-transport.js';
import type { ACPMessage } from '../types/acp-messages.js';

export interface WebSocketClientTransportOptions {
  /** ws:// or wss:// URL of the remote ACP agent. */
  url: string;
  /** Optional WebSocket subprotocols. */
  protocols?: string | string[] | undefined;
  /** How long to wait for the socket to open. Default 30s. */
  handshakeTimeoutMs?: number | undefined;
  /** Maximum unsent bytes retained by the WebSocket implementation. Default 32 MiB. */
  maxBufferedBytes?: number | undefined;
  /** Maximum inbound message size in characters. Default 20 MiB. */
  maxMessageChars?: number | undefined;
}

/** Narrow view of the global WebSocket we rely on (avoids lib.dom typings). */
interface WSLike {
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

type WSConstructor = new (url: string, protocols?: string | string[]) => WSLike;

export class WebSocketClientTransport implements ACPClientTransport {
  private ws: WSLike | null = null;
  private readonly handlers = new Set<(msg: ACPMessage) => void>();
  private closed = false;
  private readonly opts: WebSocketClientTransportOptions;
  private readonly maxBufferedBytes: number;
  private readonly maxMessageChars: number;

  constructor(opts: WebSocketClientTransportOptions) {
    this.opts = opts;
    this.maxBufferedBytes = finitePositiveLimit(opts.maxBufferedBytes, 32 * 1024 * 1024);
    this.maxMessageChars = finitePositiveLimit(opts.maxMessageChars, 20 * 1024 * 1024);
  }

  /** Pending start() promise resolve/reject — settled in stop() to avoid leaking. */
  private pendingStart: {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  start(): Promise<void> {
    if (this.closed || this.ws !== null || this.pendingStart !== null) {
      return Promise.reject(new Error('WebSocket transport has already been started or stopped'));
    }
    const WS = (globalThis as { WebSocket?: WSConstructor }).WebSocket;
    if (!WS) {
      return Promise.reject(
        new Error(
          'global WebSocket is not available — Node ≥ 22 is required for the remote ACP transport',
        ),
      );
    }
    const timeoutMs = this.opts.handshakeTimeoutMs ?? 30_000;
    return new Promise<void>((resolve, reject) => {
      const ws = new WS(this.opts.url, this.opts.protocols);
      this.ws = ws;
      const timer = setTimeout(() => {
        const pending = this.pendingStart;
        if (pending === null) return;
        this.pendingStart = null;
        this.closed = true;
        if (this.ws === ws) this.ws = null;
        this.handlers.clear();
        try {
          ws.close();
        } catch {
          // ignore
        }
        pending.reject(new Error(`WebSocket failed to open within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingStart = { resolve, reject, timer };

      ws.addEventListener('open', () => {
        const pending = this.pendingStart;
        if (pending === null) return;
        this.pendingStart = null;
        clearTimeout(pending.timer);
        pending.resolve();
      });
      ws.addEventListener('error', (ev: unknown) => {
        const pending = this.pendingStart;
        if (pending === null) {
          // Post-open errors just tear the connection down.
          this.stop();
          return;
        }
        this.pendingStart = null;
        this.closed = true;
        if (this.ws === ws) this.ws = null;
        this.handlers.clear();
        clearTimeout(pending.timer);
        const message =
          ev && typeof ev === 'object' && 'message' in ev
            ? String((ev as { message: unknown }).message)
            : 'WebSocket error';
        pending.reject(new Error(message));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        if (this.ws === ws) this.ws = null;
        this.handlers.clear();
        const pending = this.pendingStart;
        if (pending !== null) {
          this.pendingStart = null;
          clearTimeout(pending.timer);
          pending.reject(new Error('WebSocket closed before the connection opened'));
        }
      });
      ws.addEventListener('message', (ev: { data: unknown }) => {
        this.onData(ev.data);
      });
    });
  }

  send(msg: ACPMessage): Promise<void> {
    if (this.closed || !this.ws) {
      return Promise.reject(new Error('WebSocket transport is not open'));
    }
    try {
      const serialized = JSON.stringify(msg);
      const buffered = Number.isFinite(this.ws.bufferedAmount)
        ? (this.ws.bufferedAmount as number)
        : 0;
      if (buffered + Buffer.byteLength(serialized, 'utf8') > this.maxBufferedBytes) {
        this.stop();
        return Promise.reject(new Error('WebSocket transport send buffer limit exceeded'));
      }
      this.ws.send(serialized);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  onMessage(handler: (msg: ACPMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  stop(): void {
    this.closed = true;
    this.handlers.clear();
    // If start() is still pending, reject it now so the caller's await unblocks
    // instead of waiting up to `handshakeTimeoutMs` for the timer.
    if (this.pendingStart !== null) {
      const pending = this.pendingStart;
      this.pendingStart = null;
      clearTimeout(pending.timer);
      try {
        pending.reject(new Error('WebSocket transport stopped while connecting'));
      } catch {
        // ignore
      }
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }

  private onData(data: unknown): void {
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : String(data);
    if (text.length > this.maxMessageChars) {
      this.stop();
      return;
    }
    if (!text.trim()) return;
    let msg: ACPMessage;
    try {
      msg = JSON.parse(text) as ACPMessage;
    } catch {
      // A remote agent that frames multiple JSON objects per message is
      // non-conformant; try newline-splitting as a fallback before dropping.
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.dispatch(JSON.parse(line) as ACPMessage);
        } catch {
          // skip malformed fragment
        }
      }
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: ACPMessage): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(msg);
      } catch {
        // a faulty consumer must not break the socket pump
      }
    }
  }
}

function finitePositiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
