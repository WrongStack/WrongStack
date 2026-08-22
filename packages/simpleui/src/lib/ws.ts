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
} from '@wrongstack/webui-protocol';
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
    // The proven marker attests to the deployment's cookie path. A token
    // clear is the one lifecycle event that correlates with deployment
    // uncertainty (config flips, secret rotation) — drop the attestation so
    // a stale marker cannot enable a second destruction on the next visit.
    window.localStorage.removeItem(COOKIE_PROVEN_KEY);
  } catch {
    /* best-effort */
  }
}

// Consecutive /ws-auth 401s since the last success (or since page load).
// A 401 only clears a stored token when the cookie path has PROVEN to work —
// /ws-auth 401s only on a token mismatch once the route exists — AND the
// streak reached N. "Proven" is persisted to localStorage, not kept as a
// per-session boolean: a token already dead at page load (e.g. rotated
// secret between visits) can then be cleared on a fresh load, while
// enableWsCookie:false deployments (the route does not exist; the generic
// gate 401s a VALID token) never get a 200, never write the marker, and
// their valid credentials are never destroyed.
const COOKIE_PROVEN_KEY = 'wrongstack.simpleui.cookie-proven.v1';
let consecutive401s = 0;
const MAX_CONSECUTIVE_401S = 3;

function isCookiePathProven(): boolean {
  try {
    return window.localStorage.getItem(COOKIE_PROVEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markCookiePathProven(): void {
  try {
    window.localStorage.setItem(COOKIE_PROVEN_KEY, '1');
  } catch {
    /* best-effort */
  }
}

/** Test seam — reset the module-level auth state between tests. */
export const __test__ = {
  resetCookieExchangeState: (): void => {
    consecutive401s = 0;
    try {
      window.localStorage.removeItem(COOKIE_PROVEN_KEY);
    } catch {
      /* best-effort */
    }
  },
};

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
      // Preservation-first failure handling, with a marker-proven escalation
      // and one non-destructive recovery:
      //  - 403 comes from the origin/CSRF guard, never from token validity.
      //  - a single 401 is ambiguous (origin-guard blip, config reload,
      //    enableWsCookie:false generic-gate) — never clears on one.
      //  - a stored token clears only when the cookie path has PROVEN to
      //    work (a 200 happened in this page session, or the persisted
      //    marker was written by a previous session) AND the streak reached
      //    N. The marker is invalidated on every token clear, so a stale
      //    attestation cannot chain a second destruction.
      //  - A rejected URL token with a DIFFERENT valid stored token switches
      //    the socket to the stored credential and drops the dead URL token
      //    from the address bar, so a stale access URL cannot shadow the
      //    stored credential across reloads. Nothing is cleared from storage.
      const urlToken = url.searchParams.get('token');
      const stored = storedToken();
      if (response.status === 401) {
        consecutive401s += 1;
        if (isCookiePathProven() && consecutive401s >= MAX_CONSECUTIVE_401S && stored === token) {
          clearStoredToken();
        }
      }
      // 401-only: a 403 means the token was never evaluated (origin/CSRF
      // guard), so swapping would risk destroying a valid URL credential.
      if (
        response.status === 401 &&
        sameHost &&
        urlToken !== null &&
        stored !== null &&
        stored !== token
      ) {
        url.searchParams.delete('token');
        url.searchParams.set('token', stored);
        scrubUrlTokenFromPage(urlToken);
      }
      return url;
    }
    consecutive401s = 0;
    markCookiePathProven();
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
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      // A LOCAL teardown is already covered by the `stopped` flag one line
      // below (`stop()` sets it before closing), so the close code tells us
      // nothing we need: every close that reaches past this guard is REMOTE.
      //
      // Treating code 1000 as "stop for good" therefore fired on exactly the
      // case that must reconnect — the server's own graceful shutdown, which
      // calls `ws.close()` with no arguments (webui-server lifecycle.ts:58),
      // i.e. code 1000. The UI kept `connection === 'open'`: the topbar showed
      // the green LIVE chip, the outage overlay never opened, and the composer
      // stayed enabled, so a typed message was appended to the transcript and
      // queued onto a socket that would never flush. Endless "Thinking…",
      // recoverable only with F5 — restarting the server did not help.
      //
      // `webui/src/lib/ws-client.ts:380` reconnects unconditionally and uses
      // the code only to decide whether to record an error string.
      if (this.connectionState.stopped) return;
      this.options.onState('closed');
      const reconnect = planConnectionReconnect(this.connectionState, SIMPLE_CONNECTION_CONFIG);
      this.connectionState = reconnect.state;
      if (reconnect.plan) {
        this.timer = setTimeout(() => void this.connect(), reconnect.plan.delayMs);
      }
    });
    // Closing with no code produces a clean 1000 handshake, which is why a
    // transient error on an otherwise healthy socket used to land in the dead
    // branch above too.
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
