import type {
  ModelsRegistry,
  ProviderConfig,
  ResolvedProvider,
  SecretVault,
} from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderHandlers } from '../src/server/provider-handlers.js';

const mockLoadSavedProviders = vi.hoisted(() => vi.fn());
const mockSaveProviders = vi.hoisted(() => vi.fn());
const mockBeginOAuthLogin = vi.hoisted(() => vi.fn());

vi.mock('../src/server/provider-config-io.js', () => ({
  loadSavedProviders: mockLoadSavedProviders,
  saveProviders: mockSaveProviders,
}));

vi.mock('@wrongstack/providers/oauth', () => ({
  beginOAuthLogin: mockBeginOAuthLogin,
}));

function cloneProviders(input: Record<string, ProviderConfig>): Record<string, ProviderConfig> {
  return JSON.parse(JSON.stringify(input)) as Record<string, ProviderConfig>;
}

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
  return { handlers, broadcast, clients };
}

function makeModelsRegistry(overrides: Partial<ModelsRegistry> = {}): ModelsRegistry {
  return {
    load: vi.fn(async () => ({})),
    refresh: vi.fn(async () => ({})),
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => undefined),
    getModel: vi.fn(async () => undefined),
    suggestModel: vi.fn(async () => undefined),
    ageSeconds: vi.fn(async () => Number.POSITIVE_INFINITY),
    ...overrides,
  };
}

const providers: Record<string, ProviderConfig> = {
  local: {
    type: 'openai-compatible',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.1:8b', 'qwen2.5:7b'],
    activeKey: 'primary',
    apiKeys: [
      { label: 'primary', apiKey: 'sk-primary-secret', createdAt: '2026-06-01T00:00:00.000Z' },
      { label: 'backup', apiKey: 'sk-backup-secret', createdAt: '2026-06-02T00:00:00.000Z' },
    ],
  },
};

describe('createProviderHandlers saved-provider broadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveProviders.mockResolvedValue(undefined);
  });

  it('broadcasts a fresh saved-provider projection after a successful key mutation', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce(cloneProviders(providers));
    const ws = mockWs();
    const { handlers, broadcast, clients } = makeHandlers();

    await handlers.handleKeySetActive(ws, 'local', 'backup');

    expect(mockSaveProviders).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'providers.saved',
      payload: {
        providers: [
          {
            id: 'local',
            family: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            models: ['llama3.1:8b', 'qwen2.5:7b'],
            pickedModelId: 'llama3.1:8b',
            apiKeys: [
              {
                label: 'primary',
                maskedKey: 'sk-p…cret',
                isActive: false,
                createdAt: '2026-06-01T00:00:00.000Z',
              },
              {
                label: 'backup',
                maskedKey: 'sk-b…cret',
                isActive: true,
                createdAt: '2026-06-02T00:00:00.000Z',
              },
            ],
          },
        ],
      },
    });
  });

  it('persists and broadcasts a custom model set', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: { type: 'openai-compatible' },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();
    const definition = { name: 'Custom Model', capabilities: { tools: true } };

    await handlers.handleCustomModelSet(ws, 'local', 'custom/model', definition);

    expect(mockSaveProviders).toHaveBeenCalledOnce();
    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved.local?.customModels?.['custom/model']).toEqual(definition);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'key.operation_result',
        payload: { success: true, message: 'Saved model "custom/model" for local' },
      }),
    );
  });

  it('removes the last custom model and prunes the empty map', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: {
        type: 'openai-compatible',
        customModels: { 'custom/model': { name: 'Custom Model' } },
      },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();

    await handlers.handleCustomModelRemove(ws, 'local', 'custom/model');

    expect(mockSaveProviders).toHaveBeenCalledOnce();
    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved.local?.customModels).toBeUndefined();
    expect(broadcast).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'key.operation_result',
        payload: { success: true, message: 'Removed model "custom/model" from local' },
      }),
    );
  });

  it('does not persist or broadcast when removing a missing custom model', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: { type: 'openai-compatible', customModels: {} },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();

    await handlers.handleCustomModelRemove(ws, 'local', 'missing/model');

    expect(mockSaveProviders).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'key.operation_result',
        payload: { success: false, message: 'Model "missing/model" not found in local' },
      }),
    );
  });

  it('does not mutate inherited providers when setting custom models', async () => {
    const inheritedProvider = { type: 'openai-compatible' } as ProviderConfig;
    const providerMap = Object.create({ inherited: inheritedProvider }) as Record<
      string,
      ProviderConfig
    >;
    mockLoadSavedProviders.mockResolvedValueOnce(providerMap);
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();

    await handlers.handleCustomModelSet(ws, 'inherited', 'custom/model', { name: 'Blocked' });

    expect(inheritedProvider.customModels).toBeUndefined();
    expect(mockSaveProviders).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'key.operation_result',
        payload: { success: false, message: 'Unknown provider "inherited"' },
      }),
    );
  });

  it('does not mutate inherited providers when removing custom models', async () => {
    const inheritedProvider = {
      type: 'openai-compatible',
      customModels: { 'custom/model': { name: 'Inherited' } },
    } as ProviderConfig;
    const providerMap = Object.create({ inherited: inheritedProvider }) as Record<
      string,
      ProviderConfig
    >;
    mockLoadSavedProviders.mockResolvedValueOnce(providerMap);
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();

    await handlers.handleCustomModelRemove(ws, 'inherited', 'custom/model');

    expect(inheritedProvider.customModels).toEqual({ 'custom/model': { name: 'Inherited' } });
    expect(mockSaveProviders).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'key.operation_result',
        payload: { success: false, message: 'Unknown provider "inherited"' },
      }),
    );
  });

  it('does not remove inherited custom model keys', async () => {
    const pollutedCustomModels = Object.create({ toString: { name: 'inherited' } }) as NonNullable<
      ProviderConfig['customModels']
    >;
    pollutedCustomModels['real/model'] = { name: 'Real Model' };
    mockLoadSavedProviders.mockResolvedValueOnce({
      local: {
        type: 'openai-compatible',
        customModels: pollutedCustomModels,
      },
    } satisfies Record<string, ProviderConfig>);
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();

    await handlers.handleCustomModelRemove(ws, 'local', 'toString');

    expect(mockSaveProviders).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'key.operation_result',
        payload: { success: false, message: 'Model "toString" not found in local' },
      }),
    );
  });

  it('does not broadcast when a provider mutation fails validation', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({});
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();

    await handlers.handleProviderRemove(ws, 'missing');

    expect(mockSaveProviders).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('uses the OAuth family sibling catalog for custom provider model lists', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      'custom-claude': {
        type: 'anthropic-oauth',
        family: 'anthropic-oauth',
        models: [],
      },
    } satisfies Record<string, ProviderConfig>);
    const getProvider = vi.fn(async (id: string): Promise<ResolvedProvider | undefined> => {
      if (id === 'anthropic-oauth') {
        return { id, name: id, family: 'anthropic-oauth', envVars: [], models: [] };
      }
      if (id === 'anthropic') {
        return {
          id,
          name: id,
          family: 'anthropic',
          envVars: [],
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
        };
      }
      return undefined;
    });
    const getModel = vi.fn(async () => undefined);
    const ws = mockWs();
    const modelsRegistry = makeModelsRegistry({ getProvider, getModel });
    const { handlers } = makeHandlers({ modelsRegistry });

    await handlers.handleProviderModels(ws, 'custom-claude');

    expect(getProvider).toHaveBeenCalledWith('anthropic-oauth');
    expect(getProvider).toHaveBeenCalledWith('anthropic');
    const sent = ws.send.mock.calls.map(
      ([raw]) => JSON.parse(String(raw)) as Record<string, unknown>,
    );
    const message = sent.find((item) => item.type === 'provider.models');
    expect(message).toEqual({
      type: 'provider.models',
      payload: {
        provider: 'custom-claude',
        models: [
          expect.objectContaining({
            id: 'claude-sonnet-4',
            name: 'Claude Sonnet 4',
          }),
        ],
      },
    });
  });

  it('keeps an existing OAuth provider model allowlist when live lookup returns none', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({
      'custom-codex': {
        type: 'openai-codex',
        family: 'openai-codex',
        models: ['saved-model'],
        apiKeys: [{ label: 'old', apiKey: 'old-key', createdAt: '2026-01-01T00:00:00.000Z' }],
        activeKey: 'old',
      },
    } satisfies Record<string, ProviderConfig>);
    const outcome = {
      providerId: 'openai-codex',
      family: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      models: [],
      apiKey: { label: 'chatgpt', apiKey: 'new-key', createdAt: '2026-08-03T00:00:00.000Z' },
    };
    const close = vi.fn();
    mockBeginOAuthLogin.mockResolvedValueOnce({
      providerId: 'openai-codex',
      authorizeUrl: 'https://example.test',
      bound: false,
      completeWithCode: vi.fn(async () => outcome),
      close,
    });
    const getProvider = vi.fn(async () => undefined);
    const ws = mockWs();
    const modelsRegistry = makeModelsRegistry({ getProvider });
    const { handlers } = makeHandlers({ modelsRegistry });

    await handlers.handleOAuthStart(ws, 'chatgpt', 'custom-codex');
    await handlers.handleOAuthCode(ws, 'chatgpt', 'callback-code');

    expect(mockBeginOAuthLogin).toHaveBeenCalledWith('chatgpt', { modelsRegistry });
    expect(getProvider).not.toHaveBeenCalled();
    expect(mockSaveProviders).toHaveBeenCalledOnce();
    const saved = mockSaveProviders.mock.calls[0]?.[2] as Record<string, ProviderConfig>;
    expect(saved['custom-codex']?.models).toEqual(['saved-model']);
    expect(saved['custom-codex']?.activeKey).toBe('chatgpt');
    expect(close).toHaveBeenCalledOnce();
  });
});
