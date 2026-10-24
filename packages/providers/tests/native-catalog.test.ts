import type { Capabilities, Request } from '@wrongstack/contracts/types';
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
  it('runs two native Azure profiles with independent resources without global env changes', async () => {
    const urls: string[] = [];
    const previous = process.env['AZURE_RESOURCE_NAME'];
    const create = (resourceName: string) =>
      createNativeCatalogProvider({
        id: resourceName,
        catalogId: 'azure',
        npm: '@ai-sdk/azure',
        apiKey: 'fixture-key',
        cloud: { resourceName },
        capabilities,
        models: [{ id: 'gpt-5.4', name: 'GPT' }],
        fetchImpl: (async (input) => {
          urls.push(String(input));
          return new Response('{"message":"stop"}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      });
    const first = create('profile-one');
    const second = create('profile-two');
    await expect(drain(first, { ...request, model: 'gpt-5.4' })).rejects.toThrow();
    await expect(drain(second, { ...request, model: 'gpt-5.4' })).rejects.toThrow();
    expect(urls[0]).toContain('profile-one.openai.azure.com');
    expect(urls[1]).toContain('profile-two.openai.azure.com');
    expect(process.env['AZURE_RESOURCE_NAME']).toBe(previous);
  });
  it('expands catalog endpoints using the explicit profile region', async () => {
    const urls: string[] = [];
    const provider = createNativeCatalogProvider({
      id: 'bedrock-work',
      catalogId: 'amazon-bedrock',
      npm: '@ai-sdk/amazon-bedrock',
      apiKey: 'fixture-key',
      cloud: { region: 'eu-west-1' },
      capabilities,
      models: [
        { id: 'model', name: 'Model', provider: { api: 'https://bedrock.${AWS_REGION}.example' } },
      ],
      fetchImpl: (async (input) => {
        urls.push(String(input));
        return new Response('{"message":"stop"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await expect(drain(provider, { ...request, model: 'model' })).rejects.toThrow();
    expect(urls[0]).toContain('bedrock.eu-west-1.example');
  });
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
      let capturedInit: RequestInit | undefined;
      const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
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
      expect(new Headers(capturedInit?.headers).get('cf-aig-authorization')).toBe(
        'Bearer cloudflare-key',
      );
      const gatewayBody = JSON.parse(String(capturedInit?.body)) as Array<{
        provider: string;
        endpoint: string;
        headers: Record<string, string>;
      }>;
      expect(gatewayBody).toHaveLength(1);
      expect(gatewayBody[0]).toMatchObject({
        provider: 'openai',
        endpoint: 'v1/responses',
      });
      expect(gatewayBody[0]?.headers).not.toHaveProperty('authorization');
    } finally {
      delete process.env['CLOUDFLARE_ACCOUNT_ID'];
      delete process.env['CLOUDFLARE_GATEWAY_ID'];
      vi.unstubAllGlobals();
    }
  });

  it('routes native Anthropic models without forwarding the placeholder key', async () => {
    process.env['CLOUDFLARE_ACCOUNT_ID'] = 'account-1';
    process.env['CLOUDFLARE_GATEWAY_ID'] = 'gateway-1';
    try {
      let capturedInit: RequestInit | undefined;
      const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
        capturedInit = init;
        return new Response('{"message":"stop"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as never as typeof fetch;
      const model = 'anthropic/claude-sonnet-4-6';
      const provider = createNativeCatalogProvider({
        id: 'cloudflare-ai-gateway',
        npm: 'ai-gateway-provider',
        apiKey: 'cloudflare-key',
        capabilities,
        models: [{ id: model, name: model, provider: { npm: '@ai-sdk/anthropic' } }],
        fetchImpl,
      });

      await expect(drain(provider, { ...request, model })).rejects.toThrow();
      const gatewayBody = JSON.parse(String(capturedInit?.body)) as Array<{
        provider: string;
        endpoint: string;
        headers: Record<string, string>;
      }>;
      expect(gatewayBody[0]).toMatchObject({
        provider: 'anthropic',
        endpoint: 'v1/messages',
      });
      expect(gatewayBody[0]?.headers).not.toHaveProperty('x-api-key');
    } finally {
      delete process.env['CLOUDFLARE_ACCOUNT_ID'];
      delete process.env['CLOUDFLARE_GATEWAY_ID'];
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
