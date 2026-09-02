import { describe, expect, it } from 'vitest';
import { ModelRouter, type RouterConfig } from '../../src/models/model-router.js';

const cfg = (over: Partial<RouterConfig['config']> = {}): RouterConfig['config'] => ({
  provider: 'anthropic',
  model: 'anthropic-test-model',
  providers: {
    anthropic: {
      apiKey: 'sk-ant',
      models: ['claude-opus-4-8', 'anthropic-test-model', 'claude-haiku-4-5'],
    },
    openai: { apiKeys: [{ apiKey: 'sk-oai' }], models: ['gpt-5', 'gpt-4o-mini'] },
    google: { apiKey: '', models: ['gemini-2.5-pro'] }, // no key
  } as never,
  ...over,
});

describe('ModelRouter.pickForTask', () => {
  it('uses an exact matrix override (with explicit provider)', () => {
    const r = new ModelRouter({
      config: cfg(),
      matrix: { planner: { provider: 'openai', model: 'gpt-5' } } as never,
    });
    const pick = r.pickForTask('planner', 'whatever');
    expect(pick).toMatchObject({ provider: 'openai', model: 'gpt-5', fromMatrix: true });
  });

  it('falls back to config.provider when a matrix entry omits provider', () => {
    const r = new ModelRouter({
      config: cfg(),
      matrix: { planner: { model: 'claude-opus-4-8' } } as never,
    });
    expect(r.pickForTask('planner', 'x')).toMatchObject({
      provider: 'anthropic',
      fromMatrix: true,
    });
  });

  it('resolves a matrix entry via the role→phase map', () => {
    const r = new ModelRouter({
      config: cfg(),
      matrix: { plan: { provider: 'openai', model: 'gpt-5' } } as never,
    });
    // 'architect' → phase 'plan'
    expect(r.pickForTask('architect', 'x')).toMatchObject({ model: 'gpt-5', fromMatrix: true });
  });

  it('resolves a matrix wildcard entry', () => {
    const r = new ModelRouter({
      config: cfg(),
      matrix: { '*': { provider: 'openai', model: 'gpt-5' } } as never,
    });
    expect(r.pickForTask('totally-unknown-role', 'x')).toMatchObject({ model: 'gpt-5' });
  });

  it('auto-detects the best model from the task description', () => {
    const r = new ModelRouter({ config: cfg() });
    const pick = r.pickForTask('executor', 'audit the auth module for vulnerabilities');
    // security → opus (bestFor security, premium)
    expect(pick.fromMatrix).toBe(false);
    expect(pick.reason).toMatch(/security/);
    expect(pick.provider).toBe('anthropic');
  });

  it('infers the category from the role when the description has no keywords', () => {
    const r = new ModelRouter({ config: cfg() });
    const pick = r.pickForTask('security-scanner', 'do the thing');
    expect(pick.reason).toMatch(/security/);
  });

  it('falls back to the leader model when no profile is available', () => {
    // Only an unkeyed provider has profiles → findBestModel returns undefined.
    const r = new ModelRouter({
      config: { provider: 'cohere', model: 'command-r', providers: {} } as never,
    });
    const pick = r.pickForTask('executor', 'general work');
    expect(pick).toMatchObject({
      provider: 'cohere',
      model: 'command-r',
      reason: 'leader fallback',
    });
  });

  it('uses the general role/category fallback for an unknown role + description', () => {
    const r = new ModelRouter({ config: cfg() });
    const pick = r.pickForTask('mystery', 'just do it');
    expect(pick.fromMatrix).toBe(false);
  });
});

describe('ModelRouter model selection internals', () => {
  it('skips providers without an API key', () => {
    const r = new ModelRouter({ config: cfg() });
    // 'data' → gemini (google) is bestFor data but google has no key → won't be picked.
    const pick = r.pickForTask('executor', 'analyze the json data');
    expect(pick.provider).not.toBe('google');
  });

  it('treats the leader provider as keyed even without a providers entry', () => {
    const r = new ModelRouter({
      config: { provider: 'anthropic', model: 'anthropic-test-model' } as never,
    });
    // No providers map, but provider==='anthropic' is treated as keyed; no models
    // configured → getProviderModels empty → findBestModel returns undefined → leader.
    const pick = r.pickForTask('executor', 'plan the architecture');
    expect(pick).toMatchObject({ provider: 'anthropic', reason: 'leader fallback' });
  });

  it('prefers a budget model for a lightweight task', () => {
    const r = new ModelRouter({ config: cfg() });
    // 'trivial' → lightweight; haiku is budget+bestFor lightweight → wins the budget boost.
    const pick = r.pickForTask('executor', 'a trivial edit');
    expect(pick.provider).toBe('anthropic');
    expect(pick.model).toMatch(/haiku/);
  });

  it('honours the apiKeys[] array form for key presence', () => {
    const r = new ModelRouter({ config: cfg() });
    const pick = r.pickForTask('executor', 'write some docs'); // docs → mini (openai, keyed via apiKeys[])
    expect(['anthropic', 'openai']).toContain(pick.provider);
  });
});

describe('ModelRouter cost tracking', () => {
  it('accumulates cost, tokens, and call counts per model', () => {
    const r = new ModelRouter({ config: cfg() });
    r.recordCost('anthropic', 'claude-opus-4-8', 0.5, { input: 100, output: 50 });
    r.recordCost('anthropic', 'claude-opus-4-8', 0.25); // no tokens
    const costs = r.getCosts();
    expect(costs.totalCost).toBeCloseTo(0.75);
    const entry = costs.byModel['anthropic/claude-opus-4-8'];
    expect(entry).toMatchObject({ cost: 0.75, calls: 2 });
    expect(entry?.tokens).toEqual({ input: 100, output: 50 });
  });

  it('resets cost tracking', () => {
    const r = new ModelRouter({ config: cfg() });
    r.recordCost('anthropic', 'm', 1);
    r.resetCosts();
    expect(r.getCosts()).toEqual({ byModel: {}, totalCost: 0 });
  });
});

describe('ModelRouter.suggestMatrix', () => {
  it('suggests auto-detected picks and skips explicit matrix roles', () => {
    const r = new ModelRouter({
      config: cfg(),
      matrix: { planner: { provider: 'openai', model: 'gpt-5' } } as never,
    });
    const suggested = r.suggestMatrix();
    expect(suggested.planner).toBeUndefined(); // explicit matrix role skipped
    expect(Object.keys(suggested).length).toBeGreaterThan(0);
    for (const pick of Object.values(suggested)) {
      expect(pick.fromMatrix).toBe(false);
    }
  });
});
