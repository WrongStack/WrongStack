import type { ModelsRegistry, Provider } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  describeMaxContextChange,
  refreshRuntimeModelCatalog,
  resolveRuntimeMaxContext,
  resolveRuntimeMaxContextDetailed,
} from '../src/context-limit.js';

/**
 * Minimal fake catalog: the canonical `anthropic` and `openai` providers expose
 * modern models at their real windows (Opus 4.8 → 1M, gpt-5.5 → 1.05M). The
 * OAuth families (anthropic-oauth / openai-codex / github-copilot) are NOT
 * listed — resolution must fall through to these siblings.
 */
function fakeRegistry(): ModelsRegistry {
  const catalog: Record<string, Record<string, number>> = {
    anthropic: { 'claude-opus-4-8': 1_000_000, 'claude-haiku-4-5': 200_000 },
    openai: { 'gpt-5.5': 1_050_000, 'gpt-4o': 128_000 },
  };
  return {
    async getProvider(id: string) {
      const models = catalog[id];
      if (!models) return undefined;
      return {
        family: id,
        models: Object.entries(models).map(([mid, context]) => ({ id: mid, limit: { context } })),
      };
    },
    async getModel(providerId: string, modelId: string) {
      const max = catalog[providerId]?.[modelId];
      if (!max) return undefined;
      return {
        capabilities: { maxContext: max, tools: true, vision: true, reasoning: false },
      };
    },
  } as never as ModelsRegistry;
}

const provider = { capabilities: { maxContext: 200_000 } } as never as Provider;

/**
 * Registry where the OAuth family IS published under its own id — the shape of
 * openai-codex once the curated overlay (packages/cli/data/providers.json) is
 * merged into the registry. The own entry must outrank the sibling even when
 * the sibling lists a SMALLER window for the same model (models.dev `openai`
 * lagging the overlay's 1M declarations).
 */
function overlayRegistry(): ModelsRegistry {
  const catalog: Record<string, Record<string, number>> = {
    'openai-codex': { 'gpt-5.4-mini': 1_050_000 },
    openai: { 'gpt-5.4-mini': 400_000 },
  };
  return {
    async getProvider(id: string) {
      const models = catalog[id];
      if (!models) return undefined;
      return {
        family: id,
        models: Object.entries(models).map(([mid, context]) => ({ id: mid, limit: { context } })),
      };
    },
    async getModel(providerId: string, modelId: string) {
      const max = catalog[providerId]?.[modelId];
      if (!max) return undefined;
      return {
        capabilities: { maxContext: max, tools: true, vision: true, reasoning: false },
      };
    },
  } as never as ModelsRegistry;
}

describe('resolveRuntimeMaxContext — OAuth sibling-catalog resolution', () => {
  it('resolves Opus 4.8 via anthropic-oauth to the real 1M window (not the 200k family default)', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic-oauth',
        model: 'claude-opus-4-8',
        providers: {
          'anthropic-oauth': {
            type: 'anthropic-oauth',
            family: 'anthropic-oauth',
            baseUrl: 'https://api.anthropic.com',
            models: ['claude-opus-4-8'],
          },
        },
      },
      provider,
      providerId: 'anthropic-oauth',
      modelId: 'claude-opus-4-8',
    });
    expect(max).toBe(1_000_000);
  });

  it('resolves gpt-5.5 via openai-codex to 1.05M from the openai catalog', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'openai-codex',
        model: 'gpt-5.5',
        providers: {
          'openai-codex': { type: 'openai-codex', family: 'openai-codex', models: ['gpt-5.5'] },
        },
      },
      provider,
      providerId: 'openai-codex',
      modelId: 'gpt-5.5',
    });
    expect(max).toBe(1_050_000);
  });

  it('prefers the own published entry over the sibling catalog (overlay 1M beats a stale sibling 400k)', async () => {
    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: overlayRegistry(),
      config: {
        provider: 'openai-codex',
        model: 'gpt-5.4-mini',
        providers: {
          'openai-codex': {
            type: 'openai-codex',
            family: 'openai-codex',
            models: ['gpt-5.4-mini'],
          },
        },
      },
      provider,
      providerId: 'openai-codex',
      modelId: 'gpt-5.4-mini',
    });
    expect(result).toEqual({ maxContext: 1_050_000, branch: 'catalog-capabilities' });
  });

  it('resolves github-copilot gpt-4o via the openai catalog, ignoring the proxy baseUrl', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'github-copilot',
        model: 'gpt-4o',
        providers: {
          'github-copilot': {
            type: 'github-copilot',
            family: 'github-copilot',
            baseUrl: 'https://copilot-proxy.example.com',
            models: ['gpt-4o'],
          },
        },
      },
      provider,
      providerId: 'github-copilot',
      modelId: 'gpt-4o',
    });
    expect(max).toBe(128_000);
  });

  it('honours an explicit per-provider override above the sibling catalog', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic-oauth',
        model: 'claude-opus-4-8',
        providers: {
          'anthropic-oauth': {
            type: 'anthropic-oauth',
            family: 'anthropic-oauth',
            capabilities: { maxContext: 400_000 },
            models: ['claude-opus-4-8'],
          },
        },
      },
      provider,
      providerId: 'anthropic-oauth',
      modelId: 'claude-opus-4-8',
    });
    expect(max).toBe(400_000);
  });

  it('falls back to the family default when the model is not in the sibling catalog', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic-oauth',
        model: 'claude-unknown-9',
        providers: {
          'anthropic-oauth': {
            type: 'anthropic-oauth',
            family: 'anthropic-oauth',
            models: ['claude-unknown-9'],
          },
        },
      },
      provider,
      providerId: 'anthropic-oauth',
      modelId: 'claude-unknown-9',
    });
    expect(max).toBe(200_000);
  });
});

/**
 * Registry where `getModel` returns a model object WITHOUT a `maxContext`
 * (so `capabilitiesFor` does not take its "no model info" early return), and
 * whose raw catalog entry publishes only `limit.output` — no `limit.context`.
 * This is the exact shape that used to collapse the window: the resolver would
 * fall through `rawModel.limit.output` and report the 8k output ceiling as the
 * context window. After the fix it must fall through to the family default.
 */
function outputOnlyRegistry(): ModelsRegistry {
  return {
    async getProvider(id: string) {
      if (id !== 'openai') return undefined;
      return {
        family: 'openai',
        models: [{ id: 'gpt-broken', limit: { output: 8_192 } }],
      };
    },
    async getModel(providerId: string, modelId: string) {
      if (providerId !== 'openai' || modelId !== 'gpt-broken') return undefined;
      // Model exists (defeats the early return) but has no maxContext fact.
      return {
        capabilities: { tools: true, vision: false, reasoning: false },
      };
    },
  } as never as ModelsRegistry;
}

describe('resolveRuntimeMaxContext — limit.output must never become the context window', () => {
  it('falls through to the family default when only limit.output is published (not the 8k output ceiling)', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: outputOnlyRegistry(),
      config: {
        provider: 'openai',
        model: 'gpt-broken',
        providers: {
          openai: { type: 'openai', models: ['gpt-broken'] },
        },
      },
      // Family default the resolution must land on instead of limit.output.
      provider: { capabilities: { maxContext: 128_000 } } as never as Provider,
      providerId: 'openai',
      modelId: 'gpt-broken',
    });
    expect(max).toBe(128_000);
    expect(max).not.toBe(8_192);
  });

  it('still returns the real context window when limit.context is present alongside limit.output', async () => {
    const registry = {
      async getProvider(id: string) {
        if (id !== 'openai') return undefined;
        return {
          family: 'openai',
          models: [{ id: 'gpt-ok', limit: { context: 256_000, output: 8_192 } }],
        };
      },
      async getModel(providerId: string, modelId: string) {
        if (providerId !== 'openai' || modelId !== 'gpt-ok') return undefined;
        // Model exists without maxContext, so resolution consults the raw
        // catalog `limit.context` (256k) — never the 8k `limit.output`.
        return {
          capabilities: { tools: true, vision: false, reasoning: false },
        };
      },
    } as never as ModelsRegistry;

    const max = await resolveRuntimeMaxContext({
      modelsRegistry: registry,
      config: {
        provider: 'openai',
        model: 'gpt-ok',
        providers: { openai: { type: 'openai', models: ['gpt-ok'] } },
      },
      provider: { capabilities: { maxContext: 128_000 } } as never as Provider,
      providerId: 'openai',
      modelId: 'gpt-ok',
    });
    expect(max).toBe(256_000);
  });
});

describe('resolveRuntimeMaxContextDetailed — branch reporting for telemetry', () => {
  /**
   * REGRESSION: a single global `context.effectiveMaxContext` used to sit at the
   * TOP of the chain, so one stale 128k value silently pinned every model of
   * every provider — collapsing 1M-window models to 128k with nothing in the UI
   * naming the cause. The per-model catalog window must outrank it.
   */
  it('does NOT let a global effectiveMaxContext override the per-model catalog window', async () => {
    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: fakeRegistry(),
      config: { provider: 'openai', model: 'gpt-5.5', context: { effectiveMaxContext: 128_000 } },
      provider,
      providerId: 'openai',
      modelId: 'gpt-5.5',
    });
    expect(result).toEqual({ maxContext: 1_050_000, branch: 'catalog-capabilities' });
  });

  it('falls back to effectiveMaxContext only when the catalog knows no window', async () => {
    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'mystery',
        model: 'mystery-model',
        context: { effectiveMaxContext: 321_000 },
        providers: { mystery: { type: 'mystery', models: ['mystery-model'] } },
      },
      provider: { capabilities: { maxContext: 0 } } as never as Provider,
      providerId: 'mystery',
      modelId: 'mystery-model',
    });
    expect(result).toEqual({ maxContext: 321_000, branch: 'explicit-config-fallback' });
  });

  it('reports provider-override when a per-provider capabilities.maxContext is set', async () => {
    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'openai',
        model: 'gpt-4o',
        providers: {
          openai: { type: 'openai', capabilities: { maxContext: 64_000 } },
        },
      },
      provider,
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
    expect(result).toEqual({ maxContext: 64_000, branch: 'provider-override' });
  });

  it('reports sibling-capabilities for an OAuth family resolved via its catalog sibling', async () => {
    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic-oauth',
        model: 'claude-opus-4-8',
        providers: {
          'anthropic-oauth': {
            type: 'anthropic-oauth',
            family: 'anthropic-oauth',
            baseUrl: 'https://api.anthropic.com',
            models: ['claude-opus-4-8'],
          },
        },
      },
      provider,
      providerId: 'anthropic-oauth',
      modelId: 'claude-opus-4-8',
    });
    expect(result).toEqual({ maxContext: 1_000_000, branch: 'sibling-capabilities' });
  });

  it('reports catalog-capabilities for a plain catalog model', async () => {
    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        providers: { anthropic: { type: 'anthropic', models: ['claude-haiku-4-5'] } },
      },
      provider,
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
    });
    expect(result).toEqual({ maxContext: 200_000, branch: 'catalog-capabilities' });
  });

  it('reports family-default when the catalog yields no window and no baseUrl divergence', async () => {
    // An openai-compatible family has a 0 catalog baseline, so capabilitiesFor
    // returns nothing usable; with no diverging baseUrl the resolver falls
    // through to the provider's own capabilities.maxContext and labels it as
    // the family default.
    const registry = {
      async getProvider(id: string) {
        if (id !== 'local') return undefined;
        return { family: 'openai-compatible', models: [{ id: 'local-model', limit: {} }] };
      },
      async getModel() {
        return undefined;
      },
    } as never as ModelsRegistry;

    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: registry,
      config: {
        provider: 'local',
        model: 'local-model',
        providers: {
          local: { type: 'local', family: 'openai-compatible', models: ['local-model'] },
        },
      },
      // Family default the resolver must land on and label as such.
      provider: { capabilities: { maxContext: 48_000 } } as never as Provider,
      providerId: 'local',
      modelId: 'local-model',
    });
    expect(result).toEqual({ maxContext: 48_000, branch: 'family-default' });
  });

  it('reports diverging-baseurl-family-default when a proxy baseUrl suppresses the catalog', async () => {
    // Registry whose catalog provider advertises a canonical apiBase; the
    // configured baseUrl points elsewhere (a local proxy), so the catalog is
    // skipped and resolution falls to the family default — the exact silent
    // shrink telemetry must be able to flag.
    const registry = {
      async getProvider(id: string) {
        if (id !== 'openai') return undefined;
        return {
          family: 'openai',
          apiBase: 'https://api.openai.com/v1',
          models: [{ id: 'gpt-4o', limit: { context: 128_000 } }],
        };
      },
      async getModel() {
        return undefined;
      },
    } as never as ModelsRegistry;

    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: registry,
      config: {
        provider: 'openai',
        model: 'gpt-4o',
        providers: {
          openai: {
            type: 'openai',
            baseUrl: 'http://localhost:8080/v1',
            models: ['gpt-4o'],
          },
        },
      },
      provider: { capabilities: { maxContext: 32_000 } } as never as Provider,
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
    expect(result).toEqual({
      maxContext: 32_000,
      branch: 'diverging-baseurl-family-default',
    });
  });

  it('reports unknown when the window cannot be determined (family default is 0)', async () => {
    const result = await resolveRuntimeMaxContextDetailed({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'mystery',
        model: 'mystery-model',
        providers: { mystery: { type: 'mystery', models: ['mystery-model'] } },
      },
      provider: { capabilities: { maxContext: 0 } } as never as Provider,
      providerId: 'mystery',
      modelId: 'mystery-model',
    });
    expect(result).toEqual({ maxContext: 0, branch: 'unknown' });
  });

  it('resolveRuntimeMaxContext stays a value-only wrapper over the detailed resolver', async () => {
    const value = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'mystery',
        model: 'mystery-model',
        context: { effectiveMaxContext: 111_000 },
        providers: { mystery: { type: 'mystery', models: ['mystery-model'] } },
      },
      provider: { capabilities: { maxContext: 0 } } as never as Provider,
      providerId: 'mystery',
      modelId: 'mystery-model',
    });
    expect(value).toBe(111_000);
  });
});

describe('describeMaxContextChange — shrink telemetry decision', () => {
  it('escalates a family-default DECREASE to a warn with the shrink message', () => {
    const t = describeMaxContextChange({
      previous: 200_000,
      current: 8_192,
      providerId: 'openai',
      modelId: 'gpt-broken',
      branch: 'family-default',
    });
    expect(t).toBeDefined();
    expect(t?.level).toBe('warn');
    expect(t?.shrank).toBe(true);
    expect(t?.message).toContain('Context window shrank via a non-catalog branch');
    expect(t?.message).toContain('200000 → 8192');
    expect(t?.message).toContain('branch=family-default');
    expect(t?.message).toContain('DECREASED');
  });

  it('escalates a diverging-baseurl-family-default DECREASE to a warn', () => {
    const t = describeMaxContextChange({
      previous: 200_000,
      current: 32_000,
      providerId: 'openai',
      modelId: 'gpt-4o',
      branch: 'diverging-baseurl-family-default',
    });
    expect(t?.level).toBe('warn');
    expect(t?.message).toContain('Context window shrank via a non-catalog branch');
    expect(t?.message).toContain('branch=diverging-baseurl-family-default');
  });

  it('keeps a catalog-capabilities decrease at debug (authoritative, not suspicious)', () => {
    const t = describeMaxContextChange({
      previous: 1_000_000,
      current: 200_000,
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      branch: 'catalog-capabilities',
    });
    expect(t?.level).toBe('debug');
    expect(t?.shrank).toBe(true);
    expect(t?.message).not.toContain('Context window shrank');
  });

  it('keeps an intentional model switch (branch-less, unknown) at debug even when smaller', () => {
    const t = describeMaxContextChange({
      previous: 200_000,
      current: 128_000,
      providerId: 'openai',
      modelId: 'gpt-4o',
      // No branch supplied — the onModelContextResolved external caller path.
    });
    expect(t?.branch).toBe('unknown');
    expect(t?.level).toBe('debug');
  });

  it('keeps an INCREASE at debug regardless of branch', () => {
    const t = describeMaxContextChange({
      previous: 32_000,
      current: 200_000,
      providerId: 'openai',
      modelId: 'gpt-4o',
      branch: 'family-default',
    });
    expect(t?.shrank).toBe(false);
    expect(t?.level).toBe('debug');
  });

  it('returns undefined (nothing to log) when the value did not change', () => {
    const t = describeMaxContextChange({
      previous: 200_000,
      current: 200_000,
      providerId: 'openai',
      modelId: 'gpt-4o',
      branch: 'family-default',
    });
    expect(t).toBeUndefined();
  });

  it('dispatches to the matching logger level — spy proves warn is called for a family-default shrink', () => {
    // Mirrors applyMaxContext's `logger[telemetry.level](telemetry.message)`
    // dispatch to prove the shrink surfaces end-to-end through the logger.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const telemetry = describeMaxContextChange({
      previous: 200_000,
      current: 8_192,
      providerId: 'openai',
      modelId: 'gpt-broken',
      branch: 'family-default',
    });
    if (telemetry) logger[telemetry.level](telemetry.message);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Context window shrank via a non-catalog branch'),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('dispatches to debug (not warn) for a catalog-branch shrink', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const telemetry = describeMaxContextChange({
      previous: 1_000_000,
      current: 200_000,
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      branch: 'catalog-capabilities',
    });
    if (telemetry) logger[telemetry.level](telemetry.message);

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('refreshRuntimeModelCatalog', () => {
  it('refreshes the models registry before runtime max-context re-resolution', async () => {
    const registry = {
      refresh: vi.fn(async () => ({})),
    } as never as ModelsRegistry;
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await expect(
      refreshRuntimeModelCatalog({ modelsRegistry: registry, logger, reason: 'zai/glm-5.2' }),
    ).resolves.toBe(true);

    expect(registry.refresh).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to cached catalog when refresh fails', async () => {
    const registry = {
      refresh: vi.fn(async () => {
        throw new Error('offline');
      }),
    } as never as ModelsRegistry;
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await expect(
      refreshRuntimeModelCatalog({ modelsRegistry: registry, logger, reason: 'zai/glm-5.2' }),
    ).resolves.toBe(false);

    expect(registry.refresh).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('using cached catalog'));
  });
});
