/** Preserve the order of saves for each session even if native IPC completes out of order. */
export class DraftWriter {
  private pending = new Map<string, Promise<void>>();
  private queued = new Map<string, { text: string; promise: Promise<void> }>();
  private revisions = new Map<string, number>();
  private blocked = new Set<string>();
  constructor(
    private save: (id: string, text: string, expectedRevision: number) => Promise<number>,
  ) {}
  initialize(id: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw Error('Invalid draft revision.');
    this.revisions.set(id, revision);
    this.blocked.delete(id);
  }
  async drain(id: string): Promise<void> {
    await this.pending.get(id)?.catch(() => {});
  }
  isPending(id: string): boolean {
    return this.pending.has(id);
  }
  revision(id: string): number | undefined {
    return this.revisions.get(id);
  }
  /**
   * Saves `text` after the session's earlier saves. While a save is in flight, later writes
   * wait as one: each replaces the waiting text and shares its promise, so typing saves the
   * newest text once per native round trip instead of once per keystroke.
   */
  write(id: string, value: string): Promise<void> {
    const waiting = this.queued.get(id);
    if (waiting) {
      waiting.text = value;
      return waiting.promise;
    }
    const entry = { text: value, promise: Promise.resolve() };
    const previous = this.pending.get(id);
    if (previous) this.queued.set(id, entry);
    const next = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        // From here on a new write waits behind this save instead of joining it.
        if (this.queued.get(id) === entry) this.queued.delete(id);
        const text = entry.text;
        if (this.blocked.has(id))
          throw Error('DRAFT_CONFLICT: This draft changed in another window');
        const revision = this.revisions.get(id);
        if (revision === undefined) throw Error('Draft has not been loaded.');
        try {
          const saved = await this.save(id, text, revision);
          if (!Number.isSafeInteger(saved) || saved !== revision + 1)
            throw Error('Invalid draft save acknowledgement.');
          this.revisions.set(id, saved);
        } catch (error) {
          if (String(error).includes('DRAFT_CONFLICT')) this.blocked.add(id);
          throw error;
        }
      });
    entry.promise = next;
    this.pending.set(id, next);
    void next
      .finally(() => {
        if (this.pending.get(id) === next) this.pending.delete(id);
      })
      .catch(() => {});
    return next;
  }
}
