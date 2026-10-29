import { record } from './engine-values';
import type { ProjectFormDraftStorage } from './requirement-draft';

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
export async function btwReceiptKey(projectId: string, sessionId: string) {
  const source = JSON.stringify(['btw-receipts', projectId, sessionId]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return `btw-receipts:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
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

interface SessionReceipts {
  notes: SentBtw[];
  storage?: ProjectFormDraftStorage<SavedBtwReceipts> | undefined;
  revision: number;
  loaded?: Promise<void> | undefined;
  error: string;
}

/**
 * Notes sent from this desktop, newest first, per session. Mailbox records carry no session,
 * so only ids captured at send time are tracked. With a project storage attached they survive
 * a restart; the list is append-only, so a save that lost a revision race re-reads, merges by
 * message id and retries instead of dropping either side.
 */
export class BtwReceiptStore {
  private sessions = new Map<string, SessionReceipts>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private entry(sessionId: string) {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { notes: EMPTY, revision: 0, error: '' };
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }
  private set(sessionId: string, patch: Partial<SessionReceipts>) {
    this.sessions.set(sessionId, { ...this.entry(sessionId), ...patch });
    for (const listener of this.listeners) listener();
  }
  list = (sessionId: string): SentBtw[] => this.sessions.get(sessionId)?.notes ?? EMPTY;
  error = (sessionId: string): string => this.sessions.get(sessionId)?.error ?? '';
  /** Loads saved receipts once per session; notes recorded before the load are kept. */
  attach(sessionId: string, storage: ProjectFormDraftStorage<SavedBtwReceipts>) {
    const current = this.entry(sessionId);
    if (current.loaded) return current.loaded;
    const loaded = storage
      .get()
      .then(async (saved) => {
        const stored = parseBtwReceipts(saved.value);
        const notes = mergeBtw(this.list(sessionId), stored);
        this.set(sessionId, { notes, revision: saved.revision, error: '' });
        // Notes recorded while loading are written back with the saved ones.
        if (notes.length !== stored.length) await this.persist(sessionId);
      })
      .catch((error) => {
        // A later attach may retry the load.
        this.sessions.set(sessionId, { ...this.entry(sessionId), loaded: undefined });
        this.set(sessionId, { error: `BTW receipts could not be loaded: ${String(error)}` });
      });
    this.set(sessionId, { storage, loaded });
    return loaded;
  }
  async record(sessionId: string, note: SentBtw) {
    this.set(sessionId, {
      notes: mergeBtw([{ ...note, text: note.text.slice(0, MAX_TEXT) }], this.list(sessionId)),
    });
    const { loaded } = this.entry(sessionId);
    if (loaded) await loaded;
    await this.persist(sessionId);
  }
  private async persist(sessionId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { storage, revision } = this.entry(sessionId);
      if (!storage) return;
      const notes = this.list(sessionId);
      try {
        const next = await storage.save({ version: 1, notes }, revision);
        this.set(sessionId, { revision: next, error: '' });
        return;
      } catch (error) {
        if (!String(error).includes('DRAFT_CONFLICT')) {
          this.set(sessionId, { error: `BTW receipts were not saved: ${String(error)}` });
          return;
        }
        try {
          const saved = await storage.get();
          this.set(sessionId, {
            notes: mergeBtw(this.list(sessionId), parseBtwReceipts(saved.value)),
            revision: saved.revision,
          });
        } catch (reload) {
          this.set(sessionId, { error: `BTW receipts were not saved: ${String(reload)}` });
          return;
        }
      }
    }
    this.set(sessionId, {
      error: 'BTW receipts kept changing in another window and were not saved here.',
    });
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
