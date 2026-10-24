import type { ProviderConfig } from '@wrongstack/contracts/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { createProviderOperations } from '../src/server/provider-handlers.js';
import type { WSServerMessage } from '../src/server/types.js';

const beginProviderAuth = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/providers/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/providers/oauth')>()),
  createBuiltinProviderAuthRegistry: () => ({
    begin: beginProviderAuth,
    list: () => [],
    resolveId: (id: string) => id,
  }),
}));

describe('canonical provider operations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not save a manual login that completes after cancellation', async () => {
    let complete!: (value: unknown) => void;
    const session = {
      providerId: 'openai-codex',
      interaction: { type: 'browser', authorizeUrl: 'https://example.test', bound: false },
      close: vi.fn(),
      completeWithCode: vi.fn(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      ),
    };
    beginProviderAuth.mockResolvedValue(session);
    const save = vi.fn();
    const messages: WSServerMessage[] = [];
    const operations = createProviderOperations({
      providerStore: { load: async () => ({}), save },
      send: (_ws, message) => messages.push(message),
      broadcast: vi.fn(),
    });
    const socket = {} as WebSocket;
    await operations.handleOAuthStart(socket, 'chatgpt');
    const completion = operations.handleOAuthCode(socket, 'chatgpt', 'old-code');
    operations.handleOAuthCancel(socket, 'chatgpt');
    complete({
      providerId: 'openai-codex',
      models: [],
      credential: { label: 'oauth', apiKey: 'old-token', createdAt: '' },
    });
    await completion;
    expect(save).not.toHaveBeenCalled();
    expect(
      messages.filter(
        (m) =>
          m.type === 'auth.oauth.status' && (m.payload as { phase?: string }).phase === 'success',
      ),
    ).toEqual([]);
  });

  it('closes a session whose begin resolves after cancellation', async () => {
    let begun!: (value: unknown) => void;
    beginProviderAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          begun = resolve;
        }),
    );
    const send = vi.fn();
    const operations = createProviderOperations({
      providerStore: { load: async () => ({}), save: vi.fn() },
      send,
      broadcast: vi.fn(),
    });
    const socket = {} as WebSocket;
    const start = operations.handleOAuthStart(socket, 'chatgpt');
    operations.handleOAuthCancel(socket, 'chatgpt');
    const close = vi.fn();
    begun({ providerId: 'openai-codex', interaction: { type: 'browser', bound: false }, close });
    await start;
    expect(close).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(beginProviderAuth.mock.calls[0]![2].aborted).toBe(true);
  });

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
    beginProviderAuth.mockResolvedValue({
      providerId: 'openai-codex',
      interaction: {
        type: 'browser',
        authorizeUrl: 'https://example.test/authorize',
        bound: false,
      },
      close,
      completeWithCode: vi.fn(async () => ({
        providerId: 'openai-codex',
        family: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-5'],
        credential: {
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
      type: 'openai-codex',
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
