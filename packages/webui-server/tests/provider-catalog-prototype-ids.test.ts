/**
 * `provider.models` resolves a client-supplied provider id through two plain
 * object lookups: the saved record and `SIBLING_CATALOG`. Both must be OWN-key
 * reads — an inherited `Object.prototype` member (`toString`, `constructor`,
 * `valueOf`, `__proto__`) is truthy, so a bare bracket lookup hands it to
 * `modelsRegistry.getProvider()` as if it were a provider id and a provider
 * config, and can surface another provider's models under the requested id.
 *
 * Route-level validation does not cover this: `requiredString` accepts any
 * non-empty string, so a prototype key arrives as a perfectly legal payload.
 */
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createCatalogHandlers } from '../src/server/provider/catalog.js';
import { createProviderServiceContext } from '../src/server/provider/mutations.js';

const WS = {} as WebSocket;

/** One catalog handler wired to a registry that records every id it is asked for. */
function harness(saved: Record<string, ProviderConfig> = {}) {
  const registryIds: unknown[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const modelsRegistry = {
    getProvider: async (id: string) => {
      registryIds.push(id);
      return id === 'anthropic' || id === 'openai'
        ? {
            id,
            name: id,
            family: 'anthropic',
            envVars: [],
            models: [{ id: `${id}-model`, name: `${id}-model` }],
          }
        : undefined;
    },
    getModel: async () => undefined,
    listProviders: async () => [],
  };
  const ctx = createProviderServiceContext({
    providerStore: { load: async () => saved, save: async () => undefined },
    broadcast: () => undefined,
    send: (_ws, message) => frames.push(message as unknown as Record<string, unknown>),
    modelsRegistry: modelsRegistry as never,
  });
  return { handlers: createCatalogHandlers(ctx), registryIds, frames };
}

describe('provider.models with an Object.prototype key as the provider id', () => {
  it.each(['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'never hands the models registry a non-string id for "%s"',
    async (providerId) => {
      const { handlers, registryIds, frames } = harness();
      await handlers.handleProviderModels(WS, providerId as never);

      // The registry contract is `getProvider(id: string)`. An inherited member
      // read through a bracket lookup arrives as a function or object.
      expect(registryIds.filter((id) => typeof id !== 'string')).toEqual([]);
      // And a bogus id must not be answered with a real provider's model list.
      for (const frame of frames) {
        if (frame.type !== 'provider.models') continue;
        const payload = frame.payload as { provider: string; models: Array<{ id: string }> };
        expect(payload.provider).toBe(providerId);
        expect(payload.models.map((model) => model.id)).not.toContain('anthropic-model');
        expect(payload.models.map((model) => model.id)).not.toContain('openai-model');
      }
    },
  );

  it('keeps a legitimate sibling-catalog alias resolving to its parent catalog', async () => {
    // Control for the guard above: `anthropic-oauth` really is a SIBLING_CATALOG
    // key, so the parent catalog must still be consulted — own-key reads only
    // reject inherited members, not the documented aliases.
    const { handlers, registryIds } = harness();
    await handlers.handleProviderModels(WS, 'anthropic-oauth');
    expect(registryIds).toContain('anthropic');
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'rejects "%s" in provider CRUD handlers without mutating Object.prototype',
    async (providerId) => {
      const { createProviderCrudHandlers } = await import('../src/server/provider/keys.js');
      const frames: Array<Record<string, unknown>> = [];
      const ctx = createProviderServiceContext({
        providerStore: { load: async () => ({}), save: async () => undefined },
        broadcast: () => undefined,
        send: (_ws, message) => frames.push(message as unknown as Record<string, unknown>),
      });
      const crud = createProviderCrudHandlers(ctx);
      await crud.handleProviderClearModels(WS, providerId);
      await crud.handleProviderUndoClear(WS, providerId, ['m1']);
      await crud.handleProviderUpdate(WS, { id: providerId, models: ['m1'] });

      expect(({} as { models?: unknown }).models).toBeUndefined();
      expect(
        frames.every((f) => (f.payload as { success?: boolean } | undefined)?.success === false),
      ).toBe(true);
    },
  );
});
