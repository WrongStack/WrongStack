import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultModelsRegistry } from '@wrongstack/core/models';
import type { Capabilities, Config, ModelsDevPayload } from '@wrongstack/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesForFamily } from '../src/family-capabilities.js';
import {
  clearModelOutputLimitResolver,
  REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT,
  installCatalogModelOutputLimits,
  resolveMaxOutputTokens,
  resolveRequiredMaxOutputTokens,
  setModelOutputLimitResolver,
} from '../src/model-output-limits.js';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    models: {
      'big-output': {
        id: 'big-output',
        name: 'Big Output',
        limit: { context: 200_000, output: 64_000 },
      },
      'small-output': {
        id: 'small-output',
        name: 'Small Output',
        limit: { context: 200_000, output: 4_096 },
      },
      'no-limit': { id: 'no-limit', name: 'No Limit' },
    },
  },
};

function registry(): DefaultModelsRegistry {
  return new DefaultModelsRegistry({
    cacheFile: path.join(os.tmpdir(), `wstack-mol-${process.pid}-${Math.random()}.json`),
    seed: SAMPLE,
  });
}

function ctx(overrides: Partial<Capabilities> = {}, providerId = 'anthropic') {
  return { capabilities: capabilitiesForFamily('anthropic', overrides), providerId };
}

function config(partial: Partial<Config>): Config {
  return partial as Config;
}

afterEach(() => {
  clearModelOutputLimitResolver();
});

describe('resolveMaxOutputTokens', () => {
  it('returns undefined when nothing knows, so optional fields can be omitted', () => {
    // The whole point: no invented number. Adapters on a wire format where the
    // cap is optional omit the field entirely and let the backend apply the
    // model's own ceiling.
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBeUndefined();
  });

  it('substitutes the last resort ONLY where the wire format requires the field', () => {
    // Anthropic Messages rejects a request without `max_tokens`, so this one
    // variant has to produce a number even when nothing knows.
    expect(resolveRequiredMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(
      REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT,
    );
  });

  it('prefers a real source over the last resort in the required variant too', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    expect(resolveRequiredMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(64_000);
  });

  it('uses the capability overlay when no resolver is installed', () => {
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx({ maxOutput: 32_000 }))).toBe(
      32_000,
    );
  });

  it('prefers an explicit req.maxTokens over every other source', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    expect(
      resolveMaxOutputTokens({ model: 'big-output', maxTokens: 512 }, ctx({ maxOutput: 32_000 })),
    ).toBe(512);
  });

  it('prefers the catalog entry for req.model over stale provider capabilities', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    // The session booted on `big-output` (64k) and switched to `small-output`.
    // The provider instance still carries the old ceiling; the wire must not.
    expect(resolveMaxOutputTokens({ model: 'small-output' }, ctx({ maxOutput: 64_000 }))).toBe(
      4_096,
    );
  });

  it('resolves the real ceiling when the provider carries no maxOutput at all', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(64_000);
  });

  it('skips the catalog when the adapter did not supply a provider id', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    expect(
      resolveMaxOutputTokens(
        { model: 'big-output' },
        { capabilities: capabilitiesForFamily('anthropic') },
      ),
    ).toBeUndefined();
  });

  it('falls through to capabilities for a model with no catalog limit', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    expect(resolveMaxOutputTokens({ model: 'no-limit' }, ctx({ maxOutput: 16_000 }))).toBe(16_000);
  });

  it('never throws when the installed resolver does', () => {
    setModelOutputLimitResolver(() => {
      throw new Error('boom');
    });
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx({ maxOutput: 20_000 }))).toBe(
      20_000,
    );
  });

  it('ignores non-positive and non-finite values from every source', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    expect(
      resolveMaxOutputTokens({ model: 'no-limit', maxTokens: 0 }, ctx({ maxOutput: -5 })),
    ).toBeUndefined();
  });
});

describe('installCatalogModelOutputLimits config overrides', () => {
  it('honours a customModels top-level maxOutput', async () => {
    await installCatalogModelOutputLimits({
      registry: registry(),
      getConfig: () =>
        config({
          providers: {
            anthropic: { type: 'anthropic', customModels: { 'big-output': { maxOutput: 12_000 } } },
          },
        }),
    });
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(12_000);
  });

  it('honours a customModels capabilities.maxOutput', async () => {
    await installCatalogModelOutputLimits({
      registry: registry(),
      getConfig: () =>
        config({
          providers: {
            anthropic: {
              type: 'anthropic',
              customModels: { 'big-output': { capabilities: { maxOutput: 9_000 } } },
            },
          },
        }),
    });
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(9_000);
  });

  it('honours a provider-wide capabilities override', async () => {
    await installCatalogModelOutputLimits({
      registry: registry(),
      getConfig: () =>
        config({
          providers: { anthropic: { type: 'anthropic', capabilities: { maxOutput: 7_000 } } },
        }),
    });
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(7_000);
  });

  it('reads config live, so a mid-session override takes effect', async () => {
    let maxOutput: number | undefined;
    await installCatalogModelOutputLimits({
      registry: registry(),
      getConfig: () =>
        config({
          providers: {
            anthropic: { type: 'anthropic', customModels: { 'big-output': { maxOutput } } },
          },
        }),
    });
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(64_000);
    maxOutput = 1_234;
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(1_234);
  });

  it('resolves a saved-config alias through its `type` catalog entry', async () => {
    await installCatalogModelOutputLimits({
      registry: registry(),
      getConfig: () => config({ providers: { 'my-alias': { type: 'anthropic' } } }),
    });
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx({}, 'my-alias'))).toBe(64_000);
  });

  it('resolves an OAuth provider through its sibling catalog', async () => {
    await installCatalogModelOutputLimits({ registry: registry() });
    // `anthropic-oauth` is absent from models.dev; its models live under
    // `anthropic`.
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx({}, 'anthropic-oauth'))).toBe(
      64_000,
    );
  });

  it('leaves the resolver usable when the catalog cannot be loaded', async () => {
    const broken = {
      load: async () => {
        throw new Error('offline');
      },
      refresh: async () => {
        throw new Error('offline');
      },
      listProviders: async () => [],
      getProvider: async () => undefined,
      getModel: async () => undefined,
      suggestModel: async () => undefined,
      ageSeconds: async () => Number.POSITIVE_INFINITY,
    };
    const messages: string[] = [];
    await installCatalogModelOutputLimits({
      registry: broken,
      getConfig: () =>
        config({
          providers: {
            anthropic: { type: 'anthropic', customModels: { 'big-output': { maxOutput: 3_000 } } },
          },
        }),
      log: (m) => messages.push(m),
    });
    expect(messages.join('\n')).toContain('offline');
    // Config overrides still resolve; unknown models degrade to capabilities.
    expect(resolveMaxOutputTokens({ model: 'big-output' }, ctx())).toBe(3_000);
    expect(resolveMaxOutputTokens({ model: 'small-output' }, ctx({ maxOutput: 5_000 }))).toBe(
      5_000,
    );
  });
});
