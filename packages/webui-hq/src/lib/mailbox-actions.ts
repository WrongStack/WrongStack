/**
 * WebUI client for mailbox message actions (skeleton).
 *
 * Phase 3 skeleton: thin `fetch` wrappers around the server routes
 * that will land in `feat/hq-mailbox-message-actions` Phase 4. Each
 * wrapper returns the parsed JSON or throws on a non-2xx response so
 * the caller can show a meaningful error in the toast / inline
 * status row.
 *
 * Optimistic updates are not handled here — they live in the React
 * component (Phase 4) so the server remains the source of truth.
 */
import type { MailboxActionInput, MailboxActionResult } from '@wrongstack/core';

interface ServerError {
  error: { code: string; message: string };
}

function isServerError(value: unknown): value is ServerError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { error?: unknown };
  if (typeof v.error !== 'object' || v.error === null) return false;
  const e = v.error as { code?: unknown; message?: unknown };
  return typeof e.code === 'string' && typeof e.message === 'string';
}

async function postAction(input: MailboxActionInput): Promise<MailboxActionResult> {
  const res = await fetch(`/api/mailbox/messages/${encodeURIComponent(input.mailId)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as unknown;
      if (isServerError(body)) detail = `${body.error.code}: ${body.error.message}`;
    } catch {
      // ignore JSON parse errors; the status line is enough
    }
    throw new Error(`mailbox action failed — ${detail}`);
  }
  return (await res.json()) as MailboxActionResult;
}

export const mailboxActions = {
  markRead: (input: Omit<MailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'mark-read' }),

  acknowledge: (input: Omit<MailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'acknowledge' }),

  reopen: (input: Omit<MailboxActionInput, 'action'>) => postAction({ ...input, action: 'reopen' }),

  softDelete: (input: Omit<MailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'soft-delete' }),

  restore: (input: Omit<MailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'restore' }),
} as const;
