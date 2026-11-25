import { describe, expect, it } from 'vitest';
import { EntryHeightCache } from '../src/height-cache.js';

describe('EntryHeightCache.sync non-finite estimatedHeight', () => {
  it('falls back to default entry height when estimatedHeight is NaN or Infinity', () => {
    const nanCache = new EntryHeightCache();
    nanCache.sync([1, 2], Number.NaN);
    expect(nanCache.totalHeight()).toBe(6);

    const infCache = new EntryHeightCache();
    infCache.sync([1, 2], Number.POSITIVE_INFINITY);
    expect(infCache.totalHeight()).toBe(6);
  });
});
