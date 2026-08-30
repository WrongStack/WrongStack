import { describe, expect, it } from 'vitest';
import type { LeaderTierSwitchRequest } from '../../src/coordination/model-tier-leader.js';
import {
  evaluateLeaderTierSwitch,
  evaluateSwitchEconomics,
  leaderTierPolicy,
  tierRank,
} from '../../src/coordination/model-tier-leader.js';
import type { Config, ModelTiersConfig } from '../../src/types/config.js';

function makeConfig(tiers?: Partial<ModelTiersConfig>): Config {
  return {
    provider: 'anthropic',
    model: 'leader-model',
    fallbackProfiles: { cheap: ['anthropic/haiku-x'], rich: ['anthropic/opus-x'] },
    providers: { anthropic: { apiKey: 'k', models: ['haiku-x', 'opus-x'] } },
    modelTiers: {
      enabled: true,
      // Declaration order IS the ladder: budget < standard < premium.
      levels: {
        budget: { fallbackProfile: 'cheap' },
        standard: { fallbackProfile: 'cheap' },
        premium: { fallbackProfile: 'rich' },
      },
      ...tiers,
    },
  } as unknown as Config;
}

// Roughly Opus-shaped vs Haiku-shaped, in USD per 1M tokens.
const EXPENSIVE = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
  cacheWritePerMTok: 18.75,
  maxContext: 200_000,
};
const CHEAP = {
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheReadPerMTok: 0.1,
  cacheWritePerMTok: 1.25,
  maxContext: 200_000,
};

const baseRequest: LeaderTierSwitchRequest = {
  fromTier: 'premium',
  toTier: 'budget',
  contextTokens: 100_000,
  turnsSinceSwitch: 50,
  economics: { from: EXPENSIVE, to: CHEAP },
};

describe('leaderTierPolicy defaults', () => {
  it('defaults to propose — the leader never widens its own authority', () => {
    const p = leaderTierPolicy(makeConfig());
    expect(p.mode).toBe('propose');
    expect(p.dwellTurns).toBe(6);
    expect(p.minSavingsUsd).toBe(0.1);
    expect(p.maxContextFillForSwitch).toBe(0.8);
  });

  it('honors explicit values', () => {
    const p = leaderTierPolicy(makeConfig({ leader: { mode: 'auto', dwellTurns: 20 } }));
    expect(p.mode).toBe('auto');
    expect(p.dwellTurns).toBe(20);
  });
});

describe('tierRank', () => {
  it('ranks by config declaration order', () => {
    const config = makeConfig();
    expect(tierRank(config, 'budget')).toBe(0);
    expect(tierRank(config, 'standard')).toBe(1);
    expect(tierRank(config, 'premium')).toBe(2);
    expect(tierRank(config, 'nope')).toBe(-1);
  });
});

describe('evaluateSwitchEconomics', () => {
  it('charges the re-warm against the projected per-turn saving', () => {
    const e = evaluateSwitchEconomics(baseRequest, 6);
    // 100k tokens = 0.1 MTok.
    expect(e.stayCostPerTurnUsd).toBeCloseTo(0.15, 6); // 0.1 * 1.5
    expect(e.switchCostPerTurnUsd).toBeCloseTo(0.01, 6); // 0.1 * 0.1
    expect(e.reWarmCostUsd).toBeCloseTo(0.125, 6); // 0.1 * 1.25
    expect(e.projectedSavingsUsd).toBeCloseTo(0.14 * 6 - 0.125, 6);
    expect(e.isDowngrade).toBe(true);
  });

  it('falls back to uncached input pricing when no cache prices are published', () => {
    const e = evaluateSwitchEconomics(
      {
        ...baseRequest,
        economics: { from: { inputPerMTok: 10 }, to: { inputPerMTok: 2 } },
      },
      1,
    );
    expect(e.stayCostPerTurnUsd).toBeCloseTo(1, 6);
    expect(e.switchCostPerTurnUsd).toBeCloseTo(0.2, 6);
    expect(e.reWarmCostUsd).toBeCloseTo(0.2, 6);
  });
});

describe('evaluateLeaderTierSwitch guards', () => {
  it('refuses when the tier layer is off', () => {
    const off = { ...makeConfig(), modelTiers: undefined } as unknown as Config;
    const v = evaluateLeaderTierSwitch(off, baseRequest);
    expect(v).toMatchObject({ allowed: false, code: 'disabled' });
  });

  it('refuses when leader mode is off', () => {
    const v = evaluateLeaderTierSwitch(makeConfig({ leader: { mode: 'off' } }), baseRequest);
    expect(v).toMatchObject({ allowed: false, code: 'disabled' });
  });

  it('refuses a switch to the tier already active', () => {
    const v = evaluateLeaderTierSwitch(makeConfig(), { ...baseRequest, toTier: 'premium' });
    expect(v).toMatchObject({ allowed: false, code: 'same-tier' });
  });

  it('refuses an unconfigured tier and names the real ones', () => {
    const v = evaluateLeaderTierSwitch(makeConfig(), { ...baseRequest, toTier: 'gold' });
    expect(v).toMatchObject({ allowed: false, code: 'unknown-tier' });
    expect(v.reason).toContain('budget, standard, premium');
  });

  it('refuses to climb above the configured ceiling', () => {
    const config = makeConfig({ leader: { maxTier: 'standard' } });
    const v = evaluateLeaderTierSwitch(config, {
      ...baseRequest,
      fromTier: 'budget',
      toTier: 'premium',
      economics: { from: CHEAP, to: EXPENSIVE },
    });
    expect(v).toMatchObject({ allowed: false, code: 'ceiling' });
  });

  it('allows moving up to, but not past, the ceiling', () => {
    const config = makeConfig({ leader: { maxTier: 'standard' } });
    const v = evaluateLeaderTierSwitch(config, {
      ...baseRequest,
      fromTier: 'budget',
      toTier: 'standard',
      economics: { from: CHEAP, to: EXPENSIVE },
    });
    expect(v.allowed).toBe(true);
  });

  it('refuses before the dwell window elapses — cache thrash guard', () => {
    const v = evaluateLeaderTierSwitch(makeConfig(), { ...baseRequest, turnsSinceSwitch: 2 });
    expect(v).toMatchObject({ allowed: false, code: 'dwell' });
  });

  it('refuses a downgrade that would strand the session over the smaller window', () => {
    const v = evaluateLeaderTierSwitch(makeConfig(), {
      ...baseRequest,
      contextTokens: 180_000,
      economics: { from: EXPENSIVE, to: { ...CHEAP, maxContext: 200_000 } },
    });
    expect(v).toMatchObject({ allowed: false, code: 'context-window' });
    expect(v.reason).toContain('Compact first');
  });

  it('refuses a downgrade whose saving does not cover the cache re-warm', () => {
    // Nearly identical prices: the re-warm can never be earned back.
    const v = evaluateLeaderTierSwitch(makeConfig(), {
      ...baseRequest,
      economics: {
        from: { ...EXPENSIVE, inputPerMTok: 1.01, cacheReadPerMTok: 0.101 },
        to: CHEAP,
      },
    });
    expect(v).toMatchObject({ allowed: false, code: 'not-worth-it' });
  });

  it('allows a downgrade that clearly pays for itself, as a proposal by default', () => {
    const v = evaluateLeaderTierSwitch(makeConfig(), baseRequest);
    expect(v).toMatchObject({ allowed: true, mode: 'propose' });
  });

  it('returns mode auto only when the user turned it on', () => {
    const v = evaluateLeaderTierSwitch(makeConfig({ leader: { mode: 'auto' } }), baseRequest);
    expect(v).toMatchObject({ allowed: true, mode: 'auto' });
  });

  it('skips the economic gate when neither model publishes prices', () => {
    // A missing price list must not become a silent kill switch on downgrades.
    const v = evaluateLeaderTierSwitch(makeConfig(), {
      ...baseRequest,
      economics: { from: { maxContext: 200_000 }, to: { maxContext: 200_000 } },
    });
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain('No published pricing');
  });

  it('judges a switch with an unpriced TARGET on the structural guards alone', () => {
    // Only the current model publishes a price. The target's price is
    // UNKNOWN, not zero — `?? 0` used to make a downgrade to an arbitrary
    // uncataloged model project maximal savings and slip past break-even.
    const v = evaluateLeaderTierSwitch(makeConfig(), {
      ...baseRequest,
      economics: { from: EXPENSIVE, to: { maxContext: 200_000 } },
    });
    expect(v.allowed).toBe(true);
    expect(v.reason).toContain('No published pricing');
  });

  it('fails closed when the ceiling names an unconfigured tier', () => {
    // A typo'd ceiling must surface as a refusal, not silently disable the
    // user's spending limit.
    const config = makeConfig({ leader: { maxTier: 'standrad' } });
    const v = evaluateLeaderTierSwitch(config, baseRequest);
    expect(v).toMatchObject({ allowed: false, code: 'ceiling' });
    expect(v.reason).toContain('standrad');
  });
  it('does not apply the break-even test to an upgrade', () => {
    // An upgrade always "loses money"; it is justified by capability, not cost.
    const v = evaluateLeaderTierSwitch(makeConfig(), {
      ...baseRequest,
      fromTier: 'budget',
      toTier: 'premium',
      economics: { from: CHEAP, to: EXPENSIVE },
    });
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.economics.isDowngrade).toBe(false);
  });
});
