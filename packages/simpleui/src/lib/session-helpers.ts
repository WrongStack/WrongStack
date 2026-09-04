/**
 * Stateless helpers shared by the SimpleUI session shell and its message
 * handling. Extracted from `simple-ui-session.tsx` so the session component
 * stays focused on composition; re-exported from there for compatibility.
 *
 * @module simpleui/lib/session-helpers
 */

import { isUnreadIncomingMailboxMessage } from './mailbox-store.js';

/** Format a token count for compact display (e.g. `12k`, `1.5m`). */
export function compactTokens(value: number): string {
  if (!value) return '0';
  // Values from 999_500 up round to a four-digit k label ("1000k" in the
  // integer tier, "1000.0k" in the decimal tier) — roll them into the m
  // tier, where they display as `1.0m`.
  if (value >= 999_500) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toString();
}

/** Generate a prefixed, best-effort unique message id. */
export function messageId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

/** Read a string field from a wire payload, defaulting to `''`. */
export function payloadText(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === 'string' ? value : '';
}

/** True when a wire payload reports `success === true`. */
export function payloadSucceeded(payload: Record<string, unknown> | undefined): boolean {
  return payload?.['success'] === true;
}

/** True when a mailbox payload is an unread incoming message. */
export function isIncomingMailboxPayload(payload: Record<string, unknown> | undefined): boolean {
  return isUnreadIncomingMailboxMessage({
    completed: false,
    readByCount: 0,
    from: payloadText(payload, 'from'),
  });
}

/** Format an elapsed duration as a compact uptime string (`1h 23m`). */
export function formatUptime(ms: number): string {
  // A server-generated startedAt can sit slightly in the future when clocks
  // skew — elapsed time clamps at zero like relativeSessionTime does.
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
