import type { Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { CatalogRoutedProvider } from '../src/catalog-routed.js';

const baseRequest: Request = {
  model: 'chat-model',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 64,
};

describe('CatalogRoutedProvider', () => {
  it('routes every supported model-level SDK to its own catalog endpoint', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([key, value]) => [
            key.toLowerCase(),
            String(value),
          ]),
        ),
      });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new CatalogRoutedProvider({
      id: 'mixed-test',
      apiKey: 'mixed-key',
      defaultNpm: '@ai-sdk/openai-compatible',
      baseUrl: 'https://mixed.example/v1',
      headers: { 'x-tenant': 'tenant-1' },
      fetchImpl,
      models: [
        { id: 'chat-model', name: 'Chat' },
        {
          id: 'responses-model',
          name: 'Responses',
          provider: { npm: '@ai-sdk/openai', api: 'https://responses.example/v1' },
        },
        {
          id: 'messages-model',
          name: 'Messages',
          provider: { npm: '@ai-sdk/anthropic', api: 'https://messages.example/v1' },
        },
        {
          id: 'google-model',
          name: 'Google',
          provider: { npm: '@ai-sdk/google', api: 'https://google.example/v1beta' },
        },
      ],
    });

    for (const model of ['chat-model', 'responses-model', 'messages-model', 'google-model']) {
      for await (const _event of provider.stream(
        { ...baseRequest, model },
        { signal: new AbortController().signal },
      )) {
        // Captured requests are asserted below.
      }
    }

    expect(calls.map((call) => call.url)).toEqual([
      'https://mixed.example/v1/chat/completions',
      'https://responses.example/v1/responses',
      'https://messages.example/v1/messages',
      'https://google.example/v1beta/models/google-model:streamGenerateContent?alt=sse',
    ]);
    expect(calls.every((call) => call.headers['x-tenant'] === 'tenant-1')).toBe(true);
    expect(calls[0]?.headers['authorization']).toBe('Bearer mixed-key');
    expect(calls[1]?.headers['authorization']).toBe('Bearer mixed-key');
    expect(calls[2]?.headers['x-api-key']).toBe('mixed-key');
    expect(calls[3]?.headers['x-goog-api-key']).toBe('mixed-key');
  });

  it('expands environment placeholders in model-level API endpoints', async () => {
    process.env['WRONGSTACK_MIXED_TEST_HOST'] = 'env.example';
    try {
      let url = '';
      const provider = new CatalogRoutedProvider({
        id: 'env-test',
        apiKey: 'key',
        defaultNpm: '@ai-sdk/openai-compatible',
        baseUrl: 'https://fallback.example/v1',
        models: [
          {
            id: 'env-model',
            name: 'Environment model',
            provider: {
              npm: '@ai-sdk/openai',
              api: 'https://' + '${' + 'WRONGSTACK_MIXED_TEST_HOST}/openai/v1',
            },
          },
        ],
        fetchImpl: (async (input: unknown) => {
          url = String(input);
          return new Response('', { status: 200 });
        }) as never as typeof fetch,
      });

      for await (const _event of provider.stream(
        { ...baseRequest, model: 'env-model' },
        { signal: new AbortController().signal },
      )) {
        // URL is asserted below.
      }
      expect(url).toBe('https://env.example/openai/v1/responses');
    } finally {
      delete process.env['WRONGSTACK_MIXED_TEST_HOST'];
    }
  });

  it('reports a missing endpoint environment variable before sending a request', () => {
    delete process.env['WRONGSTACK_MIXED_MISSING_HOST'];
    const provider = new CatalogRoutedProvider({
      id: 'env-test',
      apiKey: 'key',
      defaultNpm: '@ai-sdk/openai-compatible',
      models: [
        {
          id: 'env-model',
          name: 'Environment model',
          provider: { api: 'https://' + '${' + 'WRONGSTACK_MIXED_MISSING_HOST}/v1' },
        },
      ],
    });

    expect(() =>
      provider.stream(
        { ...baseRequest, model: 'env-model' },
        { signal: new AbortController().signal },
      ),
    ).toThrow(/WRONGSTACK_MIXED_MISSING_HOST/);
  });

  it('does not send an explicitly unsupported model SDK through the provider default', () => {
    const provider = new CatalogRoutedProvider({
      id: 'future-test',
      apiKey: 'key',
      defaultNpm: '@ai-sdk/openai-compatible',
      baseUrl: 'https://future.example/v1',
      models: [
        {
          id: 'future-model',
          name: 'Future model',
          provider: { npm: '@ai-sdk/future-native' },
        },
      ],
    });

    expect(() =>
      provider.stream(
        { ...baseRequest, model: 'future-model' },
        { signal: new AbortController().signal },
      ),
    ).toThrow(/unsupported wire SDK.*@ai-sdk\/future-native/);
  });
});
