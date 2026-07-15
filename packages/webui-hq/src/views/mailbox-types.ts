/**
 * Shared mailbox type/label/icon mapping.
 *
 * Extracted from `mailbox.tsx` so both the grouped view and the live
 * feed can render the same metadata. Keeping the map in one place
 * means a new message type added to `@wrongstack/core` only needs to
 * be added here (and tests will catch the missing entry).
 *
 * This is a leaf module — no React state. It depends only on the core types
 * and Lucide icons so it can be unit-tested with vitest.
 */
import type { HqMailboxMessageType } from '@wrongstack/core';
import {
  Megaphone,
  MessageCircle,
  NotebookPen,
  Settings,
  Gauge,
  CircleCheckBig,
  Search,
  LifeBuoy,
  Pin,
  type LucideIcon,
} from 'lucide-react';

export interface MailboxTypeMeta {
  icon: LucideIcon;
  /** CSS class suffix used in the `.hq-pill` family (see app.css). */
  tone: 'info' | 'warn' | 'running' | 'idle' | 'error';
}

export const MAILBOX_TYPE_LABEL: Record<HqMailboxMessageType, MailboxTypeMeta> = {
  note: { icon: NotebookPen, tone: 'info' },
  ask: { icon: LifeBuoy, tone: 'warn' },
  assign: { icon: Pin, tone: 'warn' },
  steer: { icon: LifeBuoy, tone: 'warn' },
  btw: { icon: MessageCircle, tone: 'info' },
  broadcast: { icon: Megaphone, tone: 'info' },
  status: { icon: Gauge, tone: 'idle' },
  result: { icon: CircleCheckBig, tone: 'running' },
  review: { icon: Search, tone: 'info' },
  control: { icon: Settings, tone: 'error' },
};

export const ALL_MAILBOX_TYPES: readonly HqMailboxMessageType[] = Object.keys(
  MAILBOX_TYPE_LABEL,
) as readonly HqMailboxMessageType[];
