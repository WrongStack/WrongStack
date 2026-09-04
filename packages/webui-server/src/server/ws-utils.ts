/**
 * Shared WebSocket utilities for both the standalone WebUI server and the
 * CLI's `--webui` embedded server. Extracted from the duplicated `send` /
 * `broadcast` / `sendResult` / `generateAuthToken` patterns that were
 * copy-pasted between `packages/webui/src/server/index.ts` and
 * `packages/cli/src/webui-server.ts`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { scrubErrorDetail } from '@wrongstack/core/security';
// Value import (not `import type`): we reference `WebSocket.OPEN` below, which
// is a runtime value, not just a type.
import { WebSocket } from 'ws';
import type { ConnectedClient } from './types.js';

/** Maximum unsent data retained by one client before it is disconnected. */
export const WEBUI_WS_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/**
 * Send an already serialized frame while enforcing per-client backpressure.
 * A socket above the cap cannot be trusted to catch up: keeping it alive would
 * let `ws` retain every subsequent broadcast in memory.
 */
export function sendSerialized(ws: WebSocket, data: string, frameBytes?: number): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const buffered = Number.isFinite(ws.bufferedAmount) ? ws.bufferedAmount : 0;
  const bytes = frameBytes ?? Buffer.byteLength(data, 'utf8');
  if (buffered + bytes > WEBUI_WS_MAX_BUFFERED_BYTES) {
    try {
      ws.terminate();
    } catch {
      try {
        ws.close(1013, 'client cannot keep up');
      } catch {
        // Socket is already gone.
      }
    }
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a JSON message to a single WebSocket client.
 * No-op when the socket is not in OPEN state (disconnected / closing).
 */
export function send(ws: WebSocket, msg: object): void {
  sendSerialized(ws, JSON.stringify(stampDispatchSession(msg)));
}

/**
 * Broadcast a JSON message to connected clients.
 *
 * When a sessionId is present in msg.payload, only clients displaying that
 * session receive it — see `clientWantsSession`. Global messages without a
 * sessionId are sent to all connected clients.
 */
export function broadcast(
  clients: Map<WebSocket, ConnectedClient>,
  msg: object,
  targetSessionId?: string,
): void {
  const payload = (msg as { payload?: unknown }).payload;
  const sessionId =
    targetSessionId ??
    (payload &&
    typeof payload === 'object' &&
    'sessionId' in payload &&
    typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined);

  const data = JSON.stringify(msg);
  const frameBytes = Buffer.byteLength(data, 'utf8');
  for (const [ws, client] of clients) {
    if (clientWantsSession(client, sessionId)) sendSerialized(ws, data, frameBytes);
  }
}

/**
 * Does this connection display the session a message is addressed to?
 *
 * A page with four tabs open is ONE socket. Deciding delivery from
 * `client.sessionId` — the tab last touched — silently dropped the other
 * three tabs' runs at the wire, which looks exactly like "the background tab
 * stopped working". `sessionIds` is the declared open set (`session.subscribe`);
 * a connection that has not declared one keeps the old single-session filter,
 * so surfaces that only ever show one session are unaffected.
 */
export function clientWantsSession(
  client: Pick<ConnectedClient, 'sessionId' | 'sessionIds'>,
  sessionId: string | undefined,
): boolean {
  if (!sessionId) return true;
  if (client.sessionIds && client.sessionIds.size > 0) return client.sessionIds.has(sessionId);
  if (!client.sessionId) return true;
  return client.sessionId === sessionId;
}

/**
 * Broadcast unconditionally to all connected clients.
 */
export function broadcastAll(clients: Map<WebSocket, ConnectedClient>, msg: object): void {
  const data = JSON.stringify(msg);
  const frameBytes = Buffer.byteLength(data, 'utf8');
  for (const [ws] of clients) {
    sendSerialized(ws, data, frameBytes);
  }
}

/**
 * Send a success/failure result message (used by key.* and provider.* handlers).
 * The frontend expects `key.operation_result` with `{ success, message }`.
 *
 * The reply is stamped with the asking tab's session by {@link send} — see
 * {@link runWithDispatchSession}. Nothing here has to thread a session id.
 */
export function sendResult(ws: WebSocket, success: boolean, message: string): void {
  send(ws, { type: 'key.operation_result', payload: { success, message } });
}

/**
 * The session whose message is currently being dispatched.
 *
 * `key.operation_result` is the server's general-purpose "did that work?"
 * channel: 90-odd call sites across prefs, provider keys, session operations,
 * MCP, git, shell and the worklist, reached through six separate `sendResult`
 * helpers. Not one of them stamped a session — and one WebSocket connection
 * carries up to `MAX_OPEN_SESSIONS_PER_CONNECTION` (4) tabs. So a background
 * tab's error toast surfaced on whichever tab the user happened to be looking
 * at, while the tab that actually failed showed nothing. The codebase routes
 * everything else positively (`chatFor`/`sessionFor`, the lane stores); the
 * most-used result channel was the one thing that did not.
 *
 * Threading a session id through 90 call sites and six helper signatures would
 * touch every handler for one field. The session is already known at exactly
 * one place — the dispatch boundary, where the client's message names it — so
 * it is bound there and read at the single send site instead. Same mechanism
 * the SAGE project server already uses for request metadata
 * (`packages/sage/src/project-server.ts`).
 *
 * See docs/audit/webui-full-review-2026-09-03.md B-05.
 */
const dispatchSession = new AsyncLocalStorage<string | undefined>();

/**
 * Run one message dispatch with `sessionId` bound as the current session.
 *
 * Every `key.operation_result` sent while `fn` runs — including from an
 * `await`ed continuation, since that is what AsyncLocalStorage propagates —
 * is stamped for that tab.
 */
export function runWithDispatchSession<T>(sessionId: string | undefined, fn: () => T): T {
  return dispatchSession.run(sessionId, fn);
}

/**
 * Stamp the dispatching tab's session onto a `key.operation_result` frame.
 *
 * Deliberately narrow:
 *  - ONLY `key.operation_result`. Every other frame either already names its
 *    session or is genuinely project-wide, and blanket-stamping would hide a
 *    global answer from three of four tabs.
 *  - Never overwrites a `sessionId` a handler set itself.
 *  - No-op outside a dispatch (a timer, a watcher, a broadcast), where there
 *    is no asking tab and an unstamped frame correctly falls back to the tab
 *    in front.
 *
 * Exported because the CLI-embedded host has its own `send` that writes
 * straight to `sendSerialized`; it calls this so both hosts stamp alike.
 */
export function stampDispatchSession<T extends object>(msg: T): T {
  if ((msg as { type?: unknown }).type !== 'key.operation_result') return msg;
  const sessionId = dispatchSession.getStore();
  if (!sessionId) return msg;
  const payload = (msg as { payload?: unknown }).payload;
  if (payload !== undefined && (typeof payload !== 'object' || payload === null)) return msg;
  if (payload && 'sessionId' in payload) return msg;
  return { ...msg, payload: { ...(payload ?? {}), sessionId } };
}

/**
 * Extract a human-readable message from an unknown thrown value, safe to put
 * in a frame that leaves the process.
 *
 * WS-066: this was `err instanceof Error ? err.message : String(err)` — the
 * verbatim throw. A provider that echoes an `Authorization` header back in its
 * error body, or a connection string with an inline password, went straight to
 * the browser and into whatever the browser logs. {@link scrubErrorDetail}
 * keeps the message (this is a local dev tool; opaque errors would gut it) but
 * removes credentials and rewrites the home directory to `~`.
 *
 * For HTTP `/api/*` JSON bodies — a less authenticated surface — use
 * `sanitizeApiError` instead, which returns a category and nothing else.
 */
export function errMessage(err: unknown): string {
  return scrubErrorDetail(err);
}

/**
 * Generate a cryptographically random WebSocket auth token (hex string).
 * Shared between standalone and CLI-embedded WebUI servers.
 */
export function generateAuthToken(): string {
  return randomBytes(16).toString('hex');
}

export function resolveAuthToken(explicit?: string | undefined): string {
  const configured =
    explicit?.trim() ||
    process.env['WEBUI_TOKEN']?.trim() ||
    process.env['WEBUI_AUTH_TOKEN']?.trim();
  return configured || generateAuthToken();
}

export function hostForBrowserUrl(bindHost: string): string {
  if (bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::' || bindHost === '[::]') return '[::1]';
  if (bindHost.includes(':') && !bindHost.startsWith('[')) return `[${bindHost}]`;
  return bindHost;
}

export function buildWebUIAccessUrl(opts: {
  host: string;
  port: number;
  token?: string | undefined;
  protocol?: 'http' | 'https' | undefined;
  publicUrl?: string | undefined;
}): string {
  const protocol = opts.protocol ?? 'http';
  const base =
    opts.publicUrl?.trim() || `${protocol}://${hostForBrowserUrl(opts.host)}:${opts.port}`;
  if (!opts.token) return base;
  try {
    const url = new URL(base);
    url.searchParams.set('token', opts.token);
    const rendered = url.toString();
    const afterOrigin = base.slice(url.origin.length);
    if (url.pathname === '/' && !afterOrigin.startsWith('/')) {
      return `${url.origin}${url.search}${url.hash}`;
    }
    return rendered;
  } catch {
    return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(opts.token)}`;
  }
}

export function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * The session a client message names, or undefined. Session-scoped replies
 * (`brain.status`, `/diag`) use it so the answer describes the tab that asked
 * rather than whichever session the runtime happens to be on.
 */
export function messageSessionId(msg: { payload?: unknown }): string | undefined {
  const payload = msg.payload;
  return payload &&
    typeof payload === 'object' &&
    typeof (payload as { sessionId?: unknown }).sessionId === 'string'
    ? (payload as { sessionId: string }).sessionId
    : undefined;
}

/**
 * Copy a `requestId` from a request payload onto a response payload.
 *
 * B-04 (docs/audit/webui-full-review-2026-09-03.md) — the client's
 * `echoToChat: false` suppression is keyed by requestId, and the only way
 * the client can correlate a response with its request is to read the
 * same requestId back from the response. Inspect-style handlers
 * (`tools.list`, `memory.sage.*`, `skills.list`, `stats.get`, `diag.get`,
 * `context.debug`, `memory.list`) use this helper at the `ctx.send(ws,
 * …)` site so the response carries the correlation id without each
 * handler having to thread the request payload through manually.
 *
 * The `requestPayload` argument may be either the request message itself
 * (in which case its inner `payload.requestId` is consulted) or the
 * request payload object directly (then `requestId` is read from the
 * top level). The helper accepts both because some handlers have the
 * payload already unwrapped and some pass the full message.
 *
 * No-op when the request did not name a requestId — the suppression
 * stays unused and the chat-echo path runs as before.
 */
export function withRequestId<T extends Record<string, unknown>>(
  requestPayload: unknown,
  responsePayload: T,
): T & { requestId?: string } {
  if (!requestPayload || typeof requestPayload !== 'object') return responsePayload;
  const direct = (requestPayload as { requestId?: unknown }).requestId;
  const nested =
    (requestPayload as { payload?: { requestId?: unknown } | undefined }).payload?.requestId;
  const requestId = typeof direct === 'string' ? direct : nested;
  if (typeof requestId === 'string' && requestId.length > 0) {
    return { ...responsePayload, requestId };
  }
  return responsePayload;
}
