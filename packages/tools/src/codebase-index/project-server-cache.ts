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
