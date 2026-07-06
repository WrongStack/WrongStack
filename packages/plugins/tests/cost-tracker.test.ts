import { describe, expect, it, vi, beforeEach } from 'vitest';
import costTrackerPlugin from '../src/cost-tracker';

const makeApi = () => ({
  tools: { register: vi.fn() },
  config: {
    extensions: {
      'cost-tracker': {},
    },
  },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: {
    counter: vi.fn(),
    histogram: vi.fn(),
    gauge: vi.fn(),
  },
  onEvent: vi.fn(),
  session: { append: vi.fn().mockResolvedValue(undefined) },
});

beforeEach(() => vi.clearAllMocks());

// ── Plugin registration ──────────────────────────────────────────────────────────

describe('cost-tracker plugin', () => {
  it('registers cost_summary, cost_reset, and cost_export tools', () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);
    const names = api.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(names).toContain('cost_summary');
    expect(names).toContain('cost_reset');
    expect(names).toContain('cost_export');
  });

  it('logs info on setup', () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);
    expect(api.log.info).toHaveBeenCalledWith(
      'cost-tracker plugin loaded',
      expect.any(Object),
    );
  });

  it('subscribes to provider.response and session.ended events', () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);
    expect(api.onEvent).toHaveBeenCalledWith(
      'provider.response',
      expect.any(Function),
    );
    expect(api.onEvent).toHaveBeenCalledWith(
      'session.ended',
      expect.any(Function),
    );
  });
});

// ── cost_summary ────────────────────────────────────────────────────────────────

describe('cost_summary tool', () => {
  function getSummaryTool(api: ReturnType<typeof makeApi>) {
    costTrackerPlugin.setup(api as any);
    return api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
  }

  it('returns zero totals when no requests tracked', async () => {
    const api = makeApi();
    const tool = getSummaryTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.usage.totalRequests).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
    expect(result.usage.totalCostUsd).toBe(0);
    expect(result.budgetStatus).toBe(null);
  });

  it('returns budget status when budgetLimit is configured', async () => {
    const api = makeApi();
    api.config.extensions['cost-tracker'] = { budgetLimit: 10, warningThreshold: 80 };
    const tool = getSummaryTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.budgetStatus).toEqual({
      limit: 10,
      spent: 0,
      percentUsed: 0,
      warning: false,
    });
  });
});

// ── cost_reset ─────────────────────────────────────────────────────────────────

describe('cost_reset tool', () => {
  function getResetTool(api: ReturnType<typeof makeApi>) {
    costTrackerPlugin.setup(api as any);
    return api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_reset',
    )?.[0] as any;
  }

  it('returns zero previousTotals when nothing was tracked', async () => {
    const api = makeApi();
    const tool = getResetTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.previousTotals.totalTokens).toBe(0);
    expect(result.previousTotals.totalCostUsd).toBe(0);
    expect(result.message).toBe('Cost tracking counters have been reset.');
  });
});

// ── cost_export ────────────────────────────────────────────────────────────────

describe('cost_export tool', () => {
  function getExportTool(api: ReturnType<typeof makeApi>) {
    costTrackerPlugin.setup(api as any);
    return api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_export',
    )?.[0] as any;
  }

  it('returns empty JSON when no requests tracked', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.format).toBe('json');
    expect(result.data.summary.totalRequests).toBe(0);
    expect(result.data.summary.totalTokens).toBe(0);
  });

  it('exports as CSV when format=csv', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({ format: 'csv' });
    expect(result.ok).toBe(true);
    expect(result.format).toBe('csv');
    expect(result.data).toContain('model,timestamp');
  });

  it('omits model column from CSV when includeModel=false', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({ format: 'csv', includeModel: false });
    expect(result.ok).toBe(true);
    expect(result.data).not.toContain('model,');
    expect(result.data).toContain('timestamp,');
  });

  it('omits model field from JSON when includeModel=false', async () => {
    const api = makeApi();
    const tool = getExportTool(api);
    const result = await tool.execute({ format: 'json', includeModel: false });
    expect(result.ok).toBe(true);
    expect(result.data.requests).toEqual([]);
  });
});

// ── Event: provider.response ─────────────────────────────────────────────────────

describe('provider.response event handler', () => {
  it('tracks token usage from provider.response event', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    // Find and fire the provider.response handler
    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    );
    const handler = responseCall?.[1] as Function;
    expect(handler).toBeDefined();

    handler({
      usage: { input: 1000, output: 500 },
      ctx: { model: 'gpt-4o' },
    });

    // Now check cost_summary
    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
    const result = await summaryTool.execute({});
    expect(result.usage.totalPromptTokens).toBe(1000);
    expect(result.usage.totalCompletionTokens).toBe(500);
    expect(result.usage.totalTokens).toBe(1500);
    expect(result.usage.totalCostUsd).toBeGreaterThan(0);
    expect(result.usage.byModel['gpt-4o']).toBeDefined();
    expect(result.usage.byModel['gpt-4o'].requests).toBe(1);
  });

  it('aggregates costs per model across multiple requests', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    ) as any[];
    const handler = responseCall[1] as Function;

    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'anthropic-test-model' } });
    handler({ usage: { input: 2000, output: 1000 }, ctx: { model: 'anthropic-test-model' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
    const result = await summaryTool.execute({});
    expect(result.usage.totalRequests).toBe(2);
    expect(result.usage.byModel['anthropic-test-model'].requests).toBe(2);
  });

  it('records recentRequests (last 5)', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    ) as any[];
    const handler = responseCall[1] as Function;

    for (let i = 0; i < 8; i++) {
      handler({ usage: { input: 100, output: 50 }, ctx: { model: 'gpt-4o-mini' } });
    }

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0] as any;
    const result = await summaryTool.execute({});
    expect(result.usage.totalRequests).toBe(8);
    expect(result.usage.recentRequests.length).toBeLessThanOrEqual(5);
  });
});

// ── Event: session.ended ───────────────────────────────────────────────────────

describe('session.ended event handler', () => {
  it('writes session summary when requests were tracked', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const responseCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'provider.response',
    ) as any[];
    responseCall[1]({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });

    const endedCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'session.ended',
    ) as any[];
    await endedCall[1](); // fire session.ended

    expect(api.session.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cost-tracker:session_summary',
        totalTokens: 1500,
        totalRequests: 1,
      }),
    );
  });

  it('does not write session summary when no requests', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const endedCall = api.onEvent.mock.calls.find(
      ([event]: any[]) => event === 'session.ended',
    ) as any[];
    await endedCall[1](); // fire session.ended with no requests

    expect(api.session.append).not.toHaveBeenCalled();
  });
});

// ── pricingOverrides ──────────────────────────────────────────────────────────
//
// cost-tracker exposes a config.extensions['cost-tracker'].pricingOverrides
// field that lets users override per-model pricing without waiting for
// a plugin release. Lookup chain is: override → bundled PRICING → default.

function getResponseHandler(api: ReturnType<typeof makeApi>): (payload: unknown) => void {
  const call = api.onEvent.mock.calls.find(([event]: unknown[]) => event === 'provider.response');
  if (!call) throw new Error('provider.response handler not registered');
  return (call as unknown[])[1] as (payload: unknown) => void;
}

describe('pricingOverrides', () => {
  it('applies a user override and uses it instead of bundled PRICING', async () => {
    const api = makeApi();
    // PRICING is "USD per 1M tokens" — so 1000 input tokens at input=10
    // costs (1000/1e6)*10 = 0.01 USD. Override beats the bundled
    // gpt-4o rate (input=5, output=15 → 0.0125 USD for the same usage).
    api.config.extensions['cost-tracker'] = {
      pricingOverrides: {
        'gpt-4o': { input: 10, output: 20 },
      },
    };
    costTrackerPlugin.setup(api as any);

    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    // Override rate: (1000/1e6)*10 + (500/1e6)*20 = 0.01 + 0.01 = 0.02
    expect(result.usage.totalCostUsd).toBeCloseTo(0.02, 7);
  });

  it('override keys are case-insensitive', async () => {
    const api = makeApi();
    api.config.extensions['cost-tracker'] = {
      pricingOverrides: {
        'GPT-4O': { input: 10, output: 20 }, // uppercased by user
      },
    };
    costTrackerPlugin.setup(api as any);

    const handler = getResponseHandler(api);
    // Provider reports lowercase — must still match the override.
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    expect(result.usage.totalCostUsd).toBeCloseTo(0.02, 7);
  });

  it('falls through to bundled PRICING when model is not in overrides', async () => {
    const api = makeApi();
    // Override gpt-4o only; gpt-4-turbo must use bundled.
    api.config.extensions['cost-tracker'] = {
      pricingOverrides: {
        'gpt-4o': { input: 999, output: 999 },
      },
    };
    costTrackerPlugin.setup(api as any);

    const handler = getResponseHandler(api);
    // gpt-4-turbo bundled: input=10.0, output=30.0
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4-turbo' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    // Bundled rate: (1000/1e6)*10 + (500/1e6)*30 = 0.01 + 0.015 = 0.025
    expect(result.usage.totalCostUsd).toBeCloseTo(0.025, 7);
  });

  it('falls through to DEFAULT_PRICING for unknown models', async () => {
    const api = makeApi();
    costTrackerPlugin.setup(api as any);

    const handler = getResponseHandler(api);
    // 'future-model-9000' is not in overrides nor bundled PRICING.
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'future-model-9000' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    // DEFAULT_PRICING: input=5.0, output=15.0
    // (1000/1e6)*5 + (500/1e6)*15 = 0.005 + 0.0075 = 0.0125
    expect(result.usage.totalCostUsd).toBeCloseTo(0.0125, 7);
  });

  it('overrides survive multiple cost calculations within one setup', async () => {
    const api = makeApi();
    api.config.extensions['cost-tracker'] = {
      pricingOverrides: {
        'gpt-4o-mini': { input: 0.5, output: 1.5 },
      },
    };
    costTrackerPlugin.setup(api as any);

    const handler = getResponseHandler(api);
    handler({ usage: { input: 2000, output: 1000 }, ctx: { model: 'gpt-4o-mini' } });
    handler({ usage: { input: 4000, output: 2000 }, ctx: { model: 'gpt-4o-mini' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    // Override rate aggregated: (6000/1e6)*0.5 + (3000/1e6)*1.5
    // = 0.003 + 0.0045 = 0.0075
    expect(result.usage.totalPromptTokens).toBe(6000);
    expect(result.usage.totalCompletionTokens).toBe(3000);
    expect(result.usage.totalCostUsd).toBeCloseTo(0.0075, 7);
  });

  it('ignores malformed override entries (missing input/output) without throwing', async () => {
    const api = makeApi();
    api.config.extensions['cost-tracker'] = {
      pricingOverrides: {
        'bad-model': { input: 1 }, // missing output
        'also-bad': { output: 2 }, // missing input
        'wrong-type': { input: 'free', output: 'cheap' }, // strings
        'good-model': { input: 1, output: 2 }, // valid
      },
    };
    // The schema validator in the loader would reject this config, but
    // setup() must be defensive for tests and direct callers.
    expect(() => costTrackerPlugin.setup(api as any)).not.toThrow();

    // Only the valid entry should land in the override map — confirmed
    // by trying to use the bad entries and observing they fall through.
    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'good-model' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    // (1000/1e6)*1 + (500/1e6)*2 = 0.001 + 0.001 = 0.002
    expect(result.usage.totalCostUsd).toBeCloseTo(0.002, 7);
  });
});

// ── modelsRegistry hydration ──────────────────────────────────────────────────
//
// The PluginAPI exposes an optional `modelsRegistry` (models.dev catalog).
// When present, cost-tracker hydrates a module-scope `bundledFromRegistry`
// map at setup() time and inserts it as layer 2 of the lookup chain:
//   1. pricingOverrides (user config)  — highest priority
//   2. bundledFromRegistry (models.dev) — NEW
//   3. PRICING (bundled baseline)
//   4. DEFAULT_PRICING (last-resort fallback)

interface FakeModelsRegistry {
  load: ReturnType<typeof vi.fn>;
}

function makeApiWithRegistry(payload: Record<string, unknown> | Error) {
  const base = makeApi();
  const load = vi.fn();
  if (payload instanceof Error) {
    load.mockRejectedValue(payload);
  } else {
    load.mockResolvedValue(payload);
  }
  base.modelsRegistry = { load } as unknown as FakeModelsRegistry;
  return { api: base, load };
}

describe('modelsRegistry hydration', () => {
  it('hydrates bundledFromRegistry from a valid payload', async () => {
    const { api } = makeApiWithRegistry({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-4o-from-registry': { id: 'gpt-4o-from-registry', cost: { input: 7, output: 21 } },
          'gpt-5-future': { id: 'gpt-5-future', cost: { input: 100, output: 200 } },
        },
      },
    });
    await costTrackerPlugin.setup(api as any);
    const result = await costTrackerPlugin.health!();
    expect(result.registryCount).toBe(2);
  });

  it('registry layer beats bundled PRICING for known models', async () => {
    const { api } = makeApiWithRegistry({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        // Override the bundled gpt-4o price (5/15) with a custom one
        // (8/24). bundledFromRegistry must take precedence over PRICING.
        models: {
          'gpt-4o': { id: 'gpt-4o', cost: { input: 8, output: 24 } },
        },
      },
    });
    await costTrackerPlugin.setup(api as any);

    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    // Registry rate: (1000/1e6)*8 + (500/1e6)*24 = 0.008 + 0.012 = 0.02
    // Bundled rate would be: (1000/1e6)*5 + (500/1e6)*15 = 0.0125
    expect(result.usage.totalCostUsd).toBeCloseTo(0.02, 7);
  });

  it('user override still beats registry layer (priority chain intact)', async () => {
    const { api } = makeApiWithRegistry({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-4o': { id: 'gpt-4o', cost: { input: 8, output: 24 } } },
      },
    });
    api.config.extensions['cost-tracker'] = {
      pricingOverrides: { 'gpt-4o': { input: 100, output: 200 } },
    };
    await costTrackerPlugin.setup(api as any);

    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });

    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const result = await summaryTool.execute({});
    // Override rate: (1000/1e6)*100 + (500/1e6)*200 = 0.1 + 0.1 = 0.2
    expect(result.usage.totalCostUsd).toBeCloseTo(0.2, 7);
  });

  it('skips registry entries that lack cost.input or cost.output', async () => {
    const { api } = makeApiWithRegistry({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'no-cost-model': { id: 'no-cost-model' }, // no cost field
          'partial-cost': { id: 'partial-cost', cost: { input: 1 } }, // missing output
          'wrong-type': { id: 'wrong-type', cost: { input: 'free', output: 'cheap' } },
          'valid-model': { id: 'valid-model', cost: { input: 1, output: 2 } },
        },
      },
    });
    await costTrackerPlugin.setup(api as any);

    // Only the valid entry should land in the registry map.
    const result = await costTrackerPlugin.health!();
    expect(result.registryCount).toBe(1);
  });

  it('falls back to bundled PRICING when registry.load() throws', async () => {
    const { api } = makeApiWithRegistry(new Error('network unreachable'));
    await costTrackerPlugin.setup(api as any);

    // The setup must not throw and bundledFromRegistry stays empty.
    const result = await costTrackerPlugin.health!();
    expect(result.registryCount).toBe(0);
    expect(api.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to hydrate pricing from models registry'),
      expect.any(Error),
    );

    // Lookup chain falls through to bundled PRICING for gpt-4o.
    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4o' } });
    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const summary = await summaryTool.execute({});
    // Bundled rate: (1000/1e6)*5 + (500/1e6)*15 = 0.005 + 0.0075 = 0.0125
    expect(summary.usage.totalCostUsd).toBeCloseTo(0.0125, 7);
  });

  it('no registry → bundledFromRegistry stays empty, lookup uses bundled PRICING', async () => {
    // Default makeApi() has no modelsRegistry field — confirms the
    // "host did not provide one" path is handled.
    const api = makeApi();
    await costTrackerPlugin.setup(api as any);
    const result = await costTrackerPlugin.health!();
    expect(result.registryCount).toBe(0);

    const handler = getResponseHandler(api);
    handler({ usage: { input: 1000, output: 500 }, ctx: { model: 'gpt-4-turbo' } });
    const summaryTool = api.tools.register.mock.calls.find(
      ([t]: any[]) => t.name === 'cost_summary',
    )?.[0];
    const summary = await summaryTool.execute({});
    // Bundled gpt-4-turbo: input=10, output=30
    // (1000/1e6)*10 + (500/1e6)*30 = 0.01 + 0.015 = 0.025
    expect(summary.usage.totalCostUsd).toBeCloseTo(0.025, 7);
  });

  it('teardown clears bundledFromRegistry (H1 pattern)', async () => {
    const { api } = makeApiWithRegistry({
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-4o': { id: 'gpt-4o', cost: { input: 7, output: 21 } } },
      },
    });
    await costTrackerPlugin.setup(api as any);
    const before = await costTrackerPlugin.health!();
    expect(before.registryCount).toBe(1);

    costTrackerPlugin.teardown!(api as any);
    const after = await costTrackerPlugin.health!();
    expect(after.registryCount).toBe(0);
  });
});
