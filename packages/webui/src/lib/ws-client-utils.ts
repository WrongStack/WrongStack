import type { WSServerMessage } from '../types';
import { useSessionStore } from '../stores/session-store';
import { useVizStore, wsToVizEvent } from '../stores/viz-store';

/**
 * Generic event handler. When the consumer knows the literal message type K,
 * `EventHandler<K>` narrows the received message to the matching union member
 * so payload access is type-checked without an `as` cast. The bare
 * `EventHandler` (no parameter) keeps the wider `WSServerMessage` shape for
 * the internal dispatch table, where any message type may arrive.
 */
export type EventHandler<K extends WSServerMessage['type'] = WSServerMessage['type']> = (
  msg: Extract<WSServerMessage, { type: K }>,
) => void;

/**
 * Returns true when a server message is intended for the currently-active
 * session. The server tags session-scoped messages with `payload.sessionId`.
 *
 * Fail-closed semantics (the cross-session todo bleed fix): a message whose
 * `sessionId` is present-but-EMPTY is rejected. The server stamps
 * `sessionId: ''` when its context has no session (see sessionPayload), and
 * that stamp must not silently widen into "every session". Messages with NO
 * sessionId key at all, or when no session is active yet, still pass so
 * boot-time and project-wide broadcasts are not dropped.
 */
export function isActiveSessionMessage(msg: WSServerMessage): boolean {
  const sessionId = (msg.payload as { sessionId?: string | undefined } | undefined)?.sessionId;
  const activeId = useSessionStore.getState().session?.id;
  if (sessionId === '') return false;
  return !sessionId || !activeId || sessionId === activeId;
}

/**
 * Convert a server message into a VizEvent and push it to the viz store,
 * activating the viz surface. No-op when the message isn't a viz source.
 * Previously duplicated in chat-handlers and session-handlers.
 */
export function pipeViz(msg: WSServerMessage): void {
  const vizEv = wsToVizEvent(msg.type, msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

/**
 * Shape-check a server message payload against a record of required keys +
 * their expected primitive types. Returns the payload cast to T when every
 * required key is present and matches its type, otherwise `null`.
 *
 * This is the light runtime guard that WS handlers can use BEFORE the
 * `as {...}` cast, so a malformed server payload (missing field, wrong
 * type) is dropped deliberately instead of crashing the handler. The
 * generic WS emit() try/catch logs the crash but silently drops the
 * message — a `safePayload` check turns that into an early return the
 * handler can reason about.
 *
 * Usage:
 *   const p = safePayload(msg, { text: 'string', messageId: 'string' });
 *   if (!p) return;
 *   // p is now typed as { text: string; messageId: string }
 *
 * `optional` keys are checked only when present.
 */
export function safePayload<T extends Record<string, unknown>>(
  msg: WSServerMessage,
  required: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
  optional?: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
): T | null {
  const p = (msg.payload ?? {}) as Record<string, unknown>;
  for (const [key, kind] of Object.entries(required)) {
    const v = p[key];
    if (!matchesKind(v, kind)) return null;
  }
  if (optional) {
    for (const [key, kind] of Object.entries(optional)) {
      const v = p[key];
      if (v !== undefined && v !== null && !matchesKind(v, kind)) return null;
    }
  }
  return p as unknown as T;
}

function matchesKind(value: unknown, kind: string): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Per-prompt bookkeeping record. The `expiresAtMs` field lets `ws-client`
 * sweep stale entries from `pendingConfirms` on every insert and on
 * disconnect — a closed-and-unresolved prompt (panel unmounted, view
 * switched, tab backgrounded) would otherwise leak the entry for the
 * lifetime of the WebUI tab. The map is keyed by a server-issued id; the
 * stored value exists only to carry the TTL.
 * RAM-leak audit 2026-08-11, MEDIUM.
 */
export type PendingConfirm = { expiresAtMs: number };

export type WsStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; error?: string | undefined }
  | { state: 'reconnecting'; attempt: number; nextRetryAt: number; lastError?: string | undefined };

/**
 * Read `?token=…` from the WS URL the client was constructed with.
 * Used by the cookie bootstrap (`ensureAuthCookie`) — when the server
 * prints the WS URL to its startup banner (e.g. `ws://127.0.0.1:3456?token=…`)
 * the page is loaded with the token in the URL, the client reads it
 * here, hits `/ws-auth?token=…` to swap it for an HttpOnly cookie, and
 * the cookie carries forward on every reconnect. There is no
 * persistent client-side store of the token.
 */
export function getTokenFromWsUrl(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    return u.searchParams.get('token');
  } catch {
    return null;
  }
}

export function getTokenFromPageUrl(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  try {
    const search = window.location.search ?? '';
    return new URLSearchParams(search).get('token');
  } catch {
    return null;
  }
}

export function stripTokenFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete('token');
    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function stripTokenFromAddressBar(): void {
  if (typeof window === 'undefined' || !window.location || !window.history?.replaceState) return;
  try {
    const href = window.location.href;
    if (!href) return;
    const url = new URL(href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, document.title, url.toString());
  } catch {
    /* best-effort only */
  }
}

export function resolvePublicWsUrl(): string | null {
  if (typeof document === 'undefined') return null;
  const raw = document
    .querySelector('meta[name="wrongstack-ws-url"]')
    ?.getAttribute('content')
    ?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    const token = getTokenFromPageUrl();
    if (token && !url.searchParams.has('token')) {
      url.searchParams.set('token', token);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function defaultWsUrl(): string {
  const publicWsUrl = resolvePublicWsUrl();
  if (publicWsUrl) return publicWsUrl;
  // Shared-port design: WS shares the HTTP port, so derive the WS URL
  // from the page origin. No separate WS port or meta tag needed.
  if (typeof window === 'undefined' || !window.location?.hostname) {
    return 'ws://127.0.0.1:3456';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.hostname.toLowerCase();
  const port = window.location.port;
  const token = getTokenFromPageUrl();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  // Use the page's own host and port (WS shares the HTTP port)
  const hostPart = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
    ? '127.0.0.1'
    : host;
  return `${protocol}://${hostPart}${port ? `:${port}` : ''}${query}`;
}

/**
 * Derive the HTTP origin for `/ws-auth` from the page's own location.
 * `/ws-auth` is a same-origin HTTP call, so we use the page's host
 * (NOT the WS port). The same `loopback→127.0.0.1` DNS-dance fix from
 * `defaultWsUrl()` applies — on Windows, browsers resolve `localhost`
 * to `[::1]` first, so we force IPv4 loopback for cookie consistency.
 */
export function httpOriginForAuth(): string {
  if (typeof window === 'undefined' || !window.location?.hostname) {
    return 'http://127.0.0.1:3456';
  }
  const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
  const host = window.location.hostname.toLowerCase();
  const portSuffix = window.location.port ? `:${window.location.port}` : '';
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return `${protocol}://127.0.0.1${portSuffix}`;
  }
  return `${protocol}://${window.location.hostname}${portSuffix}`;
}
