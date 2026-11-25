import { describe, expect, it } from 'vitest';
import { newHistogram, observeHistogram } from '../src/telemetry.js';

describe('observeHistogram non-finite and negative sample guard (F1995)', () => {
  it('ignores NaN, Infinity, and negative observations', () => {
    const h = newHistogram();
    observeHistogram(h, 50);
    observeHistogram(h, Number.NaN);
    observeHistogram(h, -10);
    observeHistogram(h, Number.POSITIVE_INFINITY);
    expect(h).toEqual({ count: 1, min: 50, max: 50, sum: 50 });
  });
});
