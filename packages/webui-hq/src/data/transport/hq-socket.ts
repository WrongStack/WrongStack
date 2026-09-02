/**
 * HqSocket — the browser's WebSocket to `/ws/browser` on the HQ server.
 *
 * Responsibilities, and nothing else:
 *  - open / reconnect with exponential backoff + jitter (shared policy from
 *    `@wrongstack/webui-protocol`, so HQ, WebUI and SimpleUI age out the same)
 *  - detect silent dropouts via a heartbeat clock and force a reconnect
 *  - send `client.resume` frames on every open so the server can gap-fill
 *  - hand decoded frames to subscribers, and connection state to the store
 *
 * It does NOT know about snapshots, alerts or views — message interpretation
 * lives in `src/data/wire.ts`.
 */
import type { HqBrowserMessage, HqResumeMessage } from '@wrongstack/core/hq';
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
import { resolveHqToken } from '../auth/token-storage.js';
import { isLoopbackBrowserOrigin } from './loopback.js';
import { buildResumeFrames, type HqResumeCursor } from './resume-frames.js';

export type HqSocketMessage = HqBrowserMessage | HqResumeMessage;
export type HqSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

type MessageHandler = (message: HqSocketMessage) => void;
type StateHandler = (state: HqSocketState) => void;
type ResumeCursorProvider = () => HqResumeCursor;

export interface HqSocketOptions {
  maxRetries?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxBackoffMs?: number;
  /** Highest HQ event seq the browser has already applied, per publisher. */
  resumeCursor?: ResumeCursorProvider;
  /** Override the WS URL (tests). */
  url?: string;
}

const DEFAULT_HEARTBEAT_INTERVAL = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT = 10_000;
const DEFAULT_MAX_BACKOFF = 30_000;

/**
 * Build the `/ws/browser` URL for the current page.
 *
 * Cookie-first: the browser sends the HttpOnly session cookie automatically on
 * the upgrade. The URL token is appended ONLY for loopback origins — see
 * `loopback.ts` for why that gate is a security boundary and not an
 * optimisation.
 */
export function resolveHqSocketUrl(location?: {
  host: string;
  protocol: string;
  hostname: string;
}): string {
  const loc =
    location ??
    (typeof window !== 'undefined'
      ? window.location
      : { host: '127.0.0.1:3499', protocol: 'http:', hostname: '127.0.0.1' });
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${scheme}//${loc.host}/ws/browser`;
  const token = resolveHqToken();
  if (token === null || !isLoopbackBrowserOrigin(loc.hostname)) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
}

export class HqSocket {
  readonly maxRetries: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxBackoffMs: number;

  private socket: WebSocket | null = null;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private connection: SurfaceConnectionState = createSurfaceConnectionState();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private currentState: HqSocketState = 'disconnected';
  private readonly socketUrl: string;
  private resumeCursor: ResumeCursorProvider;

  constructor(options?: HqSocketOptions) {
    this.maxRetries = options?.maxRetries ?? Infinity;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;
    this.resumeCursor = options?.resumeCursor ?? (() => ({}));
    this.socketUrl = options?.url ?? resolveHqSocketUrl();
  }

  get url(): string {
    return this.socketUrl;
  }

  get state(): HqSocketState {
    return this.currentState;
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** How many reconnects have been attempted since the last clean open. */
  get reconnectAttempt(): number {
    return this.connection.reconnectAttempt;
  }

  /** True when the heartbeat has detected a silent dropout. Exposed for tests. */
  get isHeartbeatTimedOut(): boolean {
    if (this.socket === null) return true;
    return isConnectionHeartbeatTimedOut(this.connection, {
      ...DEFAULT_SURFACE_CONNECTION_CONFIG,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  connect(): void {
    if (this.stopped || this.socket !== null) return;
    this.connection = markConnectionConnecting(this.connection);
    this.emitState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.socketUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.connection = markConnectionOpen(this.connection);
      this.touchActivity();
      this.emitState('connected');
      this.sendResume();
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      // `markConnectionActivity` is the single clock the heartbeat reads. Pair
      // it with EVERY wall-clock advance: without it, a quiet-but-healthy
      // socket (a cockpit with low-rate traffic) keeps `lastActivityAt` pinned
      // to the open time and gets force-closed ~35 s after connecting.
      this.touchActivity();
      const payload = typeof event.data === 'string' ? event.data : '';
      let message: HqSocketMessage;
      try {
        message = JSON.parse(payload) as HqSocketMessage;
      } catch {
        return; // malformed frame — drop it, keep the socket
      }
      for (const handler of this.messageHandlers) {
        try {
          handler(message);
        } catch {
          // A subscriber throwing must never kill the transport.
        }
      }
    };

    socket.onclose = () => this.handleClose(socket);
    socket.onerror = () => this.handleClose(socket);
  }

  close(): void {
    this.stopped = true;
    this.connection = stopConnection(this.connection);
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'client closed');
    this.socket = null;
    this.emitState('disconnected');
  }

  // ── Subscriptions ───────────────────────────────────────────────────────

  setResumeCursorProvider(provider: ResumeCursorProvider): void {
    this.resumeCursor = provider;
  }

  on(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    handler(this.currentState); // immediate emit with the current state
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private touchActivity(): void {
    this.connection = markConnectionActivity(this.connection, Date.now());
  }

  /**
   * Double-close guard: `onerror` and `onclose` both fire for one failed
   * socket, and a stale socket can emit after it has been replaced. Only the
   * live socket may tear down state or schedule a reconnect.
   */
  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.stopHeartbeat();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const reconnect = planConnectionReconnect(this.connection, {
      ...DEFAULT_SURFACE_CONNECTION_CONFIG,
      maxReconnectAttempts: this.maxRetries,
      maxBackoffMs: this.maxBackoffMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      jitterRatio: 0.5,
    });
    this.connection = reconnect.state;
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
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      for (const frame of buildResumeFrames(this.resumeCursor())) {
        this.socket.send(JSON.stringify(frame));
      }
    } catch {
      // Resume is best-effort; the heartbeat must still start.
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.touchActivity();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== null && this.isHeartbeatTimedOut) {
        this.socket.close(4000, 'heartbeat timeout');
        this.socket = null;
        this.stopHeartbeat();
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

  private emitState(state: HqSocketState): void {
    this.currentState = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        // Never let a listener break the transport.
      }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

let singleton: HqSocket | null = null;

/**
 * The app's shared socket. The URL and heartbeat/retry parameters are fixed at
 * construction, so a later call cannot reconfigure a live socket: only
 * `resumeCursor` is forwarded, and any other conflicting option is reported
 * and ignored rather than silently dropped (the original bug) or thrown (an
 * open connection is worth more than a clean error).
 *
 * Use `closeHqSocket()` to tear down — `HqSocket.close()` alone closes the
 * socket but leaves this reference, so the next `getHqSocket()` would hand
 * back a dead instance.
 */
export function getHqSocket(options?: HqSocketOptions): HqSocket {
  if (singleton === null) {
    singleton = new HqSocket(options);
    singleton.connect();
    return singleton;
  }
  if (options?.resumeCursor !== undefined) {
    singleton.setResumeCursorProvider(options.resumeCursor);
  }
  if (options === undefined) return singleton;

  const live = singleton;
  const mismatches = (
    [
      ['url', options.url, live.url],
      ['heartbeatIntervalMs', options.heartbeatIntervalMs, live.heartbeatIntervalMs],
      ['heartbeatTimeoutMs', options.heartbeatTimeoutMs, live.heartbeatTimeoutMs],
      ['maxBackoffMs', options.maxBackoffMs, live.maxBackoffMs],
      ['maxRetries', options.maxRetries, live.maxRetries],
    ] as const
  )
    .filter(([, requested, current]) => requested !== undefined && requested !== current)
    .map(([name, requested, current]) => `${name}: ${String(requested)} vs ${String(current)}`);

  if (mismatches.length > 0 && typeof console !== 'undefined') {
    console.warn(
      `[hq-socket] getHqSocket() called with options that conflict with the live singleton; ignoring: ${mismatches.join(', ')}. Call closeHqSocket() first if you need to reconfigure.`,
    );
  }
  return singleton;
}

/** Tear down the singleton. Idempotent; used by logout, unmount and tests. */
export function closeHqSocket(): void {
  if (singleton === null) return;
  singleton.close();
  singleton = null;
}
