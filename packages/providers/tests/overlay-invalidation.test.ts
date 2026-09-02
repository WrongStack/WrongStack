import { DefaultModelsRegistry } from '@wrongstack/core/models';
import type { ModelsDevPayload } from '@wrongstack/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../src/capabilities.js';
import {
  clearModelOutputLimitResolver,
  installCatalogModelOutputLimits,
  resolveMaxOutputTokens,
} from '../src/model-output-limits.js';
import { capabilitiesForFamily } from '../src/family-capabilities.js';

/**
 * Runtime-discovered models reach the catalog through `mergeOverlay`. Two
 * caches are built from that catalog and were only ever invalidated by
 * `refresh()`, so anything resolved before discovery landed stayed pinned to
 * a pre-discovery answer.
 */

const BASE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    models: {},
  },
} as never as ModelsDevPayload;

const DISCOVERED: ModelsDevPayload = {
  'ai-gateway': {
    id: 'ai-gateway',
    name: 'Vercel AI Gateway',
    env: ['AI_GATEWAY_API_KEY'],
    npm: '@ai-sdk/gateway',
    models: {
      'anthropic/claude-sonnet-5': {
        id: 'anthropic/claude-sonnet-5',
        name: 'Claude Sonnet 5',
        tool_call: true,
        limit: { context: 1_000_000, output: 128_000 },
      },
    },
  },
} as never as ModelsDevPayload;

function registryWith(payload: ModelsDevPayload): DefaultModelsRegistry {
  return new DefaultModelsRegistry({ seed: payload } as never);
}

describe('mergeOverlay invalidates caches built from the catalog', () => {
  afterEach(() => clearModelOutputLimitResolver());

  it('does not pin a capability answer resolved before discovery landed', async () => {
    const registry = registryWith(BASE);

    // Something touches capabilities BEFORE the key-driven discovery lands —
    // the catalog knows nothing, so this caches the bare baseline.
    const before = await capabilitiesFor(registry, 'ai-gateway', 'anthropic/claude-sonnet-5');
    expect(before.maxContext).toBe(0);

    registry.mergeOverlay(DISCOVERED);

    const after = await capabilitiesFor(registry, 'ai-gateway', 'anthropic/claude-sonnet-5');
    expect(after.maxContext).toBe(1_000_000);
    expect(after.maxOutput).toBe(128_000);
  });

  it('feeds a discovered model output ceiling into the per-request index', async () => {
    const registry = registryWith(BASE);
    await installCatalogModelOutputLimits({ registry, getConfig: () => undefined as never });

    const ctx = {
      capabilities: capabilitiesForFamily('openai-compatible'),
      providerId: 'ai-gateway',
    };
    expect(resolveMaxOutputTokens({ model: 'anthropic/claude-sonnet-5' }, ctx)).toBeUndefined();

    registry.mergeOverlay(DISCOVERED);

    // Without the overlay hook this stays undefined and the adapter falls
    // through to the 8192 last resort.
    expect(resolveMaxOutputTokens({ model: 'anthropic/claude-sonnet-5' }, ctx)).toBe(128_000);
  });
});
