interface PooledIndexStore {
  close(): void;
}

type StoreFactory<TStore extends PooledIndexStore> = (
  projectRoot: string,
  opts?: { indexDir?: string | undefined },
) => TStore;

/**
 * How many warm connections to keep.
 *
 * Each pooled store carries SQLite's page cache and mmap reservation (128MiB
 * and 512MiB respectively on the `balanced` profile — see
 * `core/src/utils/perf-profile.ts`). The pool used to be unbounded with a
 * no-op `release()`, so every project a long-lived host touched became
 * permanent resident memory. Two keeps the common "one project, occasionally a
 * second" case warm; beyond that, reopening is cheap relative to the residency.
 */
const DEFAULT_MAX_WARM_STORES = 2;

interface PoolEntry<TStore> {
  store: TStore;
  /** Outstanding acquire() calls not yet released. Never evict while > 0. */
  refs: number;
  /** Monotonic counter for LRU ordering. */
  lastUsed: number;
}

/**
 * Warm-connection pool for IndexStore instances.
 *
 * Each (projectRoot, indexDir) pair gets one persisted store. Every read
 * operation (search, stats, graph) acquires the store from the pool instead of
 * opening a fresh SQLite connection, re-parsing the schema, and re-preparing
 * statements. The connection stays warm between calls, subject to
 * {@link DEFAULT_MAX_WARM_STORES}.
 */
export class StorePool<TStore extends PooledIndexStore> {
  private readonly stores = new Map<string, PoolEntry<TStore>>();
  private readonly keyByStore = new WeakMap<object, string>();
  private clock = 0;

  constructor(
    private readonly createStore: StoreFactory<TStore>,
    private readonly maxWarmStores: number = DEFAULT_MAX_WARM_STORES,
  ) {}

  private key(projectRoot: string, indexDir?: string): string {
    return `${projectRoot}\u0000${indexDir ?? ''}`;
  }

  /** Borrow a store. Creates it on first access for this key. */
  acquire(projectRoot: string, opts?: { indexDir?: string | undefined }): TStore {
    const k = this.key(projectRoot, opts?.indexDir);
    let entry = this.stores.get(k);
    if (!entry) {
      const store = this.createStore(projectRoot, { indexDir: opts?.indexDir });
      entry = { store, refs: 0, lastUsed: 0 };
      this.stores.set(k, entry);
      this.keyByStore.set(store as object, k);
    }
    entry.refs++;
    entry.lastUsed = ++this.clock;
    return entry.store;
  }

  /**
   * Return the store to the pool. The connection stays warm for reuse, but the
   * pool may now close the least-recently-used *idle* connection to stay within
   * {@link maxWarmStores}. A store with outstanding refs is never closed.
   */
  release(store: TStore): void {
    const k = this.keyByStore.get(store as object);
    const entry = k === undefined ? undefined : this.stores.get(k);
    if (entry && entry.refs > 0) entry.refs--;
    this.trim();
  }

  private trim(): void {
    if (this.stores.size <= this.maxWarmStores) return;
    const idle = [...this.stores.entries()]
      .filter(([, entry]) => entry.refs === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let overflow = this.stores.size - this.maxWarmStores;
    for (const [k, entry] of idle) {
      if (overflow <= 0) break;
      try {
        entry.store.close();
      } catch {
        /* already closed */
      }
      this.stores.delete(k);
      overflow--;
    }
  }

  /** Close every pooled connection and drain the pool. Call on shutdown. */
  closeAll(): void {
    for (const entry of this.stores.values()) {
      try {
        entry.store.close();
      } catch {
        /* already closed */
      }
    }
    this.stores.clear();
  }

  /** Remove one store from the pool. Used by tests that need isolation. */
  evict(projectRoot: string, indexDir?: string): void {
    const k = this.key(projectRoot, indexDir);
    const entry = this.stores.get(k);
    if (entry) {
      try {
        entry.store.close();
      } catch {
        /* already closed */
      }
      this.stores.delete(k);
    }
  }

  /** True when the pool holds a connection for the given key. */
  has(projectRoot: string, indexDir?: string): boolean {
    return this.stores.has(this.key(projectRoot, indexDir));
  }

  /** Number of warm connections currently held. */
  get size(): number {
    return this.stores.size;
  }
}
