import { describe, expect, it } from 'vitest';
import { getCostRates } from '../src/server/usage-cost.js';

describe('getCostRates non-finite contextTokens guard', () => {
  it('ignores Infinity and NaN contextTokens instead of selecting high-cost tier', () => {
    const model = { cost: { input: 3, output: 15, context_over_200k: { input: 6, output: 30 } } };
    expect(getCostRates(model, Number.POSITIVE_INFINITY).input).toBe(3);
    expect(getCostRates(model, Number.NaN).input).toBe(3);
    expect(getCostRates(model, 250_000).input).toBe(6);
  });
});
