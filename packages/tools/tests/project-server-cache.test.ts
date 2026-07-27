import { describe, expect, it } from 'vitest';
import { GenerationLruCache } from '../src/codebase-index/project-server-cache.js';

describe('GenerationLruCache', () => {
  it('serves only the active generation', () => {
    const cache = new GenerationLruCache<object>(2);
    const value = {};
    cache.set('search', 3, value);

    expect(cache.get('search', 3)).toBe(value);
    expect(cache.get('search', 4)).toBeUndefined();
  });

  it('evicts the least recently used entry and clears explicitly', () => {
    const cache = new GenerationLruCache<number>(2);
    cache.set('a', 1, 1);
    cache.set('b', 1, 2);
    expect(cache.get('a', 1)).toBe(1);
    cache.set('c', 1, 3);

    expect(cache.get('b', 1)).toBeUndefined();
    expect(cache.get('a', 1)).toBe(1);
    expect(cache.get('c', 1)).toBe(3);
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
