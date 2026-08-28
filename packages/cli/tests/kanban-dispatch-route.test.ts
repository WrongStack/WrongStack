import type { Config } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { resolveKanbanDispatchRoute } from '../src/kanban-dispatch-route.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'anthropic',
    model: 'session-model',
    fallbackProfiles: {
      cheap: ['anthropic/haiku-x', 'openai/mini-x'],
      rich: ['anthropic/opus-x', 'openai/big-x'],
    },
    providers: {
      anthropic: { apiKey: 'k', models: ['haiku-x', 'opus-x'] },
      openai: { apiKey: 'k', models: ['mini-x', 'big-x'] },
    },
    ...overrides,
  } as unknown as Config;
}

const TIERS = {
  enabled: true,
  levels: {
    budget: { fallbackProfile: 'cheap' },
    premium: { fallbackProfile: 'rich' },
  },
  routing: { '*': 'budget' },
} as unknown as Config['modelTiers'];

describe('resolveKanbanDispatchRoute', () => {
  it('passes an explicit provider/model straight through', () => {
    const route = resolveKanbanDispatchRoute(makeConfig(), {
      provider: 'openai',
      model: 'pinned-x',
    });
    expect(route).toMatchObject({ provider: 'openai', model: 'pinned-x' });
    expect(route.tier).toBeUndefined();
  });

  it('expands a fallback profile into a primary plus a chain', () => {
    const route = resolveKanbanDispatchRoute(makeConfig(), { fallbackProfile: 'cheap' });
    expect(route).toMatchObject({ provider: 'anthropic', model: 'haiku-x' });
    expect(route.fallbackModels).toEqual(['openai/mini-x']);
  });

  it('resolves a named tier into a model and reports which tier applied', () => {
    const route = resolveKanbanDispatchRoute(makeConfig({ modelTiers: TIERS }), {
      tier: 'premium',
    });
    expect(route).toMatchObject({ provider: 'anthropic', model: 'opus-x', tier: 'premium' });
    expect(route.fallbackModels).toEqual(['openai/big-x']);
  });

  it('routes by role through the tier table when no tier is named', () => {
    const route = resolveKanbanDispatchRoute(makeConfig({ modelTiers: TIERS }), {
      role: 'executor',
    });
    // routing['*'] = budget
    expect(route).toMatchObject({ model: 'haiku-x', tier: 'budget' });
  });

  it('lets an explicit profile win over the tier — the board made the more specific call', () => {
    const route = resolveKanbanDispatchRoute(makeConfig({ modelTiers: TIERS }), {
      fallbackProfile: 'rich',
      tier: 'budget',
    });
    expect(route).toMatchObject({ model: 'opus-x' });
    expect(route.tier).toBeUndefined();
  });

  it('is inert when the tier layer is disabled', () => {
    const disabled = { ...TIERS, enabled: false } as unknown as Config['modelTiers'];
    const route = resolveKanbanDispatchRoute(makeConfig({ modelTiers: disabled }), {
      tier: 'premium',
    });
    // Nothing resolved: the caller falls back to the session model.
    expect(route.model).toBeUndefined();
    expect(route.tier).toBeUndefined();
  });

  it('leaves everything undefined when no routing information is supplied', () => {
    expect(resolveKanbanDispatchRoute(makeConfig(), undefined)).toEqual({
      provider: undefined,
      model: undefined,
      fallbackModels: undefined,
    });
  });
});
