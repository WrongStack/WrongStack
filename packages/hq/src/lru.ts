/**
 * W3 #17 (RFC hq-improvements-2026-09.md): bounded LRU for tracked agents.
 *
 * A generic, allocation-bounded LRU map used by the HQ session bridge to
 * cap the working set of `TrackedAgentSnapshot` references. The motivation
 * is a regression surfaced by the SAGE memory:
 *
 *   "`startSessionTelemetryBridge()` in `packages/hq/src/session-bridge.ts`
 *    allocates `Buffer.allocUnsafe(stat.size - offset)` and reads the
 *    entire outstanding JSONL delta in one operation. A 64 MiB synthetic
 *    delta caused a 64 MiB external-memory increase in the evidence run;
 *    cap each read/chunk to bound burst memory while preserving byte-offset
 *    tailing."
 *
 * The LRU is the structural fix for that regression on the agent-tracking
 * side: by capping the working set per `(clientId, sessionId)`, we bound
 * the memory footprint of the snapshot bridge itself.
 *
 * Design constraints (mirrors the RFC + SAGE):
 *
 *   - O(1) get/set/evict via a `Map` insertion-order traversal (Map iteration
 *     is guaranteed in insertion order by the JS spec, so we don't need a
 *     doubly-linked list).
 *   - Generic key/value; the session bridge scopes its LRU per
 *     `(clientId, sessionId)` so eviction is local and predictable.
 *   - **CRITICAL INVARIANT** (from RFC): the LRU bounds the WORKING SET,
 *     not the FRESHNESS FLOOR. Session-bridge's 4-min keepalive must stay
 *     below HQ's 5-min stale-eviction window. The LRU's `evictIfStale()`
 *     method only evicts entries whose `lastTouchedAt + freshnessFloorMs
 *     < now` — so the freshness floor is honored even if access recency
 *     would otherwise evict.
 *   - Best-effort: the LRU never throws on bounds violation. `set()` past
 *     the cap evicts the oldest eligible entry; if no eligible entry
 *     exists (all are within the freshness floor), the new entry is
 *     refused and `set()` returns false so the caller can log it.
 *
 * @module hq/lru
 */

export interface LruMapOptions {
  /** Hard cap on entries. `set()` past this evicts the oldest eligible entry. */
  maxEntries: number;
  /**
   * Minimum age (ms) before an entry is eligible for eviction. Entries
   * younger than `freshnessFloorMs` are protected regardless of access
   * recency. This is the load-bearing invariant for W3 #17: session-
   * bridge's 4-min keepalive < HQ's 5-min stale-eviction window.
   *
   * Default 0 (no freshness floor). Set to e.g. `5 * 60_000` to enforce
   * the HQ stale-eviction window.
   */
  freshnessFloorMs?: number | undefined;
  /**
   * If false, `get()` does NOT touch the entry (does not move it to
   * the most-recently-used position). Use for read-through caches
   * where reads should not refresh eviction eligibility. Default true.
   */
  touchOnGet?: boolean | undefined;
  /** Optional clock for tests. Default `Date.now`. */
  now?: (() => number) | undefined;
}

interface LruEntry<V> {
  value: V;
  /** Epoch ms of the last `set()` or `touch()`. */
  lastTouchedAt: number;
}

export class LruMap<K, V> {
  private readonly entries = new Map<K, LruEntry<V>>();
  private readonly maxEntries: number;
  private readonly freshnessFloorMs: number;
  private readonly touchOnGet: boolean;
  private readonly now: () => number;

  constructor(opts: LruMapOptions) {
    if (!Number.isFinite(opts.maxEntries) || opts.maxEntries < 1) {
      throw new Error(`LruMap: maxEntries must be a positive integer; got ${opts.maxEntries}`);
    }
    this.maxEntries = opts.maxEntries;
    this.freshnessFloorMs = opts.freshnessFloorMs ?? 0;
    this.touchOnGet = opts.touchOnGet ?? true;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get capacity(): number {
    return this.maxEntries;
  }

  /**
   * Insert or update a key. If the key is new and the map is at capacity,
   * evicts the oldest eligible entry (oldest by `lastTouchedAt` that is
   * past the freshness floor). Returns `false` when eviction was refused
   * because no eligible entry exists; `true` otherwise (including when
   * the key was already present).
   */
  set(key: K, value: V): boolean {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.value = value;
      existing.lastTouchedAt = now;
      this.entries.delete(key);
      this.entries.set(key, existing);
      return true;
    }
    if (this.entries.size >= this.maxEntries) {
      const evicted = this.evictOldestEligible(now);
      if (!evicted) {
        return false;
      }
    }
    this.entries.set(key, { value, lastTouchedAt: now });
    return true;
  }

  /** Read a key without touching (does not move to most-recently-used). */
  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  /**
   * Read a key and touch it (moves to most-recently-used when
   * `touchOnGet: true`). Returns `undefined` if the key is absent.
   */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.touchOnGet) {
      this.touch(key);
    }
    return entry.value;
  }

  /**
   * Refresh an entry's recency without changing its value, and move it
   * to the most-recently-used position. Returns false if absent.
   *
   * Implementation note: Map iteration is insertion order. To move an
   * entry to the MRU end, we delete + re-insert. Without the re-insert,
   * a touched entry would still sit at its original position and
   * `evictOldestEligible` (which iterates in insertion order) would
   * evict the wrong entry.
   */
  touch(key: K): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    entry.lastTouchedAt = this.now();
    // Re-insert to move to MRU end. Map preserves insertion order, so
    // delete + set is the canonical way to refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return true;
  }

  /** Remove a key. Returns true if it was present. */
  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Drop every entry whose age exceeds the freshness floor. Returns count evicted. */
  evictIfStale(now: number = this.now()): number {
    if (this.freshnessFloorMs <= 0) return 0;
    const cutoff = now - this.freshnessFloorMs;
    let evicted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.lastTouchedAt < cutoff) {
        this.entries.delete(key);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Snapshot of current keys, oldest-first. */
  keys(): K[] {
    return [...this.entries.keys()];
  }

  /** Snapshot of current values, oldest-first. */
  values(): V[] {
    return [...this.entries.values()].map((e) => e.value);
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
  }

  private evictOldestEligible(now: number): boolean {
    if (this.freshnessFloorMs <= 0) {
      const first = this.entries.keys().next();
      if (first.done) return false;
      this.entries.delete(first.value);
      return true;
    }
    const cutoff = now - this.freshnessFloorMs;
    let oldestKey: K | undefined;
    let oldestTouched = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastTouchedAt < cutoff && entry.lastTouchedAt < oldestTouched) {
        oldestTouched = entry.lastTouchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) return false;
    this.entries.delete(oldestKey);
    return true;
  }
}
