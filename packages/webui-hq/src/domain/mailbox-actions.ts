/**
 * WebUI client for mailbox message actions.
 *
 * Thin `fetch` wrappers around `POST /api/mailbox/messages/:id/action`
 * on the HQ server. Each wrapper returns the parsed JSON or throws on
 * a non-2xx response so the caller can show a meaningful error in the
 * toast / inline status row.
 *
 * The HQ server resolves the target project mailbox SERVER-SIDE from
 * `projectId`/`sessionId` (same trust model as /api/mailbox-send), so
 * every call must carry the projectId of the message's group.
 *
 * Optimistic updates are not handled here — they live in the React
 * component so the server remains the source of truth.
 */
import type { MailboxActionInput, MailboxActionResult } from '@wrongstack/core/coordination';
import { useHqStore } from '../data/store/index.js';
import { authorizedFetch } from '../data/api.js';

/** Wire input: the core action input + the HQ project routing key. */
export type HqMailboxActionInput = MailboxActionInput & {
  projectId?: string | undefined;
  sessionId?: string | undefined;
};

interface ServerError {
  error: string | { code: string; message: string };
}

function isServerError(value: unknown): value is ServerError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { error?: unknown };
  if (typeof v.error === 'string') return true;
  if (typeof v.error !== 'object' || v.error === null) return false;
  const e = v.error as { code?: unknown; message?: unknown };
  return typeof e.code === 'string' && typeof e.message === 'string';
}

async function postAction(input: HqMailboxActionInput): Promise<MailboxActionResult> {
  const path = `/api/mailbox/messages/${encodeURIComponent(input.mailId)}/action`;
  const res = await authorizedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.status === 401) useHqStore.getState().markAuthRequired();
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as unknown;
      if (isServerError(body)) {
        detail =
          typeof body.error === 'string'
            ? body.error
            : `${body.error.code}: ${body.error.message}`;
      }
    } catch {
      // ignore JSON parse errors; the status line is enough
    }
    throw new Error(`mailbox action failed — ${detail}`);
  }
  return (await res.json()) as MailboxActionResult;
}

export const mailboxActions = {
  markRead: (input: Omit<HqMailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'mark-read' }),

  acknowledge: (input: Omit<HqMailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'acknowledge' }),

  reopen: (input: Omit<HqMailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'reopen' }),

  softDelete: (input: Omit<HqMailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'soft-delete' }),

  restore: (input: Omit<HqMailboxActionInput, 'action'>) =>
    postAction({ ...input, action: 'restore' }),
} as const;
