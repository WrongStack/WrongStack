import { describe, expect, it } from 'vitest';
import { distribution } from '../src/story/session-model-stats';

describe('session-model-stats distribution non-finite filtering (F1844)', () => {
  it('ignores NaN and Infinity samples so summary metrics remain finite', () => {
    const res = distribution([
      10,
      Number.NaN,
      30,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
    expect(res.n).toBe(2);
    expect(res.avg).toBe(20);
    expect(res.max).toBe(30);
    expect(res.total).toBe(40);
  });
});
