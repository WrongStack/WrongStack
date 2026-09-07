import type { ProviderConfig } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createKeyHandlers, createProviderCrudHandlers } from '../src/server/provider/keys.js';
import type { ProviderServiceContext } from '../src/server/provider/mutations.js';
import { createProbeHandlers } from '../src/server/provider/probe.js';
import { probeModelDescriptors, projectSavedProviders } from '../src/server/provider/projection.js';

// Mock validateProviderBaseUrl
vi.mock('@wrongstack/core/tools', () => ({
  validateProviderBaseUrl: vi.fn(async (url: string) => {
    if (url.includes('evil.com') || url.includes('invalid')) {
      return 'Disallowed base URL';
    }
    return undefined;
  }),
}));

// Mock probeLocalLlm
vi.mock('@wrongstack/runtime/probe', () => ({
  probeLocalLlm: vi.fn(async (opts: { baseUrl: string; apiKey?: string; timeoutMs?: number }) => {
    if (opts.baseUrl.includes('unreachable')) {
      return { ok: false, status: 'unreachable', detail: 'Connection refused' };
    }
    if (opts.baseUrl.includes('empty')) {
      return { ok: true, status: 'ok', modelIds: [] };
    }
    return { ok: true, status: 'ok', modelIds: ['model-1', 'model-2'] };
  }),
}));

function createMockContext(initialProviders: Record<string, ProviderConfig> = {}): {
  ctx: ProviderServiceContext;
  providers: Record<string, ProviderConfig>;
  sentMessages: unknown[];
  operationResults: unknown[];
  broadcastCount: number;
} {
  const providers = { ...initialProviders };
  const sentMessages: unknown[] = [];
  const operationResults: unknown[] = [];
  let broadcastCount = 0;

  const ctx: ProviderServiceContext = {
    loadConfigProviders: vi.fn(async () => providers),
    saveConfigProviders: vi.fn(async (newProviders) => {
      Object.assign(providers, newProviders);
    }),
    broadcastSaved: vi.fn((_p) => {
      broadcastCount++;
    }),
    sendOperationResult: vi.fn((_ws, ok, message) => {
      operationResults.push({ ok, message });
    }),
    sendMessage: vi.fn((_ws, msg) => {
      sentMessages.push(msg);
    }),
    deps: {
      log: vi.fn(),
    },
  };

  return { ctx, providers, sentMessages, operationResults, broadcastCount };
}

describe('Provider Key Handlers', () => {
  const mockWs = {} as WebSocket;

  it('handles key upsert successfully and on failure', async () => {
    const { ctx, operationResults } = createMockContext({
      openai: {
        family: 'openai',
        apiKey: 'old-key',
      },
    });

    const handlers = createKeyHandlers(ctx);

    // Success
    await handlers.handleKeyUpsert(mockWs, 'openai', 'prod-key', 'sk-new-123456');
    expect(operationResults).toHaveLength(1);
    expect((operationResults[0] as { ok: boolean }).ok).toBe(true);

    // Upsert creates provider if missing
    await handlers.handleKeyUpsert(mockWs, 'new-provider', 'key1', 'sk-123');
    expect(operationResults).toHaveLength(2);
    expect((operationResults[1] as { ok: boolean }).ok).toBe(true);
  });

  it('handles key delete', async () => {
    const { ctx, operationResults } = createMockContext({
      anthropic: {
        family: 'anthropic',
        apiKeys: [{ label: 'default', apiKey: 'sk-ant-12345', createdAt: '2026-01-01' }],
      },
    });

    const handlers = createKeyHandlers(ctx);

    // Delete non-existent provider
    await handlers.handleKeyDelete(mockWs, 'unknown-provider', 'default');
    expect((operationResults[0] as { ok: boolean }).ok).toBe(false);

    // Delete existing
    await handlers.handleKeyDelete(mockWs, 'anthropic', 'default');
    expect((operationResults[1] as { ok: boolean }).ok).toBe(true);
  });

  it('handles key set active', async () => {
    const { ctx, operationResults } = createMockContext({
      anthropic: {
        family: 'anthropic',
        apiKeys: [
          { label: 'k1', apiKey: 'key-1', createdAt: '2026-01-01' },
          { label: 'k2', apiKey: 'key-2', createdAt: '2026-01-01' },
        ],
      },
    });

    const handlers = createKeyHandlers(ctx);

    await handlers.handleKeySetActive(mockWs, 'anthropic', 'k2');
    expect((operationResults[0] as { ok: boolean }).ok).toBe(true);

    // Error on loadConfigProviders rejection
    vi.mocked(ctx.loadConfigProviders).mockRejectedValueOnce(new Error('disk failed'));
    await handlers.handleKeySetActive(mockWs, 'anthropic', 'k1');
    expect((operationResults[1] as { ok: boolean; message: string }).ok).toBe(false);
    expect((operationResults[1] as { ok: boolean; message: string }).message).toContain(
      'disk failed',
    );
  });
});

describe('Provider CRUD Handlers', () => {
  const mockWs = {} as WebSocket;

  it('validates baseUrl on handleProviderAdd', async () => {
    const { ctx, operationResults } = createMockContext();
    const crud = createProviderCrudHandlers(ctx);

    const ok = await crud.handleProviderAdd(mockWs, {
      id: 'bad-provider',
      family: 'openai',
      baseUrl: 'http://evil.com/v1',
    });
    expect(ok).toBe(false);
    expect(operationResults[0]).toEqual({ ok: false, message: 'Disallowed base URL' });
  });

  it('adds a valid provider and logs message', async () => {
    const { ctx, operationResults } = createMockContext();
    const crud = createProviderCrudHandlers(ctx);

    const ok = await crud.handleProviderAdd(mockWs, {
      id: 'custom-llm',
      family: 'custom',
      baseUrl: 'http://127.0.0.1:8000/v1',
      apiKey: 'test-key',
    });
    expect(ok).toBe(true);
    expect((operationResults[0] as { ok: boolean }).ok).toBe(true);
    expect(ctx.deps.log).toHaveBeenCalledWith(
      '[WebUI] Provider "custom-llm" added via provider.add',
    );
  });

  it('catches thrown errors in handleProviderAdd', async () => {
    const { ctx, operationResults } = createMockContext();
    vi.mocked(ctx.loadConfigProviders).mockRejectedValueOnce(new Error('crash'));
    const crud = createProviderCrudHandlers(ctx);

    const ok = await crud.handleProviderAdd(mockWs, { id: 'p1', family: 'custom' });
    expect(ok).toBe(false);
    expect((operationResults[0] as { ok: boolean; message: string }).message).toContain('crash');
  });

  it('removes provider successfully or errors gracefully', async () => {
    const { ctx, operationResults } = createMockContext({
      prov1: { family: 'openai' },
    });
    const crud = createProviderCrudHandlers(ctx);

    await crud.handleProviderRemove(mockWs, 'prov1');
    expect((operationResults[0] as { ok: boolean }).ok).toBe(true);

    vi.mocked(ctx.loadConfigProviders).mockRejectedValueOnce(new Error('remove err'));
    await crud.handleProviderRemove(mockWs, 'prov2');
    expect((operationResults[1] as { ok: boolean }).ok).toBe(false);
  });

  it('clears models and restores models', async () => {
    const { ctx, operationResults, providers } = createMockContext({
      prov1: { family: 'openai', models: ['gpt-4', 'gpt-3.5'] },
    });
    const crud = createProviderCrudHandlers(ctx);

    // Unknown provider
    await crud.handleProviderClearModels(mockWs, 'unknown');
    expect(operationResults[0]).toEqual({ ok: false, message: 'Unknown provider "unknown"' });

    // Success clear
    await crud.handleProviderClearModels(mockWs, 'prov1');
    expect(operationResults[1]).toEqual({ ok: true, message: 'Cleared model allowlist for prov1' });
    expect(providers.prov1?.models).toBeUndefined();

    // Unknown provider on undo
    await crud.handleProviderUndoClear(mockWs, 'unknown', ['gpt-4']);
    expect(operationResults[2]).toEqual({ ok: false, message: 'Unknown provider "unknown"' });

    // Success undo
    await crud.handleProviderUndoClear(mockWs, 'prov1', ['gpt-4', 'gpt-3.5']);
    expect(operationResults[3]).toEqual({ ok: true, message: 'Restored 2 model(s) for prov1' });
    expect(providers.prov1?.models).toEqual(['gpt-4', 'gpt-3.5']);

    // Error handling
    vi.mocked(ctx.loadConfigProviders).mockRejectedValueOnce(new Error('undo error'));
    await crud.handleProviderUndoClear(mockWs, 'prov1', ['gpt-4']);
    expect((operationResults[4] as { ok: boolean }).ok).toBe(false);
  });

  it('updates provider config with base URL validation', async () => {
    const { ctx, operationResults, providers } = createMockContext({
      prov1: { family: 'openai', baseUrl: 'http://localhost:11434' },
    });
    const crud = createProviderCrudHandlers(ctx);

    // Unknown provider
    await crud.handleProviderUpdate(mockWs, { id: 'unknown' });
    expect(operationResults[0]).toEqual({ ok: false, message: 'Unknown provider "unknown"' });

    // Invalid baseUrl
    await crud.handleProviderUpdate(mockWs, { id: 'prov1', baseUrl: 'http://evil.com/v1' });
    expect(operationResults[1]).toEqual({ ok: false, message: 'Disallowed base URL' });

    // Valid update
    await crud.handleProviderUpdate(mockWs, {
      id: 'prov1',
      family: 'custom',
      baseUrl: 'http://127.0.0.1:5000',
      envVars: ['FOO_VAR'],
      models: ['m1'],
      customModels: { m1: { displayName: 'M1' } },
    });
    expect(operationResults[2]).toEqual({ ok: true, message: 'Updated prov1' });
    expect(providers.prov1?.family).toBe('custom');
    expect(providers.prov1?.baseUrl).toBe('http://127.0.0.1:5000');
    expect(providers.prov1?.models).toEqual(['m1']);

    // Error handling
    vi.mocked(ctx.loadConfigProviders).mockRejectedValueOnce(new Error('update error'));
    await crud.handleProviderUpdate(mockWs, { id: 'prov1' });
    expect((operationResults[3] as { ok: boolean }).ok).toBe(false);
  });
});

describe('Provider Probe Handlers & Projection', () => {
  const mockWs = {} as WebSocket;

  it('probes provider with various config states', async () => {
    const { ctx, sentMessages } = createMockContext({
      noUrl: { family: 'openai' },
      localOk: { family: 'custom', baseUrl: 'http://127.0.0.1:11434', apiKey: 'key1' },
      localUnreachable: { family: 'custom', baseUrl: 'http://unreachable:11434' },
    });
    const probeHandlers = createProbeHandlers(ctx);

    // Unknown provider
    await probeHandlers.handleProviderProbe(mockWs, 'unknown');
    expect(sentMessages[0]).toEqual({
      type: 'provider.probe',
      payload: { providerId: 'unknown', ok: false, status: 'no_provider' },
    });

    // No base URL
    await probeHandlers.handleProviderProbe(mockWs, 'noUrl');
    expect(sentMessages[1]).toEqual({
      type: 'provider.probe',
      payload: { providerId: 'noUrl', ok: false, status: 'no_base_url' },
    });

    // Successful probe
    await probeHandlers.handleProviderProbe(mockWs, 'localOk', 5000);
    expect(sentMessages[2]).toEqual({
      type: 'provider.probe',
      payload: {
        providerId: 'localOk',
        ok: true,
        status: 'ok',
        modelIds: ['model-1', 'model-2'],
      },
    });

    // Probe failure / unreachable
    await probeHandlers.handleProviderProbe(mockWs, 'localUnreachable');
    expect(sentMessages[3]).toEqual({
      type: 'provider.probe',
      payload: {
        providerId: 'localUnreachable',
        ok: false,
        status: 'unreachable',
        detail: 'Connection refused',
      },
    });

    // Internal exception caught
    vi.mocked(ctx.loadConfigProviders).mockRejectedValueOnce(new Error('fail probe'));
    await probeHandlers.handleProviderProbe(mockWs, 'localOk');
    expect(sentMessages[4]).toEqual({
      type: 'provider.probe',
      payload: {
        providerId: 'localOk',
        ok: false,
        status: 'unreachable',
        detail: 'fail probe',
      },
    });
  });

  it('projects saved providers safely redacting keys', () => {
    const views = projectSavedProviders({
      p1: {
        family: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-1234567890abcdef',
        models: ['gpt-4', 'gpt-3.5-turbo'],
      },
      p2: {
        apiKeys: [{ label: 'test', apiKey: 'short', createdAt: '2026-01-01' }],
      },
    });

    expect(views).toHaveLength(2);
    expect(views[0].id).toBe('p1');
    expect(views[0].pickedModelId).toBe('gpt-4');
    expect(views[0].apiKeys[0].maskedKey).not.toBe('sk-1234567890abcdef');
    expect(views[0].apiKeys[0].maskedKey).toBe('sk-1…cdef');

    expect(views[1].id).toBe('p2');
    expect(views[1].family).toBe('p2');
    expect(views[1].pickedModelId).toBeUndefined();
  });

  it('probeModelDescriptors returns empty array or model descriptors', async () => {
    // Missing baseUrl
    const emptyResult = await probeModelDescriptors({ family: 'custom' });
    expect(emptyResult).toEqual([]);

    // Successful probe
    const descriptors = await probeModelDescriptors({
      family: 'custom',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(descriptors).toEqual([
      { id: 'model-1', name: 'model-1', capabilities: [] },
      { id: 'model-2', name: 'model-2', capabilities: [] },
    ]);

    // Unreachable probe returns empty array
    const unreachableResult = await probeModelDescriptors({
      family: 'custom',
      baseUrl: 'http://unreachable:11434',
    });
    expect(unreachableResult).toEqual([]);
  });
});
