import { isMailboxMessageUnread, MAILBOX_MESSAGE_TYPES } from '@wrongstack/contracts/types/mailbox';
import { record } from './engine-values';

export const mailboxSendTypes = MAILBOX_MESSAGE_TYPES.filter((type) => type !== 'control');
export interface MailDraft {
  to: string;
  type: string;
  audience: string;
  priority: string;
  subject: string;
  body: string;
  replyTo: string;
}
export const emptyMailDraft = (): MailDraft => ({
  to: '',
  type: 'note',
  audience: 'all',
  priority: 'normal',
  subject: '',
  body: '',
  replyTo: '',
});
export const hasMailDraft = (draft: MailDraft) =>
  !!(draft.to || draft.subject || draft.body || draft.replyTo);
export const unreadMail = (mail: Record<string, unknown>) =>
  isMailboxMessageUnread({
    completed: mail['completed'] === true,
    readBy: record(mail['readBy']),
    ...(typeof mail['readByCount'] === 'number' ? { readByCount: mail['readByCount'] } : {}),
  });
const stamp = (mail: Record<string, unknown>) =>
  typeof mail['timestamp'] === 'number'
    ? mail['timestamp']
    : Date.parse(String(mail['timestamp'])) || 0;
export function mailboxThreads(messages: Record<string, unknown>[]) {
  const byId = new Map(messages.map((mail) => [String(mail['id']), mail]));
  const root = (mail: Record<string, unknown>): string => {
    const seen = new Set<string>();
    let id = String(mail['id']);
    while (true) {
      if (seen.has(id)) return [...seen].sort()[0]!;
      seen.add(id);
      const parent = byId.get(id)?.['replyTo'];
      if (typeof parent !== 'string' || !parent) return id;
      if (!byId.has(parent)) return parent;
      id = parent;
    }
  };
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const mail of messages) {
    const id = root(mail);
    const group = groups.get(id) ?? [];
    group.push(mail);
    groups.set(id, group);
  }
  return [...groups]
    .map(([id, values]) => {
      const items = values.sort((a, b) => stamp(a) - stamp(b));
      return {
        id,
        items,
        latest: items.at(-1)!,
        first: byId.get(id) ?? items[0]!,
        missingParent: !byId.has(id),
      };
    })
    .sort((a, b) => stamp(b.latest) - stamp(a.latest));
}
export function mailboxDuration(hours: string, label: string) {
  const value = Number(hours);
  // Whole milliseconds: binary floating point turns ordinary decimal hours
  // into a fraction (1.1 × 3600000 = 3960000.0000000005), which the safe-
  // integer bound below — there to reject overflowing input — then refused.
  const ms = Math.round(value * 3600000);
  if (!hours.trim() || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(ms))
    throw Error(`${label} must be a non-negative number of hours.`);
  return ms;
}

/** The oldest loaded message's timestamp: the inclusive bound for reading older messages. */
export function oldestMailTimestamp(messages: readonly Record<string, unknown>[]): string | null {
  let oldest: string | null = null;
  for (const message of messages) {
    const ts = message['timestamp'];
    if (
      typeof ts === 'string' &&
      Number.isFinite(Date.parse(ts)) &&
      (oldest === null || ts < oldest)
    )
      oldest = ts;
  }
  return oldest;
}

/**
 * Adds an older page to the loaded messages. The bound is inclusive, so messages already loaded
 * come back and are skipped; `added` is how many were new, and a page shorter than requested
 * means there is nothing older to read in this view.
 */
export function withOlderMail(
  loaded: readonly Record<string, unknown>[],
  page: readonly Record<string, unknown>[],
  requested: number,
): { messages: Record<string, unknown>[]; added: number; complete: boolean; stuck: boolean } {
  const ids = new Set(loaded.map((message) => String(message['id'])));
  const fresh = page.filter((message) => !ids.has(String(message['id'])));
  // A full page of already-loaded messages: more than a page share the oldest timestamp, so a
  // timestamp bound cannot move past them.
  const stuck = fresh.length === 0 && page.length >= requested;
  return {
    messages: [...loaded, ...fresh],
    added: fresh.length,
    complete: !stuck && page.length < requested,
    stuck,
  };
}
