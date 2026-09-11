import type { Capabilities, Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createNativeCatalogProvider, isNativeCatalogNpm } from '../src/native-catalog.js';

const capabilities: Capabilities = {
  tools: true,
  parallelTools: true,
  vision: true,
  streaming: true,
  promptCache: false,
  systemPrompt: true,
  jsonMode: true,
  reasoning: true,
  maxContext: 1_000_000,
  cacheControl: 'none',
};

const request: Request = {
  model: 'command-r-plus',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 32,
};

describe('native catalog providers', () => {
  it.each(['@ai-sdk/cohere', '@ai-sdk/azure', '@ai-sdk/amazon-bedrock', '@ai-sdk/google-vertex'])(
    'recognizes %s as a native catalog SDK',
    (npm) => {
      expect(isNativeCatalogNpm(npm)).toBe(true);
    },
  );

  it('uses the native Cohere SDK request path and auth', async () => {
    const calls: Array<{ url: string; authorization?: string | undefined }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get('authorization') ?? undefined });
      return new Response('{"message":"stop"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as never as typeof fetch;
    const provider = createNativeCatalogProvider({
      id: 'cohere',
      npm: '@ai-sdk/cohere',
      apiKey: 'cohere-key',
      baseUrl: 'https://cohere.example/v2',
      capabilities,
      models: [{ id: 'command-r-plus', name: 'Command R Plus' }],
      fetchImpl,
    });

    await expect(drain(provider)).rejects.toThrow();
    expect(calls[0]?.url).toBe('https://cohere.example/v2/chat');
    expect(calls[0]?.authorization).toBe('Bearer cohere-key');
  });

  it.each([
    {
      id: 'azure',
      npm: '@ai-sdk/azure' as const,
      model: 'gpt-5.4',
      baseUrl: 'https://azure.example/openai/v1',
      expectedPath: '/responses',
    },
    {
      id: 'amazon-bedrock',
      npm: '@ai-sdk/amazon-bedrock' as const,
      model: 'anthropic.claude-sonnet-4-6-v1:0',
      baseUrl: 'https://bedrock.example',
      expectedPath: '/model/anthropic.claude-sonnet-4-6-v1%3A0/converse-stream',
    },
    {
      id: 'google-vertex',
      npm: '@ai-sdk/google-vertex' as const,
      model: 'gemini-3.1-pro',
      baseUrl: 'https://vertex.example/v1',
      expectedPath: '/models/gemini-3.1-pro:streamGenerateContent',
    },
  ])('uses the native $id SDK transport', async ({ id, npm, model, baseUrl, expectedPath }) => {
    let capturedUrl = '';
    const provider = createNativeCatalogProvider({
      id,
      npm,
      apiKey: 'native-key',
      baseUrl,
      capabilities,
      models: [{ id: model, name: model }],
      fetchImpl: (async (input: unknown) => {
        capturedUrl = String(input);
        return new Response('{"message":"stop"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as never as typeof fetch,
    });

    await expect(drain(provider, { ...request, model })).rejects.toThrow();
    expect(capturedUrl).toContain(expectedPath);
  });

  it('routes native OpenAI models through Cloudflare AI Gateway', async () => {
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'account-1';
    process.env['CLOUDFLARE_GATEWAY_ID'] = 'gateway-1';
    try {
      let capturedUrl = '';
      const fetchImpl = vi.fn(async (input: unknown) => {
        capturedUrl = String(input);
        return new Response('{"message":"stop"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as never as typeof fetch;
      vi.stubGlobal('fetch', fetchImpl);
      const model = 'openai/gpt-5.4';
      const provider = createNativeCatalogProvider({
        id: 'cloudflare-ai-gateway',
        npm: 'ai-gateway-provider',
        apiKey: 'cloudflare-key',
        capabilities,
        models: [{ id: model, name: model, provider: { npm: '@ai-sdk/openai' } }],
        fetchImpl,
      });

      await expect(drain(provider, { ...request, model })).rejects.toThrow();
      expect(capturedUrl).toContain('/account-1/gateway-1');
    } finally {
      delete process.env['CLOUDFLARE_ACCOUNT_ID'];
      delete process.env['CLOUDFLARE_GATEWAY_ID'];
      vi.unstubAllGlobals();
    }
  });
});

async function drain(
  provider: ReturnType<typeof createNativeCatalogProvider>,
  req: Request = request,
): Promise<void> {
  for await (const _event of provider.stream(req, {
    signal: new AbortController().signal,
  })) {
    // The 400 response exercises request construction only.
  }
}
