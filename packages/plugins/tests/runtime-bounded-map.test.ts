/**
 * @wrongstack/plugins — BoundedMap tests.
 *
 * BoundedMap replaces the module-scope `Map` caches that several plugins
 * kept for the whole process lifetime (branch lookups, per-path diff
 * memos, linter detection, per-file test hashes, model-id normalisation).
 * Those grew one entry per distinct key seen and were released only at
 * teardown. These tests pin the two properties that make the replacement
 * safe: the cap really is a cap, and eviction drops the coldest entry
 * rather than the hottest.
 */
import { describe, expect, it } from 'vitest';
import { BoundedMap } from '../src/runtime/index.js';

describe('BoundedMap — capacity', () => {
  it('never exceeds max, however many keys are written', () => {
    const m = new BoundedMap<number, number>({ max: 10 });
    for (let i = 0; i < 1_000; i++) m.set(i, i);
    expect(m.size).toBe(10);
  });

  it('counts what it dropped', () => {
    const m = new BoundedMap<number, number>({ max: 3 });
    for (let i = 0; i < 10; i++) m.set(i, i);
    expect(m.evictionCount).toBe(7);
  });

  it('treats max below 1 as 1 rather than as "unbounded"', () => {
    const m = new BoundedMap<string, string>({ max: 0 });
    m.set('a', '1');
    m.set('b', '2');
    expect(m.size).toBe(1);
    expect(m.get('b')).toBe('2');
  });

  it('overwriting a key does not grow the map', () => {
    const m = new BoundedMap<string, number>({ max: 5 });
    for (let i = 0; i < 100; i++) m.set('same', i);
    expect(m.size).toBe(1);
    expect(m.get('same')).toBe(99);
  });
});

describe('BoundedMap — eviction order', () => {
  it('evicts the least recently used, not the oldest inserted', () => {
    const m = new BoundedMap<string, number>({ max: 3 });
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    // Touch 'a' so it is no longer the coldest.
    expect(m.get('a')).toBe(1);
    m.set('d', 4);
    // 'b' was the coldest and must be the one dropped.
    expect(m.has('b')).toBe(false);
    expect(m.get('a')).toBe(1);
    expect(m.get('c')).toBe(3);
    expect(m.get('d')).toBe(4);
  });

  it('peek reads without changing eviction order', () => {
    const m = new BoundedMap<string, number>({ max: 2 });
    m.set('a', 1);
    m.set('b', 2);
    expect(m.peek('a')).toBe(1); // must NOT promote 'a'
    m.set('c', 3);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
  });
});

describe('BoundedMap — TTL', () => {
  it('treats an expired entry as absent', () => {
    let clock = 1_000;
    const m = new BoundedMap<string, string>({ max: 10, ttlMs: 100, now: () => clock });
    m.set('k', 'v');
    expect(m.get('k')).toBe('v');
    clock += 101;
    expect(m.get('k')).toBeUndefined();
    expect(m.has('k')).toBe(false);
  });

  it('drops the expired entry on access rather than retaining it', () => {
    let clock = 0;
    const m = new BoundedMap<string, string>({ max: 10, ttlMs: 50, now: () => clock });
    m.set('k', 'v');
    clock = 100;
    m.get('k');
    expect(m.size).toBe(0);
  });

  it('prune clears every expired entry at once', () => {
    let clock = 0;
    const m = new BoundedMap<number, number>({ max: 100, ttlMs: 10, now: () => clock });
    for (let i = 0; i < 20; i++) m.set(i, i);
    clock = 50;
    expect(m.prune()).toBe(20);
    expect(m.size).toBe(0);
  });

  it('prune is a no-op without a configured TTL', () => {
    const m = new BoundedMap<number, number>({ max: 5 });
    m.set(1, 1);
    expect(m.prune()).toBe(0);
    expect(m.size).toBe(1);
  });

  it('a refreshed key restarts its lifetime', () => {
    let clock = 0;
    const m = new BoundedMap<string, string>({ max: 10, ttlMs: 100, now: () => clock });
    m.set('k', 'v1');
    clock = 80;
    m.set('k', 'v2');
    clock = 150; // 70ms after the refresh — still live
    expect(m.get('k')).toBe('v2');
  });
});

describe('BoundedMap — Map-compatible surface', () => {
  it('supports the operations the replaced Maps relied on', () => {
    const m = new BoundedMap<string, number>({ max: 10 });
    m.set('a', 1).set('b', 2);
    expect(m.size).toBe(2);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.evictionCount).toBe(0);
  });

  it('iterates live entries, skipping expired ones', () => {
    let clock = 0;
    const m = new BoundedMap<string, number>({ max: 10, ttlMs: 100, now: () => clock });
    m.set('old', 1);
    clock = 200;
    m.set('new', 2);
    expect([...m]).toEqual([['new', 2]]);
  });
});
