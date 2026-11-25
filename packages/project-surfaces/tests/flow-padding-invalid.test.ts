import { describe, expect, it } from 'vitest';
import { fitPadding } from '../src/flow-padding.js';

describe('fitPadding invalid fraction inputs (F1884)', () => {
  it('returns 0% for non-finite, zero, and negative fractions', () => {
    for (const bad of [
      -1,
      -0.5,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(fitPadding(bad)).toBe('0%');
    }
    expect(fitPadding(0.25)).toBe('10%');
  });
});
