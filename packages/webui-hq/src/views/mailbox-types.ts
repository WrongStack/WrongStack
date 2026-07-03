/**
 * Shared mailbox type/label/icon mapping.
 *
 * Extracted from `mailbox.tsx` so both the grouped view and the live
 * feed can render the same metadata. Keeping the map in one place
 * means a new message type added to `@wrongstack/core` only needs to
 * be added here (and tests will catch the missing entry).
 *
 * This is a leaf module — no React, no state. It depends only on the
 * core types so it can be unit-tested with vitest.
 */
import type { HqMailboxMessageType } from '@wrongstack/core';

export interface MailboxTypeMeta {
  icon: string;
  /** CSS class suffix used in the `.hq-pill` family (see app.css). */
  tone: 'info' | 'warn' | 'running' | 'idle' | 'error';
}

export const MAILBOX_TYPE_LABEL: Record<HqMailboxMessageType, MailboxTypeMeta> = {
  note: { icon: '📝', tone: 'info' },
  ask: { icon: '❓', tone: 'warn' },
  assign: { icon: '📌', tone: 'warn' },
  steer: { icon: '🛞', tone: 'warn' },
  btw: { icon: '💬', tone: 'info' },
  broadcast: { icon: '📣', tone: 'info' },
  status: { icon: '📊', tone: 'idle' },
  result: { icon: '✅', tone: 'running' },
  review: { icon: '🔍', tone: 'info' },
  control: { icon: '⚙️', tone: 'error' },
};

export const ALL_MAILBOX_TYPES: readonly HqMailboxMessageType[] = Object.keys(
  MAILBOX_TYPE_LABEL,
) as readonly HqMailboxMessageType[];
