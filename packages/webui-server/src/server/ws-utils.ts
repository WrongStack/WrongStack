/**
 * Shared WebSocket utilities for both the standalone WebUI server and the
 * CLI's `--webui` embedded server. Extracted from the duplicated `send` /
 * `broadcast` / `sendResult` / `generateAuthToken` patterns that were
 * copy-pasted between `packages/webui/src/server/index.ts` and
 * `packages/cli/src/webui-server.ts`.
 */
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
  sendSerialized(ws, JSON.stringify(msg));
}

/**
 * Broadcast a JSON message to connected clients.
 * When a sessionId is present in msg.payload, only clients subscribed to that sessionId
 * (or clients without a bound session) receive the message.
 * Global messages without a sessionId are sent to all connected clients.
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
    if (!sessionId || !client.sessionId || client.sessionId === sessionId) {
      sendSerialized(ws, data, frameBytes);
    }
  }
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
 */
export function sendResult(ws: WebSocket, success: boolean, message: string): void {
  send(ws, { type: 'key.operation_result', payload: { success, message } });
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
