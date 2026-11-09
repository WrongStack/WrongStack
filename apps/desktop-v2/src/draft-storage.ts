/** Preserve the order of saves for each session even if native IPC completes out of order. */
export class DraftWriter {
  private pending = new Map<string, Promise<void>>();
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
  write(id: string, text: string): Promise<void> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
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
    this.pending.set(id, next);
    void next
      .finally(() => {
        if (this.pending.get(id) === next) this.pending.delete(id);
      })
      .catch(() => {});
    return next;
  }
}
