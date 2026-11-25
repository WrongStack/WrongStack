import { describe, expect, it } from 'vitest';
import { GenerationLruCache } from '../src/project-server-cache.js';

describe('GenerationLruCache.peekEntry isolation (F2255)', () => {
  it('returns a cloned wrapper so caller mutations cannot corrupt internal generation', () => {
    const cache = new GenerationLruCache<string>(4);
    cache.set('k1', 1, 'v1');
    const peeked = cache.peekEntry('k1');
    if (peeked) peeked.generation = 999;
    expect(cache.get('k1', 999)).toBeUndefined();
    expect(cache.get('k1', 1)).toBe('v1');
  });
});
