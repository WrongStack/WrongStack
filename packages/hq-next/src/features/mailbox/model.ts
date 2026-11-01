/**
 * Mailbox rules as pure functions over the HQ wire summaries. Only types come
 * from the legacy domain, so these run (and are tested) anywhere.
 */
import type { FlatMessage } from '@hq/domain/mailbox-grouping';
import type { HqMailboxMessageSummary, HqMailboxSummary } from '@wrongstack/hq';

export const MAIL_TYPE_LABEL: Record<string, string> = {
  note: 'Note',
  ask: 'Question',
  assign: 'Assignment',
  steer: 'Steer',
  btw: 'FYI',
  queue: 'Queued note',
  broadcast: 'Broadcast',
  status: 'Status',
  result: 'Result',
  review: 'Review request',
  control: 'Control',
};

export function mailTypeLabel(type: string): string {
  return MAIL_TYPE_LABEL[type] ?? type;
}

/** Types that ask the receiver to act, not just to know. */
const ACTION_TYPES = new Set(['ask', 'assign', 'steer', 'review', 'control']);

export function asksForAction(message: Pick<HqMailboxMessageSummary, 'type'>): boolean {
  return ACTION_TYPES.has(message.type);
}

/** Same rule as the contracts' `isMailboxMessageUnread`, for the summary shape. */
export function isUnread(
  message: Pick<HqMailboxMessageSummary, 'completed' | 'readCount'>,
): boolean {
  if (message.completed) return false;
  return message.readCount === undefined || message.readCount === 0;
}

export interface MailFilters {
  query: string;
  projectId: string;
  type: string;
  priority: string;
  showDone: boolean;
}

export const DEFAULT_FILTERS: MailFilters = {
  query: '',
  projectId: 'all',
  type: 'all',
  priority: 'all',
  showDone: false,
};

export function filterMail(messages: readonly FlatMessage[], filters: MailFilters): FlatMessage[] {
  const words = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return messages.filter(({ message, projectId }) => {
    if (!filters.showDone && message.completed) return false;
    if (filters.projectId !== 'all' && projectId !== filters.projectId) return false;
    if (filters.type !== 'all' && message.type !== filters.type) return false;
    if (filters.priority !== 'all' && message.priority !== filters.priority) return false;
    if (words.length === 0) return true;
    const text = [message.subject, message.from, message.to, message.bodyPreview, message.messageId]
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export interface MailFigures {
  messages: number;
  unread: number;
  open: number;
  high: number;
  onlineAgents: number;
}

/** Server-side totals: they count messages this tab has never streamed. */
export function mailFigures(mailboxes: readonly HqMailboxSummary[]): MailFigures {
  return mailboxes.reduce<MailFigures>(
    (sum, mailbox) => ({
      messages: sum.messages + mailbox.messageCount,
      unread: sum.unread + mailbox.unreadCount,
      open: sum.open + mailbox.incompleteCount,
      high: sum.high + mailbox.highPriorityCount,
      onlineAgents: sum.onlineAgents + mailbox.onlineAgentCount,
    }),
    { messages: 0, unread: 0, open: 0, high: 0, onlineAgents: 0 },
  );
}

export interface ComposeDraft {
  projectId: string;
  type: string;
  to: string;
  subject: string;
  body: string;
  priority: 'high' | 'normal' | 'low';
  leadersOnly: boolean;
}

export function emptyDraft(projectId: string): ComposeDraft {
  return {
    projectId,
    type: 'steer',
    to: 'leader',
    subject: '',
    body: '',
    priority: 'normal',
    leadersOnly: false,
  };
}

/** A reply goes back to the sender, in the same project, as a note. */
export function replyDraft(flat: FlatMessage, fallbackProjectId: string): ComposeDraft {
  const subject = flat.message.subject.trim();
  return {
    ...emptyDraft(flat.projectId ?? fallbackProjectId),
    type: flat.message.type === 'ask' ? 'result' : 'note',
    to: flat.message.from,
    subject: subject === '' ? '' : /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    priority: flat.message.priority === 'high' ? 'high' : 'normal',
  };
}
