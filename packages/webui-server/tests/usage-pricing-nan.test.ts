import { describe, expect, it } from 'vitest';
import { usagePricing } from '../src/server/usage-pricing.js';

describe('usagePricing non-finite cacheWrite5m guard', () => {
  it('sanitizes NaN cacheWrite5m instead of producing NaN estimateUsd', () => {
    const model = { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } };
    const res = usagePricing(
      { input: 100, output: 100, cacheWrite: 100, cacheWrite5m: Number.NaN, cacheWrite1h: 50 },
      model,
    );
    expect(res.estimateUsd).not.toBeNull();
    expect(Number.isFinite(res.estimateUsd)).toBe(true);
  });
});
