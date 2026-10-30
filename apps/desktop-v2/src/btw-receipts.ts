import { DurableSessionLog, sessionLogKey } from './durable-session-log';
import { record } from './engine-values';

/** A BTW note this window sent to a session's leader through the project mailbox. */
export interface SentBtw {
  messageId: string;
  text: string;
  sentAt: number;
}
export type BtwStatus = 'saved' | 'read' | 'completed' | 'not-found';
export interface SavedBtwReceipts {
  version: 1;
  notes: SentBtw[];
}

const MAX_PER_SESSION = 50;
const MAX_TEXT = 4000;

/** One native slot per project session, so sessions never overwrite each other's notes. */
export function btwReceiptKey(projectId: string, sessionId: string) {
  return sessionLogKey('btw-receipts', projectId, sessionId);
}

export function parseBtwReceipts(value: unknown): SentBtw[] {
  if (value === null) return [];
  const data = value as Partial<SavedBtwReceipts> | undefined;
  if (
    data?.version !== 1 ||
    !Array.isArray(data.notes) ||
    data.notes.length > MAX_PER_SESSION ||
    !data.notes.every(
      (note) =>
        !!note &&
        typeof note.messageId === 'string' &&
        !!note.messageId &&
        typeof note.text === 'string' &&
        note.text.length <= MAX_TEXT &&
        Number.isSafeInteger(note.sentAt) &&
        note.sentAt > 0,
    )
  )
    throw Error('Saved BTW receipts have an unsupported format.');
  return data.notes.map((note) => ({
    messageId: note.messageId,
    text: note.text,
    sentAt: note.sentAt,
  }));
}

/** Newest first, one entry per message id, bounded. */
export function mergeBtw(...lists: readonly SentBtw[][]): SentBtw[] {
  const byId = new Map<string, SentBtw>();
  for (const note of lists.flat()) if (!byId.has(note.messageId)) byId.set(note.messageId, note);
  return [...byId.values()].sort((a, b) => b.sentAt - a.sentAt).slice(0, MAX_PER_SESSION);
}

/**
 * Notes sent from this desktop, newest first, per session. Mailbox records carry no session,
 * so only ids captured at send time are tracked. With a project storage attached they survive
 * a restart; the list is append-only, so a save that lost a revision race re-reads, merges by
 * message id and retries instead of dropping either side.
 */
export class BtwReceiptStore extends DurableSessionLog<SentBtw, SavedBtwReceipts> {
  constructor() {
    super({
      label: 'BTW receipts',
      parse: parseBtwReceipts,
      merge: mergeBtw,
      serialize: (notes) => ({ version: 1, notes }),
    });
  }
  override record(sessionId: string, note: SentBtw) {
    return super.record(sessionId, { ...note, text: note.text.slice(0, MAX_TEXT) });
  }
}
export const btwReceipts = new BtwReceiptStore();

/**
 * Receipt state of one mailbox record: completed beats read beats merely saved. A record the
 * mailbox no longer returns (purged, compacted or outside the read window) is reported as such
 * rather than guessed.
 */
export function btwStatus(mail: Record<string, unknown> | undefined): BtwStatus {
  if (!mail) return 'not-found';
  if (mail['completed'] === true) return 'completed';
  const readers = Object.keys(record(mail['readBy'])).length;
  const count = typeof mail['readByCount'] === 'number' ? mail['readByCount'] : 0;
  return readers > 0 || count > 0 ? 'read' : 'saved';
}

export const BTW_STATUS_LABELS: Record<BtwStatus, string> = {
  saved: 'Saved · not read yet',
  read: 'Read by the leader',
  completed: 'Handled',
  'not-found': 'No longer in the recent mailbox',
};
