import { describe, expect, it } from 'vitest';
import { GenerationLruCache } from '../src/project-server-cache.js';

describe('GenerationLruCache maxEntries bounds', () => {
  it('normalizes non-finite and non-positive maxEntries so eviction stays bounded', () => {
    const nanCache = new GenerationLruCache<number>(Number.NaN);
    for (let i = 0; i < 200; i++) nanCache.set(`k${i}`, 1, i);
    expect(nanCache.size).toBe(128);

    const zeroCache = new GenerationLruCache<number>(0);
    zeroCache.set('a', 1, 1);
    zeroCache.set('b', 1, 2);
    expect(zeroCache.size).toBe(1);
    expect(zeroCache.get('b', 1)).toBe(2);
  });
});
