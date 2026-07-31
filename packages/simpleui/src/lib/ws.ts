import {
  createSurfaceConnectionState,
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  decodeProtocolFrame,
  decodeProtocolMessage,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  planConnectionReconnect,
  type SurfaceConnectionState,
  stopConnection,
} from '@wrongstack/webui-server/protocol';
import type { ServerMessage } from '../types.js';

function pageToken(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('token');
  } catch {
    return null;
  }
}

function configuredWsUrl(): string | null {
  const raw = document
    .querySelector('meta[name="wrongstack-ws-url"]')
    ?.getAttribute('content')
    ?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    const token = pageToken();
    if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return null;
  }
}

export function defaultWsUrl(): URL {
  const configured = configuredWsUrl();
  if (configured) return new URL(configured);
  // Shared-port design: WS shares the HTTP port, so derive the WS URL
  // from the exact page origin. Preserving `location.host` matters: changing
  // localhost to 127.0.0.1 makes the socket cross-origin, so `connect-src
  // 'self'` blocks it and the host-scoped auth cookie is not sent.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${window.location.host}`);
  const token = pageToken();
  if (token) url.searchParams.set('token', token);
  return url;
}

function scrubPageToken(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, document.title, url.toString());
  } catch {
    // Best-effort URL hygiene only.
  }
}

async function exchangeAuthCookie(url: URL): Promise<URL> {
  const token = url.searchParams.get('token') ?? pageToken();
  if (!token) return url;
  try {
    const response = await fetch(`/ws-auth?token=${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) return url;
    const sameHost = url.hostname === window.location.hostname;
    if (sameHost) url.searchParams.delete('token');
    scrubPageToken();
  } catch {
    // The WS query-token path remains as a compatibility fallback.
  }
  return url;
}

export interface SimpleSocketOptions {
  onMessage: (message: ServerMessage) => void;
  onState: (state: 'connecting' | 'open' | 'closed') => void;
}

const SIMPLE_CONNECTION_CONFIG = {
  ...DEFAULT_SURFACE_CONNECTION_CONFIG,
  maxReconnectAttempts: Number.POSITIVE_INFINITY,
  initialBackoffMs: 750,
  maxBackoffMs: 15_000,
  jitterRatio: 0.25,
  queueLimit: 100,
  queueCharLimit: 8 * 1024 * 1024,
};

export class SimpleSocket {
  private socket: WebSocket | null = null;
  private connectionState: SurfaceConnectionState = createSurfaceConnectionState();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: string[] = [];
  private queueChars = 0;
  private listeners: Set<(msg: ServerMessage) => void> = new Set();

  constructor(private readonly options: SimpleSocketOptions) {}

  /** Subscribe to all incoming messages. Returns an unsubscribe function. */
  onMessage(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async connect(): Promise<void> {
    if (this.connectionState.stopped) return;
    this.connectionState = markConnectionConnecting(this.connectionState);
    this.options.onState('connecting');
    const url = await exchangeAuthCookie(defaultWsUrl());
    if (this.connectionState.stopped) return;

    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.connectionState = markConnectionOpen(this.connectionState);
      this.options.onState('open');
      const queued = this.queue.splice(0);
      this.queueChars = 0;
      for (const message of queued) socket.send(message);
    });
    socket.addEventListener('message', (event) => {
      this.connectionState = markConnectionActivity(this.connectionState);
      const decoded = decodeProtocolFrame(String(event.data), 'server');
      if (!decoded.ok) return;
      const message = decoded.message as ServerMessage;
      this.options.onMessage(message);
      for (const fn of this.listeners) fn(message);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.socket = null;
      if (this.connectionState.stopped) return;
      if (event.code === 1000) {
        this.connectionState = stopConnection(this.connectionState);
        return;
      }
      this.options.onState('closed');
      const reconnect = planConnectionReconnect(this.connectionState, SIMPLE_CONNECTION_CONFIG);
      this.connectionState = reconnect.state;
      if (reconnect.plan) {
        this.timer = setTimeout(() => void this.connect(), reconnect.plan.delayMs);
      }
    });
    socket.addEventListener('error', () => socket.close());
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    const decoded = decodeProtocolMessage({ type, payload }, 'client');
    if (!decoded.ok) {
      throw new Error(decoded.issue.message);
    }
    const serialized = JSON.stringify(decoded.message);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (serialized.length > SIMPLE_CONNECTION_CONFIG.queueCharLimit) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'simple_socket.send_queue_overflow',
          message: 'Message exceeds the disconnected send queue byte budget; dropping it',
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }
    let dropped = false;
    while (
      this.queue.length > 0 &&
      (this.queue.length >= SIMPLE_CONNECTION_CONFIG.queueLimit ||
        this.queueChars + serialized.length > SIMPLE_CONNECTION_CONFIG.queueCharLimit)
    ) {
      const removed = this.queue.shift();
      if (removed === undefined) break;
      this.queueChars = Math.max(0, this.queueChars - removed.length);
      dropped = true;
    }
    if (dropped) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'simple_socket.send_queue_overflow',
          message: 'Send queue reached its message or byte budget; dropping the oldest message',
          timestamp: new Date().toISOString(),
        }),
      );
    }
    this.queue.push(serialized);
    this.queueChars += serialized.length;
  }

  close(): void {
    this.connectionState = stopConnection(this.connectionState);
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
    this.queue.length = 0;
    this.queueChars = 0;
    this.listeners.clear();
  }
}
