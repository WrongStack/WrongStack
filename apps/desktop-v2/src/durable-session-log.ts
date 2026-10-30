import type { ProjectFormDraftStorage } from './requirement-draft';

/** Saved form of a per-session log: a versioned envelope around its entries. */
export interface SavedSessionLog<T> {
  version: 1;
  entries: T[];
}

/** One native slot per project session and log kind, so sessions never overwrite each other. */
export async function sessionLogKey(kind: string, projectId: string, sessionId: string) {
  const source = JSON.stringify([kind, projectId, sessionId]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return `${kind}:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export interface SessionLogOptions<T, Saved> {
  /** Sentence subject in error messages, e.g. "BTW receipts". */
  label: string;
  /** Validates a saved value (null when nothing was saved); throws on an unsupported format. */
  parse: (value: unknown) => T[];
  /** Newest first, one entry per identity, bounded. */
  merge: (...lists: readonly T[][]) => T[];
  /** Saved envelope for the current entries. */
  serialize: (entries: T[]) => Saved;
}

interface SessionEntries<T, Saved> {
  entries: T[];
  storage?: ProjectFormDraftStorage<Saved> | undefined;
  revision: number;
  loaded?: Promise<void> | undefined;
  error: string;
}

/**
 * Append-only per-session records of this desktop's own actions. With a project storage attached
 * they survive a restart; a save that lost a revision race re-reads, merges by identity and
 * retries instead of dropping either side. Entries recorded before the saved list loaded are kept.
 */
export class DurableSessionLog<T, Saved = SavedSessionLog<T>> {
  private sessions = new Map<string, SessionEntries<T, Saved>>();
  private listeners = new Set<() => void>();
  private readonly empty: T[] = [];
  constructor(private readonly options: SessionLogOptions<T, Saved>) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private entry(sessionId: string) {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = { entries: this.empty, revision: 0, error: '' };
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }
  private set(sessionId: string, patch: Partial<SessionEntries<T, Saved>>) {
    this.sessions.set(sessionId, { ...this.entry(sessionId), ...patch });
    for (const listener of this.listeners) listener();
  }
  list = (sessionId: string): T[] => this.sessions.get(sessionId)?.entries ?? this.empty;
  error = (sessionId: string): string => this.sessions.get(sessionId)?.error ?? '';
  /** Loads saved entries once per session; entries recorded before the load are kept. */
  attach(sessionId: string, storage: ProjectFormDraftStorage<Saved>) {
    const current = this.entry(sessionId);
    if (current.loaded) return current.loaded;
    const { label, parse, merge } = this.options;
    const loaded = storage
      .get()
      .then(async (saved) => {
        const stored = parse(saved.value);
        const entries = merge(this.list(sessionId), stored);
        this.set(sessionId, { entries, revision: saved.revision, error: '' });
        // Entries recorded while loading are written back with the saved ones.
        if (entries.length !== stored.length) await this.persist(sessionId);
      })
      .catch((error) => {
        // A later attach may retry the load.
        this.sessions.set(sessionId, { ...this.entry(sessionId), loaded: undefined });
        this.set(sessionId, { error: `${label} could not be loaded: ${String(error)}` });
      });
    this.set(sessionId, { storage, loaded });
    return loaded;
  }
  async record(sessionId: string, item: T) {
    this.set(sessionId, { entries: this.options.merge([item], this.list(sessionId)) });
    const { loaded } = this.entry(sessionId);
    if (loaded) await loaded;
    await this.persist(sessionId);
  }
  private async persist(sessionId: string) {
    const { label, parse, merge, serialize } = this.options;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { storage, revision } = this.entry(sessionId);
      if (!storage) return;
      try {
        const next = await storage.save(serialize(this.list(sessionId)), revision);
        this.set(sessionId, { revision: next, error: '' });
        return;
      } catch (error) {
        if (!String(error).includes('DRAFT_CONFLICT')) {
          this.set(sessionId, { error: `${label} were not saved: ${String(error)}` });
          return;
        }
        try {
          const saved = await storage.get();
          this.set(sessionId, {
            entries: merge(this.list(sessionId), parse(saved.value)),
            revision: saved.revision,
          });
        } catch (reload) {
          this.set(sessionId, { error: `${label} were not saved: ${String(reload)}` });
          return;
        }
      }
    }
    this.set(sessionId, {
      error: `${label} kept changing in another window and were not saved here.`,
    });
  }
}
