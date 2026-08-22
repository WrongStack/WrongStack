/** Small generation-scoped LRU used by the detached index server. */
export class GenerationLruCache<T> {
  private readonly entries = new Map<string, { generation: number; value: T }>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, generation: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.generation !== generation) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Read an entry regardless of which generation wrote it, without touching
   * LRU recency. Used by the project server to serve a previous-generation
   * (stale) answer while an index refresh is publishing — the caller marks the
   * response `stale` instead of failing the read.
   */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  /**
   * Like {@link peek} but exposes the entry's generation, so the stale-read
   * policy can bound how far a preserved entry may lag the publishing
   * generation before it is too old to serve.
   */
  peekEntry(key: string): { generation: number; value: T } | undefined {
    return this.entries.get(key);
  }

  set(key: string, generation: number, value: T): T {
    this.entries.delete(key);
    this.entries.set(key, { generation, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
