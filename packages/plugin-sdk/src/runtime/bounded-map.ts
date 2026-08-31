/**
 * @wrongstack/plugins — bounded key/value cache.
 *
 * Several plugins memoise per-path or per-model work in a module-scope
 * `Map` that is only ever cleared at teardown. In a short test that is
 * invisible; in a long session over a large repository it is a slow leak —
 * one entry per file touched, per branch resolved, per model seen — held
 * for the lifetime of the process.
 *
 * `BoundedMap` is a drop-in replacement for those maps: same `get`/`set`/
 * `delete`/`clear`/`size` surface, plus a hard entry cap with
 * least-recently-used eviction and an optional per-entry TTL. Nothing
 * about the call sites has to change beyond the constructor.
 *
 * Why LRU rather than insertion-order eviction: the access pattern for
 * these caches is "a few hot paths, a long tail of cold ones". Evicting by
 * insertion order throws away the hot entries first, which is exactly
 * backwards; re-reading a hot entry should keep it.
 */

export interface BoundedMapOptions {
  /** Hard cap on retained entries. Must be a safe integer >= 1. */
  max: number;
  /**
   * Optional per-entry lifetime in ms. An entry older than this is treated
   * as absent by `get`/`has` and dropped on access. Omit for no expiry.
   */
  ttlMs?: number | undefined;
  /** Clock injection point — tests override this instead of faking timers. */
  now?: (() => number) | undefined;
}

interface Entry<V> {
  value: V;
  storedAt: number;
}

export class BoundedMap<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly max: number;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;
  /** Entries dropped to stay under `max`. Surfaced by plugin health(). */
  private evictions = 0;

  constructor(options: BoundedMapOptions) {
    const normalizedMax = Math.floor(options.max);
    this.max = Number.isSafeInteger(normalizedMax) ? Math.max(1, normalizedMax) : 1;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  private expired(entry: Entry<V>): boolean {
    return this.ttlMs !== undefined && this.now() - entry.storedAt > this.ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.expired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to mark most-recently-used: Map iterates in insertion
    // order, so deleting and re-adding moves the key to the back and the
    // eviction loop (which takes from the front) sees the coldest key.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Read without promoting the key to most-recently-used. Use for
   * diagnostics that must not perturb the eviction order.
   */
  peek(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined || this.expired(entry)) return undefined;
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.expired(entry)) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key: K, value: V): this {
    // Delete first so an overwrite also refreshes recency.
    this.map.delete(key);
    this.map.set(key, { value, storedAt: this.now() });
    if (this.map.size > this.max && this.ttlMs !== undefined) {
      this.prune();
    }
    while (this.map.size > this.max) {
      const coldest = this.map.keys().next().value as K | undefined;
      if (coldest === undefined) break;
      this.map.delete(coldest);
      this.evictions += 1;
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.evictions = 0;
  }

  get size(): number {
    if (this.ttlMs !== undefined) {
      this.prune();
    }
    return this.map.size;
  }

  /** How many entries have been dropped to respect `max`, since the last clear. */
  get evictionCount(): number {
    return this.evictions;
  }

  /** Drop every expired entry. Cheap enough to call from a status tool. */
  prune(): number {
    if (this.ttlMs === undefined) return 0;
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (this.expired(entry)) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Live (non-expired) entries, coldest first. */
  *entries(): IterableIterator<[K, V]> {
    for (const [key, entry] of this.map) {
      if (!this.expired(entry)) yield [key, entry.value];
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }
}

/**
 * A `Set` with the same hard cap and LRU eviction as {@link BoundedMap}.
 *
 * Plugins use module-scope sets to remember "already reported" keys so a
 * finding is surfaced once rather than on every scan. That set has to
 * outlive a single scan, which is why it lives at module scope — but
 * without a bound it grows one entry per distinct finding for the life of
 * the process.
 *
 * Eviction means a very old key may eventually be reported a second time.
 * That is the right trade: re-reporting a finding the user last saw
 * thousands of findings ago is reasonable behaviour, whereas unbounded
 * growth is not.
 */
export class BoundedSet<T> {
  private readonly inner: BoundedMap<T, true>;

  constructor(options: BoundedMapOptions) {
    this.inner = new BoundedMap<T, true>(options);
  }

  has(value: T): boolean {
    return this.inner.has(value);
  }

  add(value: T): this {
    this.inner.set(value, true);
    return this;
  }

  delete(value: T): boolean {
    return this.inner.delete(value);
  }

  clear(): void {
    this.inner.clear();
  }

  get size(): number {
    return this.inner.size;
  }

  /** How many entries have been dropped to respect `max`, since the last clear. */
  get evictionCount(): number {
    return this.inner.evictionCount;
  }

  *values(): IterableIterator<T> {
    for (const [key] of this.inner) yield key;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }
}
