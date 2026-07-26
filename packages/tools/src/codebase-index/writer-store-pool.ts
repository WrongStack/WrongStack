interface PooledIndexStore {
  close(): void;
}

type StoreFactory<TStore extends PooledIndexStore> = (
  projectRoot: string,
  opts?: { indexDir?: string | undefined },
) => TStore;

/**
 * Warm-connection pool for IndexStore instances.
 *
 * Each (projectRoot, indexDir) pair gets one persisted store. Every read
 * operation (search, stats, graph) acquires the store from the pool instead of
 * opening a fresh SQLite connection, re-parsing the schema, and re-preparing
 * statements. The connection stays warm between calls.
 */
export class StorePool<TStore extends PooledIndexStore> {
  private readonly stores = new Map<string, TStore>();

  constructor(private readonly createStore: StoreFactory<TStore>) {}

  private key(projectRoot: string, indexDir?: string): string {
    return `${projectRoot}\u0000${indexDir ?? ''}`;
  }

  /** Borrow a store. Creates it on first access for this key. */
  acquire(projectRoot: string, opts?: { indexDir?: string | undefined }): TStore {
    const k = this.key(projectRoot, opts?.indexDir);
    let store = this.stores.get(k);
    if (!store) {
      store = this.createStore(projectRoot, { indexDir: opts?.indexDir });
      this.stores.set(k, store);
    }
    return store;
  }

  /** Return the store to the pool. The connection stays warm for reuse. */
  release(_store: TStore): void {
    // No-op. Connections close via closeAll() or evict().
  }

  /** Close every pooled connection and drain the pool. Call on shutdown. */
  closeAll(): void {
    for (const store of this.stores.values()) {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    }
    this.stores.clear();
  }

  /** Remove one store from the pool. Used by tests that need isolation. */
  evict(projectRoot: string, indexDir?: string): void {
    const k = this.key(projectRoot, indexDir);
    const store = this.stores.get(k);
    if (store) {
      try {
        store.close();
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
}
