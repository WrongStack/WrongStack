/**
 * A tier someone chose for a spawn outranks the role's routing-table model.
 *
 * It used to be fill-only: the matrix filled the model first, so on a routed
 * role `delegate({ tier: 'budget' })` kept the routed (often premium) model and
 * only tightened the budget — the reverse of what the caller asked for.
 */

import type { Config } from '@wrongstack/contracts/types/config';
import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import { describe, expect, it } from 'vitest';
import { resolveDirectorSpawnModel } from '../../src/coordination/director-spawn-model.js';

const CONFIG = {
  modelTiers: {
    enabled: true,
    default: 'standard',
    levels: {
      budget: { provider: 'cheap-co', model: 'flash' },
      standard: { provider: 'mid-co', model: 'mid' },
    },
  },
} as unknown as Config;

const MATRIX = { reviewer: { provider: 'strong-co', model: 'max' } };

function resolve(cfg: SubagentConfig): SubagentConfig {
  const config = { ...cfg };
  resolveDirectorSpawnModel(config, {
    modelMatrix: MATRIX,
    config: CONFIG,
    ...(config.tier ? { tier: config.tier } : {}),
    sessionProvider: 'leader-co',
    sessionModel: 'leader-1',
  });
  return config;
}

describe('chosen tier vs routing table', () => {
  it('lands a routed role on the chosen tier model', () => {
    const cfg = resolve({ name: 'r', role: 'reviewer', tier: 'budget' });
    expect([cfg.provider, cfg.model]).toEqual(['cheap-co', 'flash']);
  });

  it('keeps the route when no tier was chosen', () => {
    const cfg = resolve({ name: 'r', role: 'reviewer' });
    expect([cfg.provider, cfg.model]).toEqual(['strong-co', 'max']);
  });

  it('keeps the route for a guessed tier', () => {
    const cfg = resolve({ name: 'r', role: 'reviewer', tier: 'budget', tierSuggested: true });
    expect([cfg.provider, cfg.model]).toEqual(['strong-co', 'max']);
  });

  it('keeps the route when the chosen tier names no configured level', () => {
    const cfg = resolve({ name: 'r', role: 'reviewer', tier: 'platinum' });
    expect([cfg.provider, cfg.model]).toEqual(['strong-co', 'max']);
  });

  it('still lets an explicit provider + model win over the tier', () => {
    const cfg = resolve({
      name: 'r',
      role: 'reviewer',
      tier: 'budget',
      provider: 'pin-co',
      model: 'pinned',
      modelChosenByLeader: true,
    });
    expect([cfg.provider, cfg.model]).toEqual(['pin-co', 'pinned']);
  });
});
