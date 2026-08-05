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

/**
 * localStorage key for the shared auth token — the same credential carried by
 * `?token=`. Persisting it lets F5 / tab restarts keep working: on every load
 * the token is re-attached to the WS URL and re-exchanged for the HttpOnly
 * cookie via `/ws-auth`, so a restarted server still authenticates.
 */
const TOKEN_STORAGE_KEY = 'wrongstack.simpleui.token.v1';

function storedToken(): string | null {
  try {
    const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    return token !== null && token.length > 0 ? token : null;
  } catch {
    return null; // storage disabled / strict private mode
  }
}

function persistToken(token: string): boolean {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
}

function clearStoredToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

function pageToken(): string | null {
  try {
    const urlToken = new URLSearchParams(window.location.search).get('token');
    if (urlToken !== null && urlToken.length > 0) return urlToken;
  } catch {
    /* fall through to the stored token */
  }
  return storedToken();
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

/** Remove a specific `?token=` from the page URL (address-bar hygiene). */
function scrubUrlTokenFromPage(token: string | null): void {
  if (token === null) return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('token') !== token) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, document.title, url.toString());
  } catch {
    // Best-effort URL hygiene only.
  }
}

export function scrubPageToken(): void {
  try {
    const urlToken = new URL(window.location.href).searchParams.get('token');
    if (urlToken === null) return;
    // Only scrub when the token survives in localStorage — otherwise the URL
    // is the only copy and scrubbing would lose the credential on reload.
    if (storedToken() !== urlToken) return;
    scrubUrlTokenFromPage(urlToken);
  } catch {
    // Best-effort URL hygiene only.
  }
}

export async function exchangeAuthCookie(url: URL): Promise<URL> {
  const token = url.searchParams.get('token') ?? pageToken();
  if (!token) return url;
  // sameHost gates the URL mutations and the persist: the /ws-auth exchange
  // always hits the page origin, but the WS URL may be a separate public
  // tunnel host. A cross-host credential must never be persisted into (or
  // replaced by) page-origin storage — it belongs to a different server.
  // (clearStoredToken is NOT gated: the stored token lives in page-origin
  // storage and a 401 from the page-origin /ws-auth legitimately invalidates
  // it regardless of which host the socket targets.)
  const sameHost = url.hostname === window.location.hostname;
  try {
    const response = await fetch(`/ws-auth?token=${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) {
      // Explicit auth rejection (bad/revoked token) must not replay from
      // localStorage forever. Transient failures (404 on older servers, 5xx,
      // network) keep the token — a blip is not a revocation.
      if (response.status === 401 || response.status === 403) {
        const urlToken = url.searchParams.get('token');
        const stored = storedToken();
        if (stored === token) {
          // The rejected token IS the stored one — stop replaying it. Also
          // strip it from the page URL and the WS URL, or every reconnect
          // would re-attach the dead credential (the browser URL-token path
          // is rejected anyway; loopback recovers tokenless).
          clearStoredToken();
          if (sameHost) {
            url.searchParams.delete('token');
            scrubUrlTokenFromPage(token);
          }
        } else if (sameHost && urlToken !== null && stored !== null) {
          // A rejected URL token while a different (valid) stored token
          // exists: drop the stale URL token and switch to the stored
          // credential instead of looping on the rejected one forever.
          url.searchParams.delete('token');
          url.searchParams.set('token', stored);
          scrubUrlTokenFromPage(urlToken);
        } else if (sameHost && urlToken !== null) {
          // Rejected URL token with no stored fallback — replaying it can
          // only loop; strip it and let the tokenless loopback path (or a
          // fresh startup URL) take over.
          url.searchParams.delete('token');
          scrubUrlTokenFromPage(urlToken);
        }
      }
      return url;
    }
    if (sameHost) {
      // Only persist a token the server actually accepted — a stale `?token=`
      // from an old link must not outlive its page load.
      persistToken(token);
      url.searchParams.delete('token');
      scrubPageToken();
    }
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
