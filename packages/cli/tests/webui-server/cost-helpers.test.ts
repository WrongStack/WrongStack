import { describe, expect, it } from 'vitest';

/**
 * PR 2 of Issue #30 (webui-server 8-PR refactor):
 * characterize `getCostRates` and `computeUsageCost`.
 *
 * What the tests pin:
 *
 *   1. `getCostRates(null|undefined)`: returns all-zeros,
 *      no crash. Upstream models may be null when the
 *      catalog is partially populated.
 *
 *   2. `getCostRates({...})` without `cost`: returns
 *      all-zeros. The model record exists, but pricing
 *      is not yet published for that model.
 *
 *   3. `getCostRates({ cost: { input, output,
 *      cache_read } })`: snake_case preserved as-is from
 *      the upstream schema. The `cache_read` alias is
 *      mapped to `cacheRead` at the boundary.
 *
 *   4. `getCostRates({ cost: { input: 3, output: 15 }})`:
 *      `cacheRead` defaults to 0 when the upstream
 *      field is absent.
 *
 *   5. `computeUsageCost({ input: 1_000_000, output: 0 },
 *      { input: 3, output: 0, cacheRead: 0 })`: returns
 *      3 (USD). The per-million scaling is the
 *      whole reason `getCostRates` returns per-million
 *      numbers in the first place.
 *
 *   6. `computeUsageCost` with `cacheRead` undefined:
 *      the cache-read branch contributes 0.
 *
 *   7. `computeUsageCost` with `cacheRead: 0`:
 *      same as undefined — pinned because the
 *      "undefined vs zero" distinction used to be a
 *      footgun.
 *
 *   8. `computeUsageCost({ input: 0, output: 0 })`: zero
 *      regardless of rates — the no-op case.
 *
 *   9. Combined input/output/cacheRead math: $1 input
 *      + $2 output + $3 cacheRead rates × 1M each →
 *      6.0 USD.
 */

const { getCostRates, computeUsageCost } = await import(
  '../../src/webui-server/cost-helpers.js'
);

describe('getCostRates (PR 2 of #30)', () => {
  it('returns all zeros for null', () => {
    expect(getCostRates(null)).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('returns all zeros for undefined', () => {
    expect(getCostRates(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('returns all zeros when model has no `cost` field', () => {
    expect(getCostRates({ name: 'gpt-4o' })).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('preserves upstream snake_case `cache_read` as `cacheRead`', () => {
    const out = getCostRates({ cost: { input: 3, output: 15, cache_read: 1 } });
    expect(out).toEqual({ input: 3, output: 15, cacheRead: 1 });
  });

  it('defaults `cacheRead` to 0 when upstream `cache_read` is absent', () => {
    const out = getCostRates({ cost: { input: 3, output: 15 } });
    expect(out.cacheRead).toBe(0);
  });
});

describe('computeUsageCost (PR 2 of #30)', () => {
  const rates = { input: 3, output: 15, cacheRead: 1 };

  it('1M input tokens @ $3/M = $3', () => {
    expect(computeUsageCost({ input: 1_000_000, output: 0 }, rates)).toBe(3);
  });

  it('1M output tokens @ $15/M = $15', () => {
    expect(computeUsageCost({ input: 0, output: 1_000_000 }, rates)).toBe(15);
  });

  it('cacheRead undefined contributes 0', () => {
    expect(
      computeUsageCost({ input: 1_000_000, output: 1_000_000 }, rates)
    ).toBe(18);
  });

  it('cacheRead: 0 contributes 0 (same as undefined)', () => {
    expect(
      computeUsageCost({ input: 1_000_000, output: 1_000_000, cacheRead: 0 }, rates)
    ).toBe(18);
  });

  it('zero usage yields zero cost regardless of rates', () => {
    expect(
      computeUsageCost({ input: 0, output: 0 }, { input: 999, output: 999, cacheRead: 999 })
    ).toBe(0);
  });

  it('combined input + output + cacheRead math', () => {
    const r = { input: 1, output: 2, cacheRead: 3 };
    const cost = computeUsageCost({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }, r);
    expect(cost).toBe(6);
  });
});
