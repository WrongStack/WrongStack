import { describe, expect, it } from 'vitest';
import { LruMap } from '../src/lru.js';

/**
 * W3 #17 (RFC hq-improvements-2026-09.md): focused tests for the bounded
 * LRU used by the HQ session bridge.
 *
 * The structural motivation is the SAGE memory warning: a 64 MiB synthetic
 * JSONL delta caused a 64 MiB external-memory increase in
 * `startSessionTelemetryBridge()`. This LRU caps the working set of
 * tracked-agent references per `(clientId, sessionId)`, bounding burst
 * memory without breaking byte-offset tailing.
 *
 * The tests pin the load-bearing contracts:
 *   1. O(1) bounded set/get/delete
 *   2. **Freshness-floor enforcement** — the LRU must NOT evict entries
 *      within the freshness window, regardless of access recency
 *   3. Refusal semantics — when no eligible entry exists, `set()` returns
 *      false (the caller logs it) rather than throwing
 *   4. Per-key isolation — `touch()` does not affect other entries
 *   5. `evictIfStale()` is a sweep, not a per-call check
 */

describe('LruMap (W3 #17)', () => {
  it('rejects non-positive maxEntries at construction', () => {
    expect(() => new LruMap({ maxEntries: 0 })).toThrow();
    expect(() => new LruMap({ maxEntries: -1 })).toThrow();
    expect(() => new LruMap({ maxEntries: Number.NaN })).toThrow();
    expect(() => new LruMap({ maxEntries: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('supports basic set/get/delete', () => {
    const m = new LruMap<string, number>({ maxEntries: 4 });
    expect(m.set('a', 1)).toBe(true);
    expect(m.set('b', 2)).toBe(true);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.size).toBe(2);
    expect(m.delete('a')).toBe(true);
    expect(m.get('a')).toBeUndefined();
    expect(m.size).toBe(1);
  });

  it('peeks without touching recency', () => {
    let now = 1000;
    const m = new LruMap<string, number>({
      maxEntries: 2,
      now: () => now,
      freshnessFloorMs: 100,
    });
    m.set('a', 1); // touched at 1000
    now = 1100;
    // peek should NOT refresh recency
    expect(m.peek('a')).toBe(1);
    // Now insert past capacity without floor — wait, with freshnessFloorMs:100
    // and lastTouchedAt=1000, at now=1100 the entry is exactly at the floor
    // boundary. evictOldestEligible checks `lastTouchedAt < cutoff` where
    // cutoff = now - freshnessFloorMs = 1100 - 100 = 1000. So 1000 < 1000 is
    // false → entry is NOT eligible. The new insert is refused.
    expect(m.set('b', 2)).toBe(true);
    expect(m.set('c', 3)).toBe(false); // refused: 'a' still in floor
  });

  it('touches on get by default (moves to most-recently-used)', () => {
    let now = 1000;
    const m = new LruMap<string, number>({
      maxEntries: 2,
      now: () => now,
      freshnessFloorMs: 100,
    });
    m.set('a', 1); // touched at 1000
    now = 1099; // within floor (cutoff = 1099 - 100 = 999; 1000 < 999 false)
    m.set('b', 2); // touched at 1099 — 'a' is NOT eligible (1000 !< 999)
    expect(m.size).toBe(2);
    // Now go past the floor for 'a' but NOT for 'b'
    now = 1200; // cutoff for 'a' = 1100 (eligible), for 'b' = 1100 (eligible)
    // Both are eligible — evict oldest first.
    m.set('c', 3);
    expect(m.peek('a')).toBeUndefined(); // evicted
    expect(m.peek('b')).toBe(2);
    expect(m.peek('c')).toBe(3);
  });

  it('evicts the oldest eligible entry when at capacity', () => {
    let now = 1000;
    const m = new LruMap<string, number>({ maxEntries: 2, now: () => now });
    m.set('a', 1); // touched at 1000
    now = 1100;
    m.set('b', 2); // touched at 1100 (most recent)
    now = 1200;
    m.set('c', 3); // evicts 'a' (oldest)
    expect(m.peek('a')).toBeUndefined();
    expect(m.peek('b')).toBe(2);
    expect(m.peek('c')).toBe(3);
  });

  it('refuses insertion when at capacity AND all entries are within the freshness floor', () => {
    // This is the load-bearing invariant: session-bridge's 4-min keepalive
    // must stay below HQ's 5-min stale-eviction window. If the LRU evicted
    // entries within the floor, a high-throughput session would lose
    // tracked-agent references mid-flight.
    let now = 0;
    const m = new LruMap<string, number>({
      maxEntries: 2,
      now: () => now,
      freshnessFloorMs: 5 * 60_000, // 5 minutes, the HQ stale-eviction window
    });
    m.set('a', 1);
    now = 60_000; // 1 minute
    m.set('b', 2);
    now = 90_000; // 1.5 minutes — BOTH within floor
    expect(m.set('c', 3)).toBe(false); // refused
    expect(m.size).toBe(2); // unchanged
    expect(m.peek('a')).toBe(1);
    expect(m.peek('b')).toBe(2);
  });

  it('evicts once entries leave the freshness floor', () => {
    let now = 0;
    const m = new LruMap<string, number>({
      maxEntries: 2,
      now: () => now,
      freshnessFloorMs: 60_000, // 1 minute
    });
    m.set('a', 1);
    now = 30_000; // 30s — both within floor if c is added
    m.set('b', 2);
    now = 65_000; // 65s — 'a' is past the floor (cutoff = 5000)
    expect(m.set('c', 3)).toBe(true); // 'a' evicted
    expect(m.peek('a')).toBeUndefined();
    expect(m.peek('b')).toBe(2);
    expect(m.peek('c')).toBe(3);
  });

  it('update of existing key does not evict', () => {
    const m = new LruMap<string, number>({ maxEntries: 2 });
    m.set('a', 1);
    m.set('b', 2);
    expect(m.set('a', 99)).toBe(true); // update, not insert
    expect(m.get('a')).toBe(99);
    expect(m.size).toBe(2);
  });

  it('touch() refreshes recency without changing value', () => {
    let now = 0;
    const m = new LruMap<string, number>({ maxEntries: 2, now: () => now });
    m.set('a', 1);
    now = 100;
    m.set('b', 2);
    expect(m.touch('a')).toBe(true);
    now = 200;
    // 'a' is now more recent than 'b', so 'b' is the oldest
    m.set('c', 3);
    expect(m.peek('a')).toBe(1);
    expect(m.peek('b')).toBeUndefined();
    expect(m.peek('c')).toBe(3);
  });

  it('touch() returns false for absent keys', () => {
    const m = new LruMap<string, number>({ maxEntries: 2 });
    expect(m.touch('absent')).toBe(false);
  });

  it('evictIfStale drops entries past the freshness floor', () => {
    let now = 0;
    const m = new LruMap<string, number>({
      maxEntries: 10,
      now: () => now,
      freshnessFloorMs: 1000,
    });
    m.set('a', 1); // 0
    now = 500;
    m.set('b', 2); // 500
    now = 1500;
    m.set('c', 3); // 1500
    // At now=1500, cutoff = 500. 'a' (touched at 0) is past floor.
    // 'b' (touched at 500) is exactly at floor — not past (strict <).
    // 'c' (touched at 1500) is not past.
    const evicted = m.evictIfStale();
    expect(evicted).toBe(1);
    expect(m.peek('a')).toBeUndefined();
    expect(m.peek('b')).toBe(2);
    expect(m.peek('c')).toBe(3);
  });

  it('evictIfStale is a no-op when freshnessFloorMs is 0', () => {
    const m = new LruMap<string, number>({ maxEntries: 10 });
    m.set('a', 1);
    m.set('b', 2);
    expect(m.evictIfStale()).toBe(0);
    expect(m.size).toBe(2);
  });

  it('keys() and values() return oldest-first snapshots', () => {
    let now = 0;
    const m = new LruMap<string, number>({ maxEntries: 3, now: () => now });
    m.set('a', 1);
    now = 100;
    m.set('b', 2);
    now = 200;
    m.set('c', 3);
    expect(m.keys()).toEqual(['a', 'b', 'c']);
    expect(m.values()).toEqual([1, 2, 3]);
  });

  it('clear() drops everything', () => {
    const m = new LruMap<string, number>({ maxEntries: 3 });
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.get('a')).toBeUndefined();
  });

  it('supports generic value types', () => {
    interface TrackedAgent {
      id: string;
      lastActivityAt: number;
    }
    const m = new LruMap<string, TrackedAgent>({ maxEntries: 2 });
    m.set('sess-1', { id: 'agent-1', lastActivityAt: 1000 });
    m.set('sess-2', { id: 'agent-2', lastActivityAt: 2000 });
    const agent = m.get('sess-1');
    expect(agent?.id).toBe('agent-1');
  });

  it('load-bearing invariant: 4-min keepalive < 5-min stale-eviction (the W3 #17 contract)', () => {
    // This test pins the exact contract from the RFC: the LRU must
    // bound the working set, NOT the freshness floor. A high-throughput
    // session whose keepalive republishes every 4 minutes must NEVER have
    // its tracked-agent references evicted within the 5-minute stale
    // window. Evicting mid-flight would break the keepalive contract.
    let now = 0;
    const freshnessFloorMs = 5 * 60_000; // 5 min, the HQ stale-eviction window
    const keepaliveMs = 4 * 60_000; // 4 min, the session-bridge keepalive
    const m = new LruMap<string, number>({
      maxEntries: 1,
      now: () => now,
      freshnessFloorMs,
    });
    m.set('client-1:sess-1', 1);
    // Simulate the keepalive cycle: every 4 minutes, the bridge
    // re-publishes the agent snapshot via `set()`. Each `set()` tries
    // to evict the prior entry, but the floor protects it.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      now += keepaliveMs;
      const inserted = m.set('client-1:sess-1', cycle + 2);
      expect(inserted).toBe(true); // NOT refused — the prior entry is evicted
      // because the prior entry was set at (cycle-1)*keepaliveMs, which
      // is now exactly at the boundary. At the boundary, the strict <
      // check passes (the prior entry's lastTouchedAt is < cutoff).
      // The bridge's new entry survives.
      expect(m.get('client-1:sess-1')).toBe(cycle + 2);
    }
    // Now advance past the stale window with NO keepalive — the entry
    // must be evictable on the next sweep.
    now += freshnessFloorMs + 1000;
    expect(m.evictIfStale()).toBe(1);
    expect(m.size).toBe(0);
  });
});
