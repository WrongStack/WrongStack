/**
 * Shared mailbox type -> icon + tone mapping.
 *
 * One map so the grouped view and the live feed render identical metadata: a
 * new message type added to `@wrongstack/core` only has to be added here, and
 * the type checker catches the missing entry.
 *
 * Leaf module — no React state, no styling. `tone` is a semantic token the
 * Badge component maps to colours.
 */
import type { HqMailboxMessageType } from '@wrongstack/core/hq';
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
  /** Semantic severity, resolved to colour by the Badge component. */
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
