/**
 * Same-session agent notes — ephemeral inbox on the live Context.
 *
 * Distinct from `/btw` (user mid-run steering) and from mailbox (durable
 * cross-session mail). A note is posted in-process, queued here, and folded
 * into the recipient's conversation at the next iteration boundary.
 *
 * @module session-notes
 */

import type { Context } from './context.js';

export type SessionNoteKind = 'note' | 'result' | 'ask' | 'steer';

export interface SessionNote {
  from: string;
  kind: SessionNoteKind;
  body: string;
  subject?: string | undefined;
}

const META_KEY = '_sessionNotes';
const MAX_PENDING = 20;
const MAX_BODY = 2_000;

function readQueue(ctx: Context): SessionNote[] {
  const raw = ctx.meta[META_KEY];
  return Array.isArray(raw) ? (raw as SessionNote[]) : [];
}

function clipBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_BODY) return trimmed;
  return `${trimmed.slice(0, MAX_BODY)}…`;
}

/** Queue a note for this agent's next iteration. Returns pending count. */
export function enqueueSessionNote(ctx: Context, note: SessionNote): number {
  const body = clipBody(note.body);
  if (!body) return readQueue(ctx).length;
  const next: SessionNote[] = [
    ...readQueue(ctx),
    {
      from: note.from.trim() || 'unknown',
      kind: note.kind,
      body,
      ...(note.subject?.trim() ? { subject: note.subject.trim() } : {}),
    },
  ].slice(-MAX_PENDING);
  ctx.meta[META_KEY] = next;
  return next.length;
}

export function pendingSessionNoteCount(ctx: Context): number {
  return readQueue(ctx).length;
}

/** Read and clear pending notes in FIFO order. */
export function consumeSessionNotes(ctx: Context): SessionNote[] {
  const notes = readQueue(ctx);
  if (notes.length > 0) delete ctx.meta[META_KEY];
  return notes;
}

/** Compact block the agent reads at the iteration boundary. */
export function buildSessionNoteBlock(notes: SessionNote[]): string {
  const items = notes.map((n) => {
    const header = n.subject
      ? `[SESSION ${n.kind.toUpperCase()} from ${n.from} — ${n.subject}]`
      : `[SESSION ${n.kind.toUpperCase()} from ${n.from}]`;
    return `${header}\n${n.body}`;
  });
  return [
    '[Same-session notes — in-process, not mailbox. Fold into the current task;',
    'do not restart unless a steer contradicts the goal.]',
    '',
    ...items,
  ].join('\n');
}
