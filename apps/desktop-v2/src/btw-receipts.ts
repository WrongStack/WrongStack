import { record } from './engine-values';

/** A BTW note this window sent to a session's leader through the project mailbox. */
export interface SentBtw {
  messageId: string;
  text: string;
  sentAt: number;
}
export type BtwStatus = 'saved' | 'read' | 'completed' | 'not-found';

const MAX_PER_SESSION = 50;

/**
 * Notes sent from this window, newest first, per session. Mailbox records carry no session,
 * so only ids captured at send time are tracked; the list does not survive a restart.
 */
export class BtwReceiptStore {
  private sessions = new Map<string, SentBtw[]>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  list = (sessionId: string): SentBtw[] => this.sessions.get(sessionId) ?? EMPTY;
  record(sessionId: string, note: SentBtw) {
    const current = this.list(sessionId).filter((item) => item.messageId !== note.messageId);
    this.sessions.set(sessionId, [note, ...current].slice(0, MAX_PER_SESSION));
    for (const listener of this.listeners) listener();
  }
}
const EMPTY: SentBtw[] = [];
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
