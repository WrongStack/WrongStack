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

type Handler = (msg: HqBrowserMessage) => void;
type StateHandler = (state: HqWsConnectionState) => void;

export type HqWsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface HqWsClientOptions {
  maxRetries?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxBackoffMs?: number;
  /** Override the WS URL (used in tests). */
  url?: string;
}

import type { HqBrowserMessage, HqEventEnvelope, HqSnapshot } from '@wrongstack/core/hq';
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
} from '@wrongstack/webui-server/protocol';
import { resolveHqToken } from './auth.js';

const DEFAULT_HEARTBEAT_INTERVAL = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT = 10_000;
const DEFAULT_MAX_BACKOFF = 30_000;

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
  private readonly url: string;

  readonly maxRetries: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxBackoffMs: number;

  constructor(opts?: HqWsClientOptions) {
    this.maxRetries = opts?.maxRetries ?? Infinity;
    this.heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeoutMs = opts?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.maxBackoffMs = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;

    if (opts?.url) {
      this.url = opts.url;
    } else {
      const loc =
        typeof window !== 'undefined'
          ? window.location
          : { host: '127.0.0.1:3499', protocol: 'http:' };
      const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      // Cookie-first: the browser sends the HttpOnly session cookie
      // automatically on the WS upgrade. The URL token remains as a
      // legacy fallback for backward compatibility with older startup
      // URLs that carried ?token= in the query string.
      const token = resolveHqToken();
      const base = `${wsProto}//${loc.host}/ws/browser`;
      this.url = token !== null ? `${base}?token=${encodeURIComponent(token)}` : base;
    }
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
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.connectionState = markConnectionOpen(this.connectionState);
      this.lastMessageAt = Date.now();
      this.connectionState = markConnectionActivity(this.connectionState, this.lastMessageAt);
      this.emitState('connected');
      this.startHeartbeat();
    };

    ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(
          typeof event.data === 'string' ? event.data : '',
        ) as HqBrowserMessage;
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

    ws.onclose = () => this.handleClose('close');
    ws.onerror = () => this.handleClose('error');
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

  private handleClose(_source: 'close' | 'error'): void {
    // Guard: onerror fires before onclose — the ws reference is already null
    // when onclose arrives, preventing double-scheduling.
    if (this.ws === null) return;
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
export function getHqClient(): HqWsClient {
  if (client === null) {
    client = new HqWsClient();
    client.connect();
  }
  return client;
}

// Re-export the HQ types the dashboard consumes.
export type { HqBrowserMessage, HqEventEnvelope, HqSnapshot };
