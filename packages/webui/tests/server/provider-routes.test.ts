import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedProvider } from '@wrongstack/core/types';
import { handleProviderRoute, type ProviderRouteHandlers } from '@wrongstack/webui-server';
import {
  resolveProviderCatalogForModels,
  resolveProviderModelMetadata,
} from '@wrongstack/webui-server';

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: ReturnType<typeof mockWs>) {
  return ws.send.mock.calls.map(
    ([raw]) =>
      JSON.parse(String(raw)) as { type: string; payload: { success?: boolean; message?: string } },
  );
}

function provider(id: string, modelIds: string[]): ResolvedProvider {
  return {
    id,
    name: id,
    family: 'openai-compatible',
    envVars: [],
    models: modelIds.map((modelId) => ({ id: modelId, name: modelId })),
  };
}

function routes(): ProviderRouteHandlers {
  return {
    listProviders: vi.fn(async () => undefined),
    listSavedProviders: vi.fn(async () => undefined),
    listProviderModels: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    refineModel: vi.fn(async () => undefined),
    fallbackChoice: vi.fn(async () => undefined),
    searchProviderModels: vi.fn(async () => undefined),
    adoptDefaultProviderIfUnset: vi.fn(async () => undefined),
    providerHandlers: {
      loadConfigProviders: vi.fn(async () => ({})),
      handleKeyUpsert: vi.fn(async () => undefined),
      handleKeyDelete: vi.fn(async () => undefined),
      handleKeySetActive: vi.fn(async () => undefined),
      handleProviderAdd: vi.fn(async () => undefined),
      handleProviderRemove: vi.fn(async () => undefined),
      handleProviderClearModels: vi.fn(async () => undefined),
      handleProviderUndoClear: vi.fn(async () => undefined),
      handleProviderUpdate: vi.fn(async () => undefined),
      handleProviderProbe: vi.fn(async () => undefined),
    } as never as ProviderRouteHandlers['providerHandlers'],
  };
}

describe('handleProviderRoute malformed payload characterization', () => {
  it('returns false and does not send for non-provider message types', async () => {
    const ws = mockWs();
    const deps = routes();

    await expect(
      handleProviderRoute(ws, { type: 'sessions.list', payload: {} }, deps),
    ).resolves.toBe(false);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each([
    ['key.add', {}],
    ['key.update', { providerId: 'anthropic', label: 'main' }],
    ['key.delete', { providerId: 'anthropic' }],
    ['key.set_active', { providerId: 'anthropic', label: '' }],
    ['provider.add', { id: 'custom' }],
    ['provider.remove', { providerId: 123 }],
    ['provider.clear_models', null],
    ['provider.undo_clear', { providerId: 'custom', previousModels: [123] }],
    ['provider.update', { id: 'custom', models: 'claude' }],
    ['provider.probe', { providerId: 'custom', timeoutMs: Number.NaN }],
  ])('handles malformed %s payload without invoking provider handlers', async (type, payload) => {
    const ws = mockWs();
    const deps = routes();

    await expect(handleProviderRoute(ws, { type, payload }, deps)).resolves.toBe(true);

    expect(sentMessages(ws)).toEqual([
      {
        type: 'key.operation_result',
        payload: { success: false, message: `${type} payload is invalid` },
      },
    ]);
    for (const handler of [
      deps.providerHandlers.handleKeyUpsert,
      deps.providerHandlers.handleKeyDelete,
      deps.providerHandlers.handleKeySetActive,
      deps.providerHandlers.handleProviderAdd,
      deps.providerHandlers.handleProviderRemove,
      deps.providerHandlers.handleProviderClearModels,
      deps.providerHandlers.handleProviderUndoClear,
      deps.providerHandlers.handleProviderUpdate,
      deps.providerHandlers.handleProviderProbe,
    ]) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('dispatches valid provider.remove payloads to the provider handler', async () => {
    const ws = mockWs();
    const deps = routes();

    await expect(
      handleProviderRoute(ws, { type: 'provider.remove', payload: { providerId: 'custom' } }, deps),
    ).resolves.toBe(true);

    expect(deps.providerHandlers.handleProviderRemove).toHaveBeenCalledWith(ws, 'custom');
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('resolveProviderCatalogForModels', () => {
  it('prefers provider-specific catalogs over generic wire type catalogs', async () => {
    const getProvider = vi.fn(async (id: string) => {
      if (id === 'omniroute') return provider('omniroute', ['omni/large', 'omni/small']);
      if (id === 'openai-compatible') return provider('openai-compatible', ['generic']);
      return undefined;
    });

    const resolved = await resolveProviderCatalogForModels({ getProvider }, 'omniroute', {
      type: 'openai-compatible',
    });

    expect(resolved?.id).toBe('omniroute');
    expect(resolved?.models.map((m) => m.id)).toEqual(['omni/large', 'omni/small']);
    expect(getProvider).toHaveBeenCalledTimes(1);
    expect(getProvider).toHaveBeenCalledWith('omniroute');
  });

  it('falls back to the provider type when no provider-specific catalog exists', async () => {
    const getProvider = vi.fn(async (id: string) => {
      if (id === 'openai-compatible') return provider('openai-compatible', ['generic']);
      return undefined;
    });

    const resolved = await resolveProviderCatalogForModels({ getProvider }, 'custom-gateway', {
      type: 'openai-compatible',
    });

    expect(resolved?.id).toBe('openai-compatible');
    expect(resolved?.models.map((m) => m.id)).toEqual(['generic']);
    expect(getProvider).toHaveBeenNthCalledWith(1, 'custom-gateway');
    expect(getProvider).toHaveBeenNthCalledWith(2, 'openai-compatible');
  });
});

describe('resolveProviderModelMetadata', () => {
  it('prefers provider-specific discovered metadata for context windows', async () => {
    const getModel = vi.fn(async (providerId: string, modelId: string) => {
      if (providerId === 'omniroute' && modelId === 'omni/large') {
        return {
          providerId,
          modelId,
          capabilities: { tools: true, vision: false, reasoning: true, maxContext: 262144 },
          cost: { input: 1, output: 2 },
        };
      }
      if (providerId === 'openai-compatible' && modelId === 'omni/large') {
        return {
          providerId,
          modelId,
          capabilities: { tools: false, vision: false, reasoning: false, maxContext: 4096 },
        };
      }
      return undefined;
    });

    const resolved = await resolveProviderModelMetadata({ getModel }, 'omniroute', 'omni/large', {
      type: 'openai-compatible',
    });

    expect(resolved?.providerId).toBe('omniroute');
    expect(resolved?.capabilities.maxContext).toBe(262144);
    expect(getModel).toHaveBeenCalledTimes(1);
    expect(getModel).toHaveBeenCalledWith('omniroute', 'omni/large');
  });

  it('falls back to type metadata when the saved provider has no model hit', async () => {
    const getModel = vi.fn(async (providerId: string, modelId: string) => {
      if (providerId === 'openai-compatible' && modelId === 'generic') {
        return {
          providerId,
          modelId,
          capabilities: { tools: false, vision: false, reasoning: false, maxContext: 8192 },
        };
      }
      return undefined;
    });

    const resolved = await resolveProviderModelMetadata({ getModel }, 'custom-gateway', 'generic', {
      type: 'openai-compatible',
    });

    expect(resolved?.providerId).toBe('openai-compatible');
    expect(resolved?.capabilities.maxContext).toBe(8192);
    expect(getModel).toHaveBeenNthCalledWith(1, 'custom-gateway', 'generic');
    expect(getModel).toHaveBeenNthCalledWith(2, 'openai-compatible', 'generic');
  });
});
