import type { ProviderConfig, SecretVault } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderHandlers } from '../src/server/provider-handlers.js';

const mockLoadSavedProviders = vi.hoisted(() => vi.fn());
const mockSaveProviders = vi.hoisted(() => vi.fn());

vi.mock('../src/server/provider-config-io.js', () => ({
  loadSavedProviders: mockLoadSavedProviders,
  saveProviders: mockSaveProviders,
}));

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function makeHandlers(overrides: Partial<Parameters<typeof createProviderHandlers>[0]> = {}) {
  const clients = new Map<WebSocket, never>();
  const broadcast = vi.fn();
  const handlers = createProviderHandlers({
    profileConfigPath: '/tmp/profiles/default/config.json',
    vault: {} as SecretVault,
    getConfigWriteLock: () => Promise.resolve(),
    setConfigWriteLock: vi.fn(),
    broadcast,
    clients,
    ...overrides,
  });
  return { handlers, broadcast };
}

const DEFINITION = { name: 'Custom Model', modelsDev: { limit: { context: 100_000 } } };

describe('createProviderHandlers custom-model ↔ models[] allowlist sync', () => {
  beforeEach(() => {
    mockLoadSavedProviders.mockReset();
    mockSaveProviders.mockReset();
  });

  it('adds a new custom model to the models[] allowlist on set', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: { type: 'openai-compatible', models: ['existing'] },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers } = makeHandlers();

    await handlers.handleCustomModelSet(ws, 'local', 'custom/model', DEFINITION);

    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved.local?.customModels?.['custom/model']).toEqual(DEFINITION);
    expect(saved.local?.models).toEqual(['existing', 'custom/model']);
  });

  it('creates the models[] allowlist when the provider has none', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: { type: 'openai-compatible' },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers } = makeHandlers();

    await handlers.handleCustomModelSet(ws, 'local', 'custom/model', DEFINITION);

    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved.local?.models).toEqual(['custom/model']);
  });

  it('does not duplicate an already-listed model on set (upsert)', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: { type: 'openai-compatible', models: ['custom/model', 'other'] },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers } = makeHandlers();

    await handlers.handleCustomModelSet(ws, 'local', 'custom/model', DEFINITION);

    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved.local?.models).toEqual(['custom/model', 'other']);
  });

  it('removes a model from BOTH customModels and the models[] allowlist', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: {
        type: 'openai-compatible',
        models: ['keep', 'custom/model'],
        customModels: { 'custom/model': { name: 'Custom Model' } },
      },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers } = makeHandlers();

    await handlers.handleCustomModelRemove(ws, 'local', 'custom/model');

    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved.local?.customModels?.['custom/model']).toBeUndefined();
    expect(saved.local?.models).toEqual(['keep']);
  });

  it('deletes the models[] allowlist entirely when the last model is removed', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: {
        type: 'openai-compatible',
        models: ['custom/model'],
        customModels: { 'custom/model': { name: 'Custom Model' } },
      },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers } = makeHandlers();

    await handlers.handleCustomModelRemove(ws, 'local', 'custom/model');

    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved.local?.models).toBeUndefined();
    expect(saved.local?.customModels).toBeUndefined();
  });
});
