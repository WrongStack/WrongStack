import { describe, it, expect } from 'vitest';
import { getCostRates, computeUsageCost } from '../src/server/usage-cost.js';

describe('getCostRates', () => {
  it('extracts input, output, and cacheRead from a complete model object', () => {
    const model = {
      cost: { input: 2.5, output: 10.0, cache_read: 1.0 },
    };
    const rates = getCostRates(model);
    expect(rates).toEqual({ input: 2.5, output: 10.0, cacheRead: 1.0 });
  });

  it('returns 0 for all fields when model is null', () => {
    expect(getCostRates(null)).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('returns 0 for all fields when model is undefined', () => {
    expect(getCostRates(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('returns 0 for all fields when model has no cost property', () => {
    expect(getCostRates({})).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('returns 0 for missing fields inside cost', () => {
    const model = { cost: {} };
    expect(getCostRates(model)).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('returns 0 for partial cost with only input', () => {
    const model = { cost: { input: 1.5 } };
    expect(getCostRates(model)).toEqual({ input: 1.5, output: 0, cacheRead: 0 });
  });

  it('handles cost with only output and cache_read', () => {
    const model = { cost: { output: 5.0, cache_read: 0.5 } };
    expect(getCostRates(model)).toEqual({ input: 0, output: 5.0, cacheRead: 0.5 });
  });

  it('ignores extra fields on model that are not cost', () => {
    const model = {
      name: 'gpt-4',
      cost: { input: 3.0, output: 15.0, cache_read: 1.5 },
      extra: true,
    };
    expect(getCostRates(model)).toEqual({ input: 3.0, output: 15.0, cacheRead: 1.5 });
  });
});

describe('computeUsageCost', () => {
  it('computes dollar cost from token usage and rates', () => {
    const usage = { input: 1_000_000, output: 500_000, cacheRead: 200_000 };
    const rates = { input: 2.0, output: 10.0, cacheRead: 1.0 };
    // (1M * 2 + 500K * 10 + 200K * 1) / 1M = (2,000,000 + 5,000,000 + 200,000) / 1,000,000 = 7.2
    expect(computeUsageCost(usage, rates)).toBeCloseTo(7.2);
  });

  it('returns 0 when all rates are 0', () => {
    const usage = { input: 1_000_000, output: 500_000, cacheRead: 200_000 };
    const rates = { input: 0, output: 0, cacheRead: 0 };
    expect(computeUsageCost(usage, rates)).toBe(0);
  });

  it('returns 0 when usage is 0', () => {
    const usage = { input: 0, output: 0, cacheRead: 0 };
    const rates = { input: 2.0, output: 10.0, cacheRead: 1.0 };
    expect(computeUsageCost(usage, rates)).toBe(0);
  });

  it('handles missing cacheRead in usage (undefined)', () => {
    const usage = { input: 100_000, output: 50_000, cacheRead: undefined };
    const rates = { input: 2.0, output: 10.0, cacheRead: 1.0 };
    // (100K * 2 + 50K * 10 + 0 * 1) / 1M = (200,000 + 500,000) / 1,000,000 = 0.7
    expect(computeUsageCost(usage, rates)).toBeCloseTo(0.7);
  });

  it('handles missing cacheRead field entirely', () => {
    const usage = { input: 100_000, output: 50_000 };
    const rates = { input: 2.0, output: 10.0, cacheRead: 1.0 };
    expect(computeUsageCost(usage as any, rates)).toBeCloseTo(0.7);
  });

  it('handles fractional token counts', () => {
    const usage = { input: 100, output: 50, cacheRead: 10 };
    const rates = { input: 1.0, output: 2.0, cacheRead: 0.5 };
    // (100 * 1 + 50 * 2 + 10 * 0.5) / 1M = (100 + 100 + 5) / 1,000,000 = 0.000205
    expect(computeUsageCost(usage, rates)).toBeCloseTo(0.000205);
  });

  it('handles very large numbers without overflow', () => {
    const usage = { input: 100_000_000, output: 50_000_000, cacheRead: 10_000_000 };
    const rates = { input: 100.0, output: 500.0, cacheRead: 50.0 };
    // (100M * 100 + 50M * 500 + 10M * 50) / 1M = (10B + 25B + 500M) / 1M = 35500
    expect(computeUsageCost(usage, rates)).toBe(35500);
  });

  // B-07: migrated from packages/webui/tests/server/usage-cost.test.ts — the
  // all-cacheRead scenario. The server suite exercises partial-cacheRead in
  // the presence of input/output tokens, but never the pure cache-hit path
  // (zero input + zero output + non-zero cacheRead). A future refactor that
  // short-circuits when `input + output === 0` (treating cache-only as free)
  // would pass every server test and only fail this one — the cache-hit
  // discount on a no-new-completion reply must still bill the cached prefix.
  it('includes cache-read tokens (all-cacheRead scenario)', () => {
    const rates = { input: 3, output: 15, cacheRead: 0.3 };
    expect(computeUsageCost({ input: 0, output: 0, cacheRead: 2_000_000 }, rates)).toBeCloseTo(
      0.6,
      9,
    );
  });
});
