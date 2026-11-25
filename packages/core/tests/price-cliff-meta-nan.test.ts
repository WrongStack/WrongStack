import { describe, expect, it } from 'vitest';
import { readPriceCliffMeta } from '../src/utils/price-cliff.js';

describe('readPriceCliffMeta non-finite field guard (F2008)', () => {
  it('omits non-finite multiplier, baseRate, and cliffRate fields', () => {
    const res = readPriceCliffMeta({
      cliffTokens: 200_000,
      multiplier: Number.NaN,
      baseRate: Number.POSITIVE_INFINITY,
      cliffRate: Number.NaN,
    });
    expect(res).toEqual({ cliffTokens: 200_000 });
  });
});
