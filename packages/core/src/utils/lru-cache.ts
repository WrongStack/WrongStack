/**
 * Minimal LRU (Least Recently Used) cache.
 *
 * Uses the insertion-order property of `Map` (oldest entry is the first
 * iterator) to evict the least-recently-used entry when the capacity is
 * reached. Reads and writes re-insert the entry so it becomes the newest,
 * matching LRU semantics.
 *
 * Designed for the permission-policy eval cache (P3 #17, before-release.md):
 * a plain `Map` with no eviction could grow without bound on an iteration
 * that evaluates thousands of unique tool+subject combinations. This wrapper
 * caps the size at a configurable maximum while preserving the `get`/`set`/
 * `clear`/`has` API the policy already uses.
 *
 * Intentionally dependency-free and small (~30 lines) — not a general-purpose
 * LRU. If richer semantics are needed (TTL, size tracking, weighted entries),
 * bring a dedicated library.
 */
export class LruCache<K, V> {
  private readonly store = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error(`LruCache capacity must be >= 1, got ${capacity}`);
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined && !this.store.has(key)) return undefined;
    // Re-insert so this key becomes the most-recently-used (moves to end).
    this.store.delete(key);
    this.store.set(key, value as V);
    return value;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    // Evict the oldest (least-recently-used) entry while over capacity.
    while (this.store.size > this.capacity) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
