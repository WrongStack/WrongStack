import { describe, expect, it } from 'vitest';
import { LruMap } from '../lru.js';

describe('LruMap recency at capacity', () => {
  it('evicts the oldest insertion if no entry was accessed', () => {
    const cache = new LruMap<string, number>({ maxEntries: 2 });
    cache.set('first', 1);
    cache.set('second', 2);
    cache.set('third', 3);
    expect(cache.keys()).toEqual(['second', 'third']);
  });

  it('keeps a recently read entry and evicts the actual least recently used entry', () => {
    const cache = new LruMap<string, number>({ maxEntries: 2 });
    cache.set('first', 1);
    cache.set('second', 2);
    expect(cache.get('first')).toBe(1);
    cache.set('third', 3);
    expect(cache.keys()).toEqual(['first', 'third']);
  });

  it('keeps a recently updated entry rather than evicting it', () => {
    const cache = new LruMap<string, number>({ maxEntries: 2 });
    cache.set('first', 1);
    cache.set('second', 2);
    cache.set('first', 10);
    cache.set('third', 3);
    expect(cache.keys()).toEqual(['first', 'third']);
    expect(cache.peek('first')).toBe(10);
  });

  it('does not refresh read recency when touchOnGet is disabled', () => {
    const cache = new LruMap<string, number>({ maxEntries: 2, touchOnGet: false });
    cache.set('first', 1);
    cache.set('second', 2);
    expect(cache.get('first')).toBe(1);
    cache.set('third', 3);
    expect(cache.keys()).toEqual(['second', 'third']);
  });
});
