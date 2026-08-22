/**
 * HqWsClient — browser WebSocket client for the HQ dashboard.
 *
 * Features:
 *  - Exponential backoff with jitter
 *  - Heartbeat-based dead connection detection
 *  - Configurable maxRetries
 *  - Connection state emission for UI binding
 *  - Double-close guard (onerror + onclose race)
 */

type HqWsBrowserMessage = HqBrowserMessage | HqResumeMessage;
type Handler = (msg: HqWsBrowserMessage) => void;
type StateHandler = (state: HqWsConnectionState) => void;
export type HqResumeCursor = ReadonlyMap<string, number> | Readonly<Record<string, number>>;
type ResumeCursorProvider = () => HqResumeCursor;

export type HqWsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface HqWsClientOptions {
  maxRetries?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxBackoffMs?: number;
  /** Highest HQ event seq the browser has already applied. */
  resumeCursor?: ResumeCursorProvider;
  /** Override the WS URL (used in tests). */
  url?: string;
}

import type {
  HqBrowserMessage,
  HqClientResumeMessage,
  HqEventEnvelope,
  HqResumeMessage,
  HqSnapshot,
} from '@wrongstack/core/hq';
import {
  createSurfaceConnectionState,
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  isConnectionHeartbeatTimedOut,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  planConnectionReconnect,
  type SurfaceConnectionState,
  stopConnection,
} from '@wrongstack/webui-protocol';
import { resolveHqToken } from './auth.js';
import { HQ_BROWSER_PEER_RESUME_CLIENT_ID } from './peer-resume-id.js';

const DEFAULT_HEARTBEAT_INTERVAL = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT = 10_000;
const DEFAULT_MAX_BACKOFF = 30_000;
const MAX_RESUME_FRAMES = 32;

/**
 * Browser-safe loopback classification, mirroring the server's browser-origin
 * gate (webui-server ws-auth.ts isLoopbackHostname). Deliberately avoids
 * `@wrongstack/core/hq`'s isLoopbackHost — that helper uses node:net and would
 * break the SPA bundle. Covers: `localhost`, the 127.0.0.0/8 block, ::1 (with
 * or without brackets, as WHATWG serializes IPv6 hostnames), and the DECIMAL
 * IPv4-mapped `::ffff:127.x.x.x` form. Browsers emit the hex form
 * (`[::ffff:7f00:1]`) for IPv4-mapped literals — both this client and the
 * server consistently treat that as non-loopback.
 */
function isLoopbackBrowserOrigin(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    if (v4[1] !== '127') return false;
    for (const octet of v4.slice(1)) {
      if (Number(octet) > 255) return false;
    }
    return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return host.startsWith('::ffff:127.');
}

export { HQ_BROWSER_PEER_RESUME_CLIENT_ID };

function normalizeResumeSeq(seq: number): number {
  if (!Number.isFinite(seq)) return 0;
  const normalized = Math.max(0, Math.trunc(seq));
  return Number.isSafeInteger(normalized) ? normalized : 0;
}

export class HqWsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private stateHandlers = new Set<StateHandler>();
  private reconnectAttempt = 0;
  private connectionState: SurfaceConnectionState = createSurfaceConnectionState();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private stopped = false;
  private _state: HqWsConnectionState = 'disconnected';
  private _url: string;
  private resumeCursor: ResumeCursorProvider;

  readonly maxRetries: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxBackoffMs: number;

  constructor(opts?: HqWsClientOptions) {
    this.maxRetries = opts?.maxRetries ?? Infinity;
    this.heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.maxBackoffMs = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
    this.resumeCursor = opts?.resumeCursor ?? (() => ({}));

    if (opts?.url) {
      this._url = opts.url;
    } else {
      const loc =
        typeof window !== 'undefined'
          ? window.location
          : { host: '127.0.0.1:3499', protocol: 'http:', hostname: '127.0.0.1' };
      const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      // Cookie-first: the browser sends the HttpOnly session cookie
      // automatically on the WS upgrade. The URL token is appended only for
      // loopback origins — the server refuses query-string tokens off-loopback
      // (WS-009), so carrying one there would only leak it into the upgrade
      // request line (proxy / access logs) without authenticating anything.
      // The check mirrors the server's browser-origin gate (ws-auth.ts) but
      // stays browser-safe (no node:net): localhost, 127.0.0.0/8, ::1 and the
      // IPv4-mapped form. Brackets are stripped because WHATWG serializes IPv6
      // hostnames as `[::1]` in a browser.
      const token = resolveHqToken();
      const isLoopback = isLoopbackBrowserOrigin(loc.hostname);
      const base = `${wsProto}//${loc.host}/ws/browser`;
      this._url =
        token !== null && isLoopback ? `${base}?token=${encodeURIComponent(token)}` : base;
    }
  }

  /** Effective WS URL — exposed for singleton conflict detection in `getHqClient`. */
  get url(): string {
    return this._url;
  }

  get state(): HqWsConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  connect(): void {
    if (this.stopped || this.ws !== null) return;
    this.connectionState = markConnectionConnecting(this.connectionState);
    this.emitState('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(this._url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.connectionState = markConnectionOpen(this.connectionState);
      this.lastMessageAt = Date.now();
      this.connectionState = markConnectionActivity(this.connectionState, this.lastMessageAt);
      this.emitState('connected');
      this.sendResume();
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      // Refresh the surface-connection staleness clock so the heartbeat
      // does not flag a healthy socket as silent. Without this,
      // `lastMessageAt` advances but `connectionState.lastActivityAt` stays
      // pinned to the `onopen` time, so a connection with steady low-rate
      // traffic (a quiet cockpit) still trips the heartbeat-timeout and
      // force-closes ~35 s after open. `markConnectionActivity` is the
      // single source of truth that the heartbeat reads — pair it with
      // every wall-clock advance.
      this.connectionState = markConnectionActivity(this.connectionState, this.lastMessageAt);
      try {
        const msg = JSON.parse(
          typeof event.data === 'string' ? event.data : '',
        ) as HqWsBrowserMessage;
        for (const h of this.handlers) {
          try {
            h(msg);
          } catch {
            /* handler errors must not kill the client */
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onclose = () => this.handleClose(ws, 'close');
    ws.onerror = () => this.handleClose(ws, 'error');
  }

  close(): void {
    this.stopped = true;
    this.connectionState = stopConnection(this.connectionState);
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000, 'client closed');
    this.ws = null;
    this.emitState('disconnected');
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  setResumeCursorProvider(provider: ResumeCursorProvider): void {
    this.resumeCursor = provider;
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this._state); // immediate emit with current state
    return () => this.stateHandlers.delete(handler);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private handleClose(socket: WebSocket, _source: 'close' | 'error'): void {
    // Guard: ignore stale close/error events from a socket that has already
    // been replaced, and avoid double-scheduling on error+close for one socket.
    if (this.ws !== socket) return;
    this.ws = null;
    this.stopHeartbeat();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const reconnect = planConnectionReconnect(this.connectionState, {
      ...DEFAULT_SURFACE_CONNECTION_CONFIG,
      maxReconnectAttempts: this.maxRetries,
      maxBackoffMs: this.maxBackoffMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      jitterRatio: 0.5,
    });
    this.connectionState = reconnect.state;
    this.reconnectAttempt = reconnect.state.reconnectAttempt;
    if (!reconnect.plan) {
      this.emitState('disconnected');
      return;
    }
    this.emitState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, reconnect.plan.delayMs);
  }

  private sendResume(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      for (const frame of this.resumeFrames()) {
        this.ws.send(JSON.stringify(frame));
      }
    } catch {
      /* resume is best-effort; heartbeat setup must still run */
    }
  }

  private resumeFrames(): HqClientResumeMessage[] {
    try {
      const cursor = this.resumeCursor();
      const entries =
        typeof (cursor as { entries?: unknown }).entries === 'function'
          ? (cursor as { entries: () => IterableIterator<[string, number]> }).entries()
          : Object.entries(cursor);
      const parsed: { clientId: string; lastSeqSeen: number }[] = [];
      for (const [clientId, seq] of entries) {
        if (typeof clientId !== 'string' || clientId.length === 0) continue;
        const lastSeqSeen = normalizeResumeSeq(seq);
        parsed.push({ clientId, lastSeqSeen });
      }
      // Cap to the most-recent K publishers so a stale `resumeCursors` map
      // (long-lived dashboard with many historical publishers) cannot blow
      // the WS frame budget. Ties broken by clientId for deterministic order.
      parsed.sort((a, b) =>
        b.lastSeqSeen !== a.lastSeqSeen
          ? b.lastSeqSeen - a.lastSeqSeen
          : a.clientId.localeCompare(b.clientId),
      );
      const peerCursor = parsed.find(
        ({ clientId }) => clientId === HQ_BROWSER_PEER_RESUME_CLIENT_ID,
      );
      const nonPeerLimit = peerCursor === undefined ? MAX_RESUME_FRAMES : MAX_RESUME_FRAMES - 1;
      const trimmed = parsed
        .filter(({ clientId }) => clientId !== HQ_BROWSER_PEER_RESUME_CLIENT_ID)
        .slice(0, nonPeerLimit);
      if (peerCursor !== undefined) trimmed.unshift(peerCursor);
      return trimmed.map(({ clientId, lastSeqSeen }) => ({
        type: 'client.resume',
        clientId,
        lastSeqSeen,
      }));
    } catch {
      return [];
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────

  /** True when the heartbeat has detected a silent dropout. Exposed for tests. */
  get isHeartbeatTimedOut(): boolean {
    if (this.ws === null) return true;
    return isConnectionHeartbeatTimedOut(this.connectionState, {
      ...DEFAULT_SURFACE_CONNECTION_CONFIG,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastMessageAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.isHeartbeatTimedOut && this.ws !== null) {
        // Silent dropout detected — force-close triggers reconnect
        this.ws.close(4000, 'heartbeat timeout');
        this.ws = null;
        this.scheduleReconnect();
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── State helpers ──────────────────────────────────────────────────────

  private emitState(state: HqWsConnectionState): void {
    this._state = state;
    for (const h of this.stateHandlers) {
      try {
        h(state);
      } catch {
        /* handler errors must not propagate */
      }
    }
  }
}

/** Singleton client for the app. */
let client: HqWsClient | null = null;

/**
 * Returns the cached singleton `HqWsClient`. If a singleton already exists,
 * the supplied `opts` are reconciled against the live instance:
 *  - `resumeCursor` is forwarded via `setResumeCursorProvider` (existing path).
 *  - Any other supplied option that does not match the live instance logs a
 *    warning and is ignored. The singleton cannot be reconfigured around an
 *    open socket (the URL + heartbeat params were already applied at
 *    construction); silently dropping conflicting opts is the original bug.
 *
 * To tear down the singleton (logout, unmount, test reset), call
 * `closeHqClient()` — `HqWsClient.close()` only closes the live socket; it
 * does NOT clear the cached reference, so a subsequent `getHqClient()`
 * would return the same (now dead) instance. `closeHqClient()` does both.
 */
export function getHqClient(opts?: HqWsClientOptions): HqWsClient {
  if (client === null) {
    client = new HqWsClient(opts);
    client.connect();
    return client;
  }
  if (opts?.resumeCursor !== undefined) {
    client.setResumeCursorProvider(opts.resumeCursor);
  }
  if (opts === undefined) {
    return client;
  }
  // Conflict detection — every other OptionSide besides `resumeCursor` is part
  // of the construction-time contract (URL, heartbeat cadence, retry policy).
  // A mismatch is a sign that the caller is unaware of the singleton. Log the
  // diff so the divergence is visible during dev, but never throw — the
  // existing connection is more valuable than a clean error.
  const mismatches: string[] = [];
  if (opts.url !== undefined && opts.url !== client.url) {
    mismatches.push(`url: ${opts.url} vs ${client.url}`);
  }
  if (
    opts.heartbeatIntervalMs !== undefined &&
    opts.heartbeatIntervalMs !== client.heartbeatIntervalMs
  ) {
    mismatches.push(
      `heartbeatIntervalMs: ${opts.heartbeatIntervalMs} vs ${client.heartbeatIntervalMs}`,
    );
  }
  if (
    opts.heartbeatTimeoutMs !== undefined &&
    opts.heartbeatTimeoutMs !== client.heartbeatTimeoutMs
  ) {
    mismatches.push(
      `heartbeatTimeoutMs: ${opts.heartbeatTimeoutMs} vs ${client.heartbeatTimeoutMs}`,
    );
  }
  if (opts.maxBackoffMs !== undefined && opts.maxBackoffMs !== client.maxBackoffMs) {
    mismatches.push(`maxBackoffMs: ${opts.maxBackoffMs} vs ${client.maxBackoffMs}`);
  }
  if (opts.maxRetries !== undefined && opts.maxRetries !== client.maxRetries) {
    mismatches.push(`maxRetries: ${opts.maxRetries} vs ${client.maxRetries}`);
  }
  if (mismatches.length > 0 && typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.warn(
      `[hq-ws-client] getHqClient() called with options that conflict with the live singleton; ignoring: ${mismatches.join(', ')}. Call closeHqClient() first if you need to reconfigure.`,
    );
  }
  return client;
}

/**
 * Tears down the cached singleton (if any). After this, `getHqClient()` will
 * construct a fresh client. Idempotent. Use this from logout / unmount paths
 * so the next user of the singleton does not inherit a dead socket.
 */
export function closeHqClient(): void {
  if (client === null) return;
  client.close();
  client = null;
}

// Re-export the HQ types the dashboard consumes.
export type { HqBrowserMessage, HqEventEnvelope, HqSnapshot };
