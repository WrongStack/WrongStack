import { describe, expect, it } from 'vitest';
import { createCloudflareGatewayModel } from '../src/cloudflare-ai-gateway.js';

describe('createCloudflareGatewayModel path encoding', () => {
  it('URL-encodes accountId and gatewayId path segments', async () => {
    let requestedUrl = '';
    const inner = {
      specificationVersion: 'v4' as const,
      provider: 'openai',
      modelId: 'gpt-4o',
      supportedUrls: {},
      config: {
        fetch: undefined as
          | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
          | undefined,
      },
      async doGenerate() {
        await inner.config.fetch!('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          body: JSON.stringify({ model: 'gpt-4o' }),
        });
        return {} as never;
      },
      async doStream() {
        return {} as never;
      },
    };

    const model = createCloudflareGatewayModel(inner as never, {
      accountId: '../evil',
      gatewayId: 'gw?x=1',
      apiKey: 'k',
      provider: 'openai',
      fetchImpl: (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return new Response('{}');
      }) as typeof fetch,
    });

    await model.doGenerate({} as never);
    expect(requestedUrl).toBe('https://gateway.ai.cloudflare.com/v1/..%2Fevil/gw%3Fx%3D1');
  });
});
