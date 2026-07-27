import type { ProviderConfig } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createProviderOperations } from '../src/server/provider-handlers.js';
import type { WSServerMessage } from '../src/server/types.js';

const beginOAuthLogin = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/providers/oauth', () => ({ beginOAuthLogin }));

describe('canonical provider operations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns catalog model search results to the requesting socket', async () => {
    const messages: WSServerMessage[] = [];
    const operations = createProviderOperations({
      providerStore: {
        load: async () => ({}),
        save: async () => undefined,
      },
      modelsRegistry: {
        listProviders: vi.fn(async () => [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
          },
        ]),
      } as never,
      send: (_ws, message) => messages.push(message),
      broadcast: vi.fn(),
    });
    const socket = {} as WebSocket;

    await operations.handleProviderModelsSearch(socket, 'claude', 1);

    expect(messages).toEqual([
      {
        type: 'provider.models.search_result',
        payload: {
          query: 'claude',
          matches: [
            {
              providerId: 'anthropic',
              providerName: 'Anthropic',
              modelId: 'claude-sonnet-4',
              name: 'Claude Sonnet 4',
              capabilities: [],
            },
          ],
        },
      },
    ]);
  });

  it('persists and reports a requested provider alias', async () => {
    const close = vi.fn();
    beginOAuthLogin.mockResolvedValue({
      providerId: 'openai-codex',
      authorizeUrl: 'https://example.test/authorize',
      bound: false,
      close,
      completeWithCode: vi.fn(async () => ({
        providerId: 'openai-codex',
        family: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-5'],
        apiKey: {
          label: 'oauth',
          apiKey: 'secret-token',
          createdAt: '2026-07-21T00:00:00.000Z',
        },
      })),
    });
    let providers: Record<string, ProviderConfig> = {};
    const messages: WSServerMessage[] = [];
    const operations = createProviderOperations({
      providerStore: {
        load: async () => providers,
        save: async (next) => {
          providers = next;
        },
      },
      send: (_ws, message) => messages.push(message),
      broadcast: (message) => messages.push(message),
    });
    const socket = {} as WebSocket;

    await operations.handleOAuthStart(socket, 'chatgpt', 'team-openai');
    await operations.handleOAuthCode(socket, 'chatgpt', 'callback-code');

    expect(providers['team-openai']).toMatchObject({
      type: 'team-openai',
      models: ['gpt-5'],
      activeKey: 'oauth',
    });
    expect(providers['openai-codex']).toBeUndefined();
    expect(messages).toContainEqual({
      type: 'auth.oauth.status',
      payload: expect.objectContaining({
        kind: 'chatgpt',
        phase: 'success',
        providerId: 'team-openai',
      }),
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
