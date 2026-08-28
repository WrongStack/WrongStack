import {
  activeLaneId,
  type ChatLaneActions,
  chatLane,
  DEFAULT_LANE_ID,
  disposeLane,
  ensureLane,
  hasLane,
  laneIds,
  MAX_LANES,
  readLane,
} from '../stores/chat-lanes';
import {
  activeSessionLaneId,
  disposeSessionLane,
  ensureSessionLane,
  hasSessionLane,
  SESSION_DEFAULT_LANE_ID,
  type SessionLaneActions,
  sessionLane,
  sessionLaneIds,
} from '../stores/session-lanes';
import { useSessionStore } from '../stores/session-store';
import { useSessionTabStore } from '../stores/session-tab-store';
import { useVizStore, wsToVizEvent } from '../stores/viz-store';
import type { WSServerMessage } from '../types';

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
 * The session the user is looking at, or `null` when none is bound yet.
 *
 * There is exactly ONE answer to "which tab is in front": the lane pointer.
 * Every other candidate drifts from it —
 *
 *  - `useSessionStore().session?.id` is the lane's SessionInfo record, which
 *    is null from the moment a tab is opened until its `session.start` lands,
 *    and again after `endSession`;
 *  - the WS client's own `sessionId` is whichever session announced last on
 *    the socket, which in a four-tab window is routinely a BACKGROUND tab.
 *
 * Both were used as stand-ins for the pointer on the send path, which is how
 * a message typed in tab 2 started a run in tab 1's session. Read the pointer
 * here and let the callers share it.
 */
export function foregroundSessionId(): string | null {
  const pointer = activeSessionLaneId();
  if (pointer && pointer !== SESSION_DEFAULT_LANE_ID) return pointer;
  // Pre-session (boot, setup screen): the lane pointer is deliberately unbound
  // and there is no session to address.
  return useSessionStore.getState().session?.id ?? null;
}

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
  // The LANE POINTER, not the SessionInfo record: the record is null from the
  // moment a tab is activated until its `session.start` lands, and the old
  // `!activeId` allowance let ANOTHER tab's tagged event through exactly in
  // that window — the fresh-tab bleed. The pointer answers from the instant
  // the tab changes; pre-session (pointer unbound) the boot-time allowance
  // still applies, same as `foregroundSessionId`.
  const activeId = foregroundSessionId();
  if (sessionId === '') return false;
  // Untagged while a session is bound is the documented fail-open for
  // boot-time and project-wide broadcasts — but it is also exactly what a
  // server surface that FORGOT to stamp looks like. One warn per message type
  // keeps such regressions visible instead of silently polluting the
  // foreground tab's viz/diagnostics surfaces.
  if (!sessionId && activeId) warnUntaggedWhileBound(msg.type);
  return !sessionId || !activeId || sessionId === activeId;
}

/**
 * Read the session a message belongs to, or `null` when it names none.
 * Empty-string counts as "none": the server stamps `sessionId: ''` when its
 * context has no session, and that must never widen into "every session".
 */
export function messageSessionId(msg: WSServerMessage): string | null {
  const sessionId = (msg.payload as { sessionId?: string | undefined } | undefined)?.sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

/**
 * Resolve the chat LANE a message belongs to — the only way a WS handler is
 * allowed to touch chat state.
 *
 * This is positive routing: the message names its session and the write lands
 * in that session's lane, in the foreground or not. Compare with the guard it
 * replaces, which asked "is this for the tab in front?" and dropped everything
 * else — one forgotten guard mis-delivered a run's tokens into a neighbouring
 * transcript, and even a correct guard threw away background tabs' own output.
 *
 * Returns `null` (drop the event) when:
 *  - the message carries no sessionId — a server regression, warned once per
 *    message type, because silently dropping looks like "the model stopped";
 *  - the session has no lane and all four lanes are taken. A fifth session
 *    gets no tab, so its events belong to nobody.
 */
/**
 * Free a lane that no tab owns any more, so a real tab can have its slot.
 *
 * The four-lane ceiling is a hard one — an event for a fifth session is
 * dropped rather than mis-delivered. That is right, but it made ORPHAN lanes
 * dangerous: a lane whose slot is gone (a tab closed while its run was still
 * emitting, a lane/slot pair that came back out of step from localStorage)
 * kept counting against the ceiling forever, and the tab the user had just
 * opened was the one whose events got dropped.
 *
 * Only a lane with no slot, not in front and not streaming is reclaimed, so
 * this can never take a lane away from a tab that is using it.
 */
function reclaimOrphanLane(): boolean {
  const slots = new Set(useSessionTabStore.getState().openTabIds);
  const active = activeLaneId();
  for (const id of laneIds()) {
    if (id === DEFAULT_LANE_ID || id === active || slots.has(id)) continue;
    if (readLane(id).isLoading) continue;
    disposeLane(id);
    disposeSessionLane(id);
    return true;
  }
  return false;
}

export function chatFor(msg: WSServerMessage): ChatLaneActions | null {
  const sessionId = messageSessionId(msg);
  if (sessionId) {
    if (hasLane(sessionId)) return chatLane(sessionId);
    if (laneIds().length < MAX_LANES || reclaimOrphanLane()) {
      ensureLane(sessionId);
      return chatLane(sessionId);
    }
    warnLaneOverflow(msg.type, sessionId);
    return null;
  }

  // Untagged. With NO session in front there is no transcript it could
  // corrupt, so it lands in the pre-session lane — a server build that forgets
  // to stamp must not make the boot/setup surface look dead. Once a session IS
  // in front, "the obvious tab" does not exist (there may be three more behind
  // it) and guessing is precisely the bleed, so drop it and say so once per
  // message type.
  const active = activeLaneId();
  if (active === DEFAULT_LANE_ID) return chatLane(DEFAULT_LANE_ID);
  warnUntaggedChatEvent(msg.type);
  return null;
}

/**
 * Resolve the SESSION-ACCOUNTING lane a message belongs to — tokens, cost,
 * iteration, todos, context ceiling. Same positive-routing contract as
 * `chatFor`: a background run's numbers land on the background tab's counters,
 * never on the tab in front.
 */
export function sessionFor(msg: WSServerMessage): SessionLaneActions | null {
  const sessionId = messageSessionId(msg);
  if (sessionId) {
    if (hasSessionLane(sessionId)) return sessionLane(sessionId);
    if (sessionLaneIds().length < MAX_LANES || reclaimOrphanLane()) {
      ensureSessionLane(sessionId);
      return sessionLane(sessionId);
    }
    warnSessionLaneOverflow(msg.type, sessionId);
    return null;
  }
  // Same pre-session allowance as `chatFor`.
  const active = activeSessionLaneId();
  if (active === SESSION_DEFAULT_LANE_ID) return sessionLane(SESSION_DEFAULT_LANE_ID);
  return null;
}

/**
 * Session-scoped variant… (removed) — see git history. No consumer ever wired
 * to this guard; the live foreground gate is `isActiveSessionMessage` above.
 */

const warnedUntaggedTypes = new Set<string>();
function warnUntaggedChatEvent(type: string): void {
  if (warnedUntaggedTypes.has(type)) return;
  warnedUntaggedTypes.add(type);
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'ws_client.untagged_chat_event',
      messageType: type,
      reason: 'chat event carried no sessionId; dropped to protect other tabs',
      timestamp: new Date().toISOString(),
    }),
  );
}

const warnedOverflowSessions = new Set<string>();
function warnLaneOverflow(type: string, sessionId: string): void {
  if (warnedOverflowSessions.has(sessionId)) return;
  warnedOverflowSessions.add(sessionId);
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'ws_client.chat_lane_overflow',
      messageType: type,
      sessionId,
      reason: 'no lane for this session and all four lanes are taken; event dropped',
      timestamp: new Date().toISOString(),
    }),
  );
}

const warnedSessionOverflowSessions = new Set<string>();
/** Twin of `warnLaneOverflow` for the session-accounting router: tokens and
 *  cost vanishing from a tab's counters looks like a budgeting bug, so say
 *  so — once per session — instead of dropping silently. */
function warnSessionLaneOverflow(type: string, sessionId: string): void {
  if (warnedSessionOverflowSessions.has(sessionId)) return;
  warnedSessionOverflowSessions.add(sessionId);
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'ws_client.session_lane_overflow',
      messageType: type,
      sessionId,
      reason:
        'no session lane for this session and all four lanes are taken; token/cost accounting event dropped',
      timestamp: new Date().toISOString(),
    }),
  );
}

const warnedUntaggedWhileBoundTypes = new Set<string>();
/** Warn once per message type when an untagged frame reaches a session
 *  guard while a session is bound (see `isActiveSessionMessage`). */
function warnUntaggedWhileBound(type: string): void {
  if (warnedUntaggedWhileBoundTypes.has(type)) return;
  warnedUntaggedWhileBoundTypes.add(type);
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'ws_client.untagged_guard_event',
      messageType: type,
      reason:
        'untagged frame passed a session guard while a session was bound; if this event is session-scoped, the server surface forgot to stamp sessionId',
      timestamp: new Date().toISOString(),
    }),
  );
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
  const hostPart =
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
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
