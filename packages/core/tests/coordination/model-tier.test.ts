import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG } from '../../src/coordination/agents/index.js';
import { phaseForRole } from '../../src/coordination/model-matrix.js';
import {
  applyTierToSubagentConfig,
  classifyTier,
  DEFAULT_TIER_ID,
  isConfiguredTier,
  listTierIds,
  resolveTier,
  tierBudget,
} from '../../src/coordination/model-tier.js';
import type { Config, ModelTiersConfig } from '../../src/types/config.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';

// Pick a real role + its phase from the catalog so these stay valid as the
// catalog evolves (no hardcoded role names to drift out of sync).
const sampleRole = Object.keys(AGENT_CATALOG)[0]!;
const samplePhase = phaseForRole(sampleRole)!;

function makeConfig(tiers?: ModelTiersConfig): Config {
  return {
    provider: 'anthropic',
    model: 'leader-model',
    fallbackProfiles: {
      cheap: ['anthropic/haiku-x', 'openai/mini-x'],
      rich: ['anthropic/opus-x', 'openai/big-x'],
    },
    providers: {
      anthropic: { apiKey: 'k', models: ['haiku-x', 'opus-x'] },
      openai: { apiKey: 'k', models: ['mini-x', 'big-x'] },
    },
    ...(tiers ? { modelTiers: tiers } : {}),
  } as unknown as Config;
}

const LEVELS: ModelTiersConfig['levels'] = {
  budget: { fallbackProfile: 'cheap', maxCostUsd: 0.25, maxIterations: 30 },
  standard: { fallbackProfile: 'cheap' },
  premium: { fallbackProfile: 'rich', maxCostUsd: 10 },
};

describe('activation', () => {
  it('is inert when modelTiers is absent', () => {
    const config = makeConfig();
    expect(classifyTier(config, { role: sampleRole })).toBeUndefined();
    expect(resolveTier(config, { role: sampleRole })).toBeUndefined();
    expect(listTierIds(config)).toEqual([]);
  });

  it('is inert when enabled is not explicitly true', () => {
    const config = makeConfig({ levels: LEVELS, routing: { '*': 'premium' } });
    expect(classifyTier(config, {})).toBeUndefined();
    expect(resolveTier(config, {})).toBeUndefined();
  });

  it('lists configured levels once enabled', () => {
    const config = makeConfig({ enabled: true, levels: LEVELS });
    expect(listTierIds(config)).toEqual(['budget', 'standard', 'premium']);
    expect(isConfiguredTier(config, 'budget')).toBe(true);
    expect(isConfiguredTier(config, 'nope')).toBe(false);
  });
});

describe('classifyTier precedence', () => {
  const config = makeConfig({
    enabled: true,
    levels: LEVELS,
    routing: { [sampleRole]: 'premium', [samplePhase]: 'standard', '*': 'budget' },
  });

  it('an explicit tier outranks every table entry', () => {
    const d = classifyTier(config, { role: sampleRole, tier: 'budget' })!;
    expect(d).toMatchObject({ tier: 'budget', source: 'explicit', configured: true });
  });

  it('matches an exact role before its phase', () => {
    const d = classifyTier(config, { role: sampleRole })!;
    expect(d).toMatchObject({ tier: 'premium', source: 'role', key: sampleRole });
  });

  it('falls back to the phase when no role entry exists', () => {
    const phaseOnly = makeConfig({
      enabled: true,
      levels: LEVELS,
      routing: { [samplePhase]: 'standard', '*': 'budget' },
    });
    const d = classifyTier(phaseOnly, { role: sampleRole })!;
    expect(d).toMatchObject({ tier: 'standard', source: 'phase', key: samplePhase });
  });

  it('falls back to the star default', () => {
    const starOnly = makeConfig({ enabled: true, levels: LEVELS, routing: { '*': 'budget' } });
    const d = starOnly && classifyTier(starOnly, { role: 'unknown-role' })!;
    expect(d).toMatchObject({ tier: 'budget', source: 'default', key: '*' });
  });

  it('falls back to the configured default, then to the built-in default', () => {
    const noRouting = makeConfig({ enabled: true, levels: LEVELS, default: 'premium' });
    expect(classifyTier(noRouting, {})).toMatchObject({
      tier: 'premium',
      source: 'config-default',
    });

    const noDefault = makeConfig({ enabled: true, levels: LEVELS });
    expect(classifyTier(noDefault, {})).toMatchObject({
      tier: DEFAULT_TIER_ID,
      source: 'config-default',
    });
  });

  it('reports an explicit unknown tier rather than silently rewriting it', () => {
    const d = classifyTier(config, { tier: 'gold' })!;
    expect(d).toMatchObject({ tier: 'gold', source: 'explicit', configured: false });
    // ...and resolution yields nothing, so the caller keeps its own model.
    expect(resolveTier(config, { tier: 'gold' })).toBeUndefined();
  });

  it('does not resolve Object.prototype keys as routing entries or levels', () => {
    // Role and tier ids index plain config objects, so `routing['toString']`
    // used to inherit Object.prototype.toString and read as a configured
    // entry; `levels['constructor']` likewise read as a configured level.
    const protoConfig = makeConfig({
      enabled: true,
      levels: LEVELS,
      routing: { [sampleRole]: 'premium' },
    });
    // An unconfigured role falls through to the config default — it must not
    // classify as a `role` hit whose "tier" is an inherited function.
    expect(classifyTier(protoConfig, { role: 'toString' })).toMatchObject({
      tier: DEFAULT_TIER_ID,
      source: 'config-default',
    });
    // Own keys keep working; inherited keys do not count as configured.
    expect(classifyTier(protoConfig, { role: sampleRole })).toMatchObject({
      tier: 'premium',
      source: 'role',
    });
    expect(isConfiguredTier(protoConfig, 'constructor')).toBe(false);
    expect(isConfiguredTier(protoConfig, 'toString')).toBe(false);
  });
});

describe('resolveTier expansion', () => {
  const config = makeConfig({ enabled: true, levels: LEVELS, routing: { '*': 'budget' } });

  it('expands a profile into a primary plus a failover chain', () => {
    const r = resolveTier(config, {})!;
    expect(r.tier).toBe('budget');
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('haiku-x');
    expect(r.fallbackModels).toEqual(['openai/mini-x']);
    expect(r.fallbackProfile).toBe('cheap');
  });

  it('lets an explicit level model win over the profile primary', () => {
    const pinned = makeConfig({
      enabled: true,
      levels: { budget: { fallbackProfile: 'cheap', model: 'pinned-x', provider: 'openai' } },
      routing: { '*': 'budget' },
    });
    const r = resolveTier(pinned, {})!;
    expect(r.model).toBe('pinned-x');
    expect(r.provider).toBe('openai');
    // The profile still supplies failover.
    expect(r.fallbackModels).toEqual(['anthropic/haiku-x', 'openai/mini-x']);
  });

  it('collects only the budget fields the level declares', () => {
    expect(tierBudget(LEVELS!['budget'])).toEqual({ maxCostUsd: 0.25, maxIterations: 30 });
    expect(tierBudget(LEVELS!['standard'])).toEqual({});
    expect(tierBudget(undefined)).toEqual({});
  });
});

describe('applyTierToSubagentConfig', () => {
  const config = makeConfig({ enabled: true, levels: LEVELS, routing: { '*': 'budget' } });
  const resolved = () => resolveTier(config, {})!;

  it('fills model fields only when unset', () => {
    const cfg: SubagentConfig = { name: 'w', provider: 'openai', model: 'explicit-x' };
    applyTierToSubagentConfig(cfg, resolved());
    expect(cfg.model).toBe('explicit-x');
    expect(cfg.provider).toBe('openai');
    // The chain is still contributed, since the caller supplied none.
    expect(cfg.fallbackProfile).toBe('cheap');
  });

  it('sets budgets that are unset', () => {
    const cfg: SubagentConfig = { name: 'w' };
    applyTierToSubagentConfig(cfg, resolved());
    expect(cfg.maxCostUsd).toBe(0.25);
    expect(cfg.maxIterations).toBe(30);
  });

  it('TIGHTENS a roster default rather than leaving it — a budget tier must bite', () => {
    const cfg: SubagentConfig = { name: 'w', maxCostUsd: 5, maxIterations: 200 };
    applyTierToSubagentConfig(cfg, resolved());
    expect(cfg.maxCostUsd).toBe(0.25);
    expect(cfg.maxIterations).toBe(30);
  });

  it('never raises a budget above what the role already allowed', () => {
    const rich = makeConfig({ enabled: true, levels: LEVELS, routing: { '*': 'premium' } });
    const cfg: SubagentConfig = { name: 'w', maxCostUsd: 1 };
    applyTierToSubagentConfig(cfg, resolveTier(rich, {})!);
    expect(cfg.maxCostUsd).toBe(1);
  });

  it('never touches a caller-pinned budget', () => {
    const cfg: SubagentConfig = {
      name: 'w',
      maxCostUsd: 5,
      maxIterations: 200,
      budgetPins: ['maxCostUsd'],
    };
    applyTierToSubagentConfig(cfg, resolved());
    expect(cfg.maxCostUsd).toBe(5);
    // Unpinned fields are still tightened.
    expect(cfg.maxIterations).toBe(30);
  });

  it('never clamps a wall-clock timeout down', () => {
    const slow = makeConfig({
      enabled: true,
      levels: { budget: { fallbackProfile: 'cheap', timeoutMs: 60_000 } },
      routing: { '*': 'budget' },
    });
    const cfg: SubagentConfig = { name: 'w', timeoutMs: 10 * 60 * 60_000 };
    applyTierToSubagentConfig(cfg, resolveTier(slow, {})!);
    expect(cfg.timeoutMs).toBe(10 * 60 * 60_000);

    const unset: SubagentConfig = { name: 'w' };
    applyTierToSubagentConfig(unset, resolveTier(slow, {})!);
    expect(unset.timeoutMs).toBe(60_000);
  });

  it('is a no-op for an undefined resolution', () => {
    const cfg: SubagentConfig = { name: 'w', maxCostUsd: 5 };
    applyTierToSubagentConfig(cfg, undefined);
    expect(cfg).toEqual({ name: 'w', maxCostUsd: 5 });
  });
});
