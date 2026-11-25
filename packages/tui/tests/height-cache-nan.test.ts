import { describe, expect, it } from 'vitest';
import { computeWindow, EntryHeightCache } from '../src/height-cache.js';

describe('computeWindow non-finite scrollOffset guard (F1991)', () => {
  it('keeps spacerAbove and spacerBelow finite when scrollOffset is NaN', () => {
    const cache = new EntryHeightCache();
    cache.sync([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    const res = computeWindow(50, 10, Number.NaN, 10, cache);
    expect(Number.isFinite(res.spacerAbove)).toBe(true);
    expect(Number.isFinite(res.spacerBelow)).toBe(true);
  });
});
