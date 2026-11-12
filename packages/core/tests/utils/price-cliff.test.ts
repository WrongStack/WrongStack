import { describe, expect, it } from 'vitest';
import {
  adjustLadderForPriceCliff,
  CONTEXT_PRICE_CLIFF_META,
  priceCliffRouteForContext,
  priceCliffRouteKey,
  readPriceCliffMeta,
  readPriceCliffTokens,
  resolvePriceCliffTokens,
  writePriceCliffMeta,
} from '../../src/utils/price-cliff.js';

/** Balanced-policy ladder, the shape the middleware hands to the adjuster. */
const BALANCED = { warn: 0.55, soft: 0.7, hard: 0.85, targetLoad: 0.65 };

describe('resolvePriceCliffTokens', () => {
  it('reads the canonical structured context tier', () => {
    const cost = {
      input: 3,
      output: 15,
      tiers: [{ tier: { type: 'context', size: 200_000 }, input: 6, output: 22.5 }],
    };
    expect(resolvePriceCliffTokens(cost, 1_000_000)).toEqual({
      cliffTokens: 200_000,
      multiplier: 2,
      field: 'input',
      baseRate: 3,
      cliffRate: 6,
    });
  });

  it('reads the legacy scalar and object context_over_200k forms', () => {
    expect(
      resolvePriceCliffTokens({ input: 1, context_over_200k: 2 }, 1_000_000)?.cliffTokens,
    ).toBe(200_000);
    expect(
      resolvePriceCliffTokens(
        { input: 1.25, output: 10, context_over_200k: { input: 2.5, output: 15 } },
        1_000_000,
      )?.cliffTokens,
    ).toBe(200_000);
  });

  it('detects a step-up that is only on the output or cache rate', () => {
    const outputOnly = {
      input: 3,
      output: 15,
      tiers: [{ tier: { type: 'context', size: 250_000 }, output: 60 }],
    };
    expect(resolvePriceCliffTokens(outputOnly, 1_000_000)).toMatchObject({
      cliffTokens: 250_000,
      field: 'output',
      multiplier: 4,
    });
    const cacheOnly = {
      input: 3,
      cache_read: 0.3,
      tiers: [{ tier: { type: 'context', size: 200_000 }, cache_read: 0.6 }],
    };
    expect(resolvePriceCliffTokens(cacheOnly, 1_000_000)?.field).toBe('cacheRead');
  });

  it('picks the LOWEST reachable boundary and the steepest field on it', () => {
    const cost = {
      input: 3,
      output: 15,
      tiers: [
        { tier: { type: 'context', size: 400_000 }, input: 9 },
        { tier: { type: 'context', size: 200_000 }, input: 6, output: 120 },
      ],
    };
    expect(resolvePriceCliffTokens(cost, 1_000_000)).toMatchObject({
      cliffTokens: 200_000,
      field: 'output',
      multiplier: 8,
    });
  });

  it('is not a cliff when the tier does not actually cost more', () => {
    // Catalogs restate the same rates in a tier; capping for it would throw
    // away history for no money saved.
    const same = { input: 3, tiers: [{ tier: { type: 'context', size: 200_000 }, input: 3 }] };
    expect(resolvePriceCliffTokens(same, 1_000_000)).toBeNull();
    const cheaper = { input: 3, tiers: [{ tier: { type: 'context', size: 200_000 }, input: 1 }] };
    expect(resolvePriceCliffTokens(cheaper, 1_000_000)).toBeNull();
  });

  it('ignores a boundary the window can never reach', () => {
    const cost = { input: 3, tiers: [{ tier: { type: 'context', size: 200_000 }, input: 6 }] };
    expect(resolvePriceCliffTokens(cost, 200_000)).toBeNull();
    expect(resolvePriceCliffTokens(cost, 128_000)).toBeNull();
    // A window ABOVE the boundary is exactly the case worth protecting.
    expect(resolvePriceCliffTokens(cost, 200_001)?.cliffTokens).toBe(200_000);
  });

  it('treats an unknown window as one where any published boundary applies', () => {
    const cost = { input: 3, tiers: [{ tier: { type: 'context', size: 200_000 }, input: 6 }] };
    expect(resolvePriceCliffTokens(cost, 0)?.cliffTokens).toBe(200_000);
  });

  it('rejects a boundary too small to be a real price tier', () => {
    const cost = { input: 3, tiers: [{ tier: { type: 'context', size: 1_000 }, input: 6 }] };
    expect(resolvePriceCliffTokens(cost, 1_000_000)).toBeNull();
  });

  it('survives malformed catalog shapes', () => {
    expect(resolvePriceCliffTokens(undefined, 1_000_000)).toBeNull();
    expect(resolvePriceCliffTokens(null as never, 1_000_000)).toBeNull();
    expect(resolvePriceCliffTokens({ input: 3 }, 1_000_000)).toBeNull();
    expect(resolvePriceCliffTokens({ input: 3, tiers: 'nope' }, 1_000_000)).toBeNull();
    expect(
      resolvePriceCliffTokens({ input: 3, tiers: [null, 'x', {}, { tier: null }] }, 1_000_000),
    ).toBeNull();
    // A non-context tier kind is not a context price cliff.
    expect(
      resolvePriceCliffTokens(
        { input: 3, tiers: [{ tier: { type: 'audio', size: 200_000 }, input: 6 }] },
        1_000_000,
      ),
    ).toBeNull();
    // Non-numeric / negative base rates cannot prove a step-up.
    expect(
      resolvePriceCliffTokens(
        { input: '3', tiers: [{ tier: { type: 'context', size: 200_000 }, input: 6 }] },
        1_000_000,
      ),
    ).toBeNull();
  });
});

describe('adjustLadderForPriceCliff', () => {
  const AVAILABLE = 1_000_000;

  it('leaves the ladder untouched with no cliff', () => {
    for (const cliff of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 4_000]) {
      expect(adjustLadderForPriceCliff(BALANCED, AVAILABLE, cliff)).toEqual({
        thresholds: { warn: 0.55, soft: 0.7, hard: 0.85 },
        targetLoad: 0.65,
        binding: false,
      });
    }
  });

  it('is a no-op when the cliff sits above the compaction rung', () => {
    // soft fires at 700K; an 800K cliff is never the reason to compact.
    expect(adjustLadderForPriceCliff(BALANCED, AVAILABLE, 800_000).binding).toBe(false);
    expect(adjustLadderForPriceCliff(BALANCED, AVAILABLE, 700_000).binding).toBe(false);
  });

  it('fires at min(threshold x window, cliff x headroom)', () => {
    const adjusted = adjustLadderForPriceCliff(BALANCED, AVAILABLE, 200_000);
    expect(adjusted.binding).toBe(true);
    expect(adjusted.thresholds.soft).toBeCloseTo(0.2 * 0.95, 10);
    expect(adjusted.triggerTokens).toBe(190_000);
    // warn is pulled down with soft, so the rung order is never inverted.
    expect(adjusted.thresholds.warn).toBeCloseTo(0.2 * 0.95, 10);
    expect(adjusted.thresholds.warn).toBeLessThanOrEqual(adjusted.thresholds.soft);
  });

  it('keeps `hard` as the overflow line, not a price line', () => {
    // A 2x price is not a provider rejection: pulling hard down would make the
    // cliff throw AGENT_CONTEXT_OVERFLOW for a request that fits fine.
    expect(adjustLadderForPriceCliff(BALANCED, AVAILABLE, 200_000).thresholds.hard).toBe(0.85);
  });

  it('caps the post-compaction target so a pass actually lands under the cliff', () => {
    const adjusted = adjustLadderForPriceCliff(BALANCED, AVAILABLE, 200_000);
    expect(adjusted.targetLoad).toBeCloseTo(0.2 * 0.8, 10);
    expect(adjusted.targetLoad).toBeLessThan(adjusted.thresholds.soft);
  });

  it('preserves warn <= soft <= hard ordering on a small window', () => {
    const adjusted = adjustLadderForPriceCliff(BALANCED, 300_000, 100_000);
    const { warn, soft, hard } = adjusted.thresholds;
    expect(warn).toBeLessThanOrEqual(soft);
    expect(soft).toBeLessThanOrEqual(hard);
    expect(adjusted.targetLoad).toBeLessThanOrEqual(soft);
  });

  it('never lets a tiny window collapse the ladder to zero', () => {
    const adjusted = adjustLadderForPriceCliff(BALANCED, 20_000, 8_192);
    expect(adjusted.thresholds.soft).toBeGreaterThanOrEqual(0.05);
    expect(adjusted.targetLoad).toBeGreaterThan(0);
  });

  it('honors a custom (deeper) policy instead of assuming balanced', () => {
    const deep = { warn: 0.72, soft: 0.86, hard: 0.96, targetLoad: 0.82 };
    const adjusted = adjustLadderForPriceCliff(deep, AVAILABLE, 200_000);
    expect(adjusted.thresholds.soft).toBeCloseTo(0.19, 10);
    expect(adjusted.thresholds.hard).toBe(0.96);
    expect(adjusted.targetLoad).toBeCloseTo(0.16, 10);
  });
});

describe('price cliff session meta', () => {
  it('round-trips the resolved cliff and stamps the route it belongs to', () => {
    const meta: Record<string, unknown> = {};
    writePriceCliffMeta(meta, { cliffTokens: 200_000, multiplier: 2 }, 'anthropic/claude-x');
    expect(meta[CONTEXT_PRICE_CLIFF_META]).toEqual({
      cliffTokens: 200_000,
      multiplier: 2,
      routeKey: 'anthropic/claude-x',
    });
    expect(readPriceCliffTokens(meta, 'anthropic/claude-x')).toBe(200_000);
  });

  it('drops a cliff that belongs to another route (a model switch)', () => {
    const meta: Record<string, unknown> = {};
    writePriceCliffMeta(meta, { cliffTokens: 200_000 }, 'anthropic/claude-x');
    expect(readPriceCliffTokens(meta, 'openai/gpt-y')).toBeUndefined();
  });

  it('applies a route-less cliff (a user-set absolute cap) on every route', () => {
    expect(readPriceCliffTokens({ [CONTEXT_PRICE_CLIFF_META]: 225_000 }, 'any/model')).toBe(
      225_000,
    );
  });

  it('clears the key when the cliff goes away', () => {
    const meta: Record<string, unknown> = {};
    writePriceCliffMeta(meta, { cliffTokens: 200_000 }, 'anthropic/claude-x');
    writePriceCliffMeta(meta, null, 'anthropic/claude-x');
    expect(meta[CONTEXT_PRICE_CLIFF_META]).toBeUndefined();
    expect(readPriceCliffTokens(meta, 'anthropic/claude-x')).toBeUndefined();
  });

  it('refuses hand-edited garbage instead of reading it as a cap', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      0,
      -1,
      Number.NaN,
      1_000,
      { cliffTokens: 'x' },
      { cliffTokens: -5 },
      { cliffTokens: Number.NaN },
      { cliffTokens: 1_000 },
    ]) {
      expect(readPriceCliffMeta(bad)).toBeUndefined();
    }
  });

  it('builds the same route identity from a context as from its parts', () => {
    expect(priceCliffRouteKey('anthropic', 'claude-x')).toBe('anthropic/claude-x');
    expect(priceCliffRouteKey(undefined, 'claude-x')).toBe('unknown/claude-x');
    expect(priceCliffRouteForContext({ provider: { id: 'anthropic' }, model: 'claude-x' })).toBe(
      'anthropic/claude-x',
    );
    expect(priceCliffRouteForContext({})).toBe('unknown/');
  });
});
