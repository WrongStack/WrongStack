import type { ResolvedProvider } from '@wrongstack/core/types';
import {
  handleProviderRoute,
  type ProviderRouteHandlers,
} from '../src/server/provider-routes.js';
import {
  resolveProviderCatalogForModels,
  resolveProviderModelMetadata,
} from '../src/server/model-catalog.js';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

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
    searchProviderModels: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    refineModel: vi.fn(async () => undefined),
    fallbackChoice: vi.fn(async () => undefined),
    adoptDefaultProviderIfUnset: vi.fn(async () => undefined),
    providerHandlers: {
      loadConfigProviders: vi.fn(async () => ({})),
      handleKeyUpsert: vi.fn(async () => undefined),
      handleKeyDelete: vi.fn(async () => undefined),
      handleKeySetActive: vi.fn(async () => undefined),
      handleProviderAdd: vi.fn(async () => undefined),
      handleProviderRemove: vi.fn(async () => undefined),
      handleProviderClearModels: vi.fn(async () => undefined),
      handleCustomModelSet: vi.fn(async () => undefined),
      handleCustomModelRemove: vi.fn(async () => undefined),
      handleProviderUndoClear: vi.fn(async () => undefined),
      handleProviderUpdate: vi.fn(async () => undefined),
      handleProviderProbe: vi.fn(async () => undefined),
      handleOAuthStart: vi.fn(async () => undefined),
      handleOAuthCode: vi.fn(async () => undefined),
      handleOAuthCancel: vi.fn(),
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
    ['provider.models.search', { query: '', limit: 8 }],
    ['provider.models.search', { query: 'claude', limit: 0 }],
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
      deps.providerHandlers.handleCustomModelSet,
      deps.providerHandlers.handleCustomModelRemove,
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

  it('copies validated custom model capabilities before dispatching provider.add', async () => {
    const ws = mockWs();
    const deps = routes();
    const capabilities = { tools: true, maxContext: 131_072 };

    await expect(
      handleProviderRoute(
        ws,
        {
          type: 'provider.add',
          payload: {
            id: 'custom',
            family: 'openai-compatible',
            customModels: {
              'custom/model': { name: 'Custom Model', capabilities },
            },
          },
        },
        deps,
      ),
    ).resolves.toBe(true);

    const dispatched = vi.mocked(deps.providerHandlers.handleProviderAdd).mock.calls.at(0)?.[1];
    const copiedCapabilities = dispatched?.customModels?.['custom/model']?.capabilities;
    expect(copiedCapabilities).toEqual(capabilities);
    expect(copiedCapabilities).not.toBe(capabilities);

    capabilities.tools = false;
    expect(copiedCapabilities?.tools).toBe(true);
  });

  it('preserves validated modelsDev metadata before dispatching provider.add', async () => {
    const ws = mockWs();
    const deps = routes();
    const modelsDev = { name: 'Custom Model', limit: { context: 131_072, output: 4096 } };

    await expect(
      handleProviderRoute(
        ws,
        {
          type: 'provider.add',
          payload: {
            id: 'custom',
            family: 'openai-compatible',
            customModels: {
              'custom/model': { modelsDev },
            },
          },
        },
        deps,
      ),
    ).resolves.toBe(true);

    const dispatched = vi.mocked(deps.providerHandlers.handleProviderAdd).mock.calls.at(0)?.[1];
    expect(dispatched?.customModels?.['custom/model']?.modelsDev).toEqual(modelsDev);
  });

  it.each([
    [
      'provider.add',
      {
        id: 'custom',
        family: 'openai-compatible',
        customModels: { 'custom/model': { modelsDev: { limit: { context: 131_072 } } } },
      },
      'handleProviderAdd',
    ],
    [
      'provider.update',
      {
        id: 'custom',
        customModels: { 'custom/model': { modelsDev: 'not-an-object' } },
      },
      'handleProviderUpdate',
    ],
    [
      'provider.custom_models.set',
      {
        providerId: 'custom',
        modelId: 'custom/model',
        customModel: { modelsDev: { name: '' } },
      },
      'handleCustomModelSet',
    ],
    [
      'provider.custom_models.set',
      {
        providerId: '__proto__',
        modelId: 'custom/model',
        customModel: { name: 'Prototype Pollution' },
      },
      'handleCustomModelSet',
    ],
    [
      'provider.custom_models.remove',
      { providerId: 'custom', modelId: '__proto__' },
      'handleCustomModelRemove',
    ],
    [
      'provider.custom_models.remove',
      { providerId: '__proto__', modelId: 'custom/model' },
      'handleCustomModelRemove',
    ],
    [
      'provider.add',
      { id: '__proto__', family: 'openai-compatible' },
      'handleProviderAdd',
    ],
    [
      'provider.add',
      { id: 'constructor', family: 'openai-compatible' },
      'handleProviderAdd',
    ],
    [
      'provider.update',
      { id: '__proto__', models: ['x'] },
      'handleProviderUpdate',
    ],
    [
      'provider.update',
      { id: 'prototype' },
      'handleProviderUpdate',
    ],
    [
      'key.add',
      { providerId: '__proto__', label: 'main', apiKey: 'sk-test' },
      'handleKeyUpsert',
    ],
    [
      'key.update',
      { providerId: 'constructor', label: 'main', apiKey: 'sk-test' },
      'handleKeyUpsert',
    ],
    [
      'key.delete',
      { providerId: '__proto__', label: 'main' },
      'handleKeyDelete',
    ],
    [
      'key.set_active',
      { providerId: '__proto__', label: 'main' },
      'handleKeySetActive',
    ],
    [
      'provider.remove',
      { providerId: '__proto__' },
      'handleProviderRemove',
    ],
    [
      'provider.clear_models',
      { providerId: 'constructor' },
      'handleProviderClearModels',
    ],
    [
      'provider.undo_clear',
      { providerId: '__proto__', previousModels: [] },
      'handleProviderUndoClear',
    ],
    [
      'provider.probe',
      { providerId: '__proto__' },
      'handleProviderProbe',
    ],
  ])('rejects malformed %s payloads before dispatch', async (type, payload, handlerName) => {
    const ws = mockWs();
    const deps = routes();

    await expect(handleProviderRoute(ws, { type, payload }, deps)).resolves.toBe(true);

    expect(sentMessages(ws)).toEqual([
      {
        type: 'key.operation_result',
        payload: { success: false, message: `${type} payload is invalid` },
      },
    ]);
    expect(
      deps.providerHandlers[handlerName as keyof typeof deps.providerHandlers],
    ).not.toHaveBeenCalled();
  });

  it('adopts the default provider only after a successful provider.add', async () => {
    const ws = mockWs();
    const deps = routes();
    vi.mocked(deps.providerHandlers.handleProviderAdd).mockResolvedValue(true);

    await expect(
      handleProviderRoute(
        ws,
        { type: 'provider.add', payload: { id: 'custom', family: 'openai-compatible' } },
        deps,
      ),
    ).resolves.toBe(true);

    expect(deps.adoptDefaultProviderIfUnset).toHaveBeenCalledWith('custom');
  });

  it('skips default adoption when provider.add fails', async () => {
    const ws = mockWs();
    const deps = routes();
    vi.mocked(deps.providerHandlers.handleProviderAdd).mockResolvedValue(false);

    await expect(
      handleProviderRoute(
        ws,
        { type: 'provider.add', payload: { id: 'custom', family: 'openai-compatible' } },
        deps,
      ),
    ).resolves.toBe(true);

    expect(deps.adoptDefaultProviderIfUnset).not.toHaveBeenCalled();
  });

  it('dispatches validated custom model definitions to provider.custom_models.set', async () => {
    const ws = mockWs();
    const deps = routes();
    const customModel = {
      name: 'Custom Model',
      modelsDev: { name: 'Custom Model', limit: { context: 131_072 } },
    };

    await expect(
      handleProviderRoute(
        ws,
        {
          type: 'provider.custom_models.set',
          payload: { providerId: 'custom', modelId: 'custom/model', customModel },
        },
        deps,
      ),
    ).resolves.toBe(true);

    expect(deps.providerHandlers.handleCustomModelSet).toHaveBeenCalledWith(
      ws,
      'custom',
      'custom/model',
      customModel,
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('dispatches valid provider model searches with the optional result limit', async () => {
    const ws = mockWs();
    const deps = routes();

    await expect(
      handleProviderRoute(
        ws,
        { type: 'provider.models.search', payload: { query: 'claude', limit: 5 } },
        deps,
      ),
    ).resolves.toBe(true);

    expect(deps.searchProviderModels).toHaveBeenCalledWith(ws, 'claude', 5);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('preserves the optional custom provider id for OAuth login', async () => {
    const ws = mockWs();
    const deps = routes();

    await expect(
      handleProviderRoute(
        ws,
        { type: 'auth.oauth.start', payload: { kind: 'chatgpt', providerId: 'custom-openai' } },
        deps,
      ),
    ).resolves.toBe(true);

    expect(deps.providerHandlers.handleOAuthStart).toHaveBeenCalledWith(
      ws,
      'chatgpt',
      'custom-openai',
    );
  });

  it('dispatches model.fallback_choice to the fallbackChoice handler', async () => {
    const ws = mockWs();
    const deps = routes();

    await expect(
      handleProviderRoute(
        ws,
        {
          type: 'model.fallback_choice',
          payload: { requestId: 'req-1', providerId: 'anthropic', model: 'claude-x' },
        },
        deps,
      ),
    ).resolves.toBe(true);

    expect(deps.fallbackChoice).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ type: 'model.fallback_choice' }),
    );
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

describe('provider.audit.get — durable audit trail route', () => {
  it('tails the audit JSONL, newest first, honoring count', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'wstack-routes-audit-'));
    try {
      const auditFile = join(home, 'provider-status-audit.jsonl');
      writeFileSync(
        auditFile,
        `${JSON.stringify({ ts: 1, providerId: 'a', model: 'm1', from: 'healthy', to: 'blocked', reason: 'r1', expiresAt: 9, error: { kind: 'rate_limit', status: 429, message: 'm', sessionId: 's', agentId: 'g' } })}\n` +
          `${JSON.stringify({ ts: 2, providerId: 'a', model: 'm2', from: 'blocked', to: 'healthy', reason: 'r2', expiresAt: null, error: null })}\n`,
      );
      const ws = mockWs();
      const deps = routes();
      deps.providerAuditFile = auditFile;

      await handleProviderRoute(ws, { type: 'provider.audit.get', payload: { count: 1 } }, deps);

      const frames = ws.send.mock.calls.map(
        ([raw]) => JSON.parse(String(raw)) as { type: string; payload: { lines: Array<Record<string, unknown>> } },
      );
      const frame = frames.find((f) => f.type === 'provider.audit.history');
      expect(frame?.payload.lines).toHaveLength(1);
      expect(frame?.payload.lines[0]).toMatchObject({ providerId: 'a', model: 'm2' });
    } finally {
      const { rmSync } = await import('node:fs');
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('answers with empty lines when no audit file is wired', async () => {
    const ws = mockWs();
    const deps = routes();

    await handleProviderRoute(ws, { type: 'provider.audit.get' }, deps);

    const frames = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
    expect(frames.at(-1)).toMatchObject({
      type: 'provider.audit.history',
      payload: { lines: [] },
    });
  });
});
