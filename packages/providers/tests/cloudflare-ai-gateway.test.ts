import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createCloudflareGatewayModel } from '../src/cloudflare-ai-gateway.js';

type ModelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Minimal OpenAI-shaped provider model whose doGenerate resolves its fetch by
 * reading `config.fetch` at CALL time — the lazy lookup the real
 * `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic` models use, which is what
 * makes the config-mutation interception work at all.
 */
function fakeProviderModel(realFetch: ModelFetch): {
  model: LanguageModelV4;
  config: { fetch?: ModelFetch | undefined };
} {
  const config: { fetch?: ModelFetch | undefined } = { fetch: realFetch };
  const model = {
    specificationVersion: 'v4',
    provider: 'openai',
    modelId: 'test-model',
    config,
    doGenerate: async () => {
      // Capture or replay phase — whichever stub is installed handles this.
      const response = await config.fetch?.('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'test-model' }),
      });
      // Replay phase hands back the gateway response; the fake parses nothing.
      return {
        content: [{ type: 'text', text: String(response?.status ?? 0) }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
  return { model: model as unknown as LanguageModelV4, config };
}

interface GatewayCall {
  url: string;
  headers: Headers;
  body: unknown;
}

/**
 * Gateway options whose fetch records every gateway call and answers the Nth
 * call with status 200 + N, so each dispatch's replayed result proves which
 * gateway response it was handed.
 */
function gatewayOptions(): {
  options: {
    accountId: string;
    gatewayId: string;
    apiKey: string;
    provider: 'openai';
    fetchImpl: typeof fetch;
  };
  calls: GatewayCall[];
} {
  const calls: GatewayCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response('{}', { status: 200 + calls.length });
  }) as unknown as typeof fetch;
  return {
    options: {
      accountId: 'account-1',
      gatewayId: 'gateway-1',
      apiKey: 'gateway-key',
      provider: 'openai',
      fetchImpl,
    },
    calls,
  };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

const callOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
} as unknown as LanguageModelV4CallOptions;

/**
 * The capture stub must always win the interception: if a dispatch ever ran
 * against the un-stubbed config, the real fetch would fire.
 */
function neverRoutedRealFetch(): ModelFetch {
  return (() => {
    throw new Error('real fetch must never run while the gateway wrapper is installed');
  }) as unknown as ModelFetch;
}

describe('createCloudflareGatewayModel dispatch serialization', () => {
  it('restores config.fetch after two interleaved dispatches instead of poisoning the model', async () => {
    const realFetch = neverRoutedRealFetch();
    const { model, config } = fakeProviderModel(realFetch);
    const { options, calls } = gatewayOptions();
    const gateway = createCloudflareGatewayModel(model, options);

    const [first, second] = await Promise.all([
      gateway.doGenerate(callOptions),
      gateway.doGenerate(callOptions),
    ]);

    // Serialized: each dispatch replays its OWN gateway response, in order.
    expect(textOf(first)).toBe('201');
    expect(textOf(second)).toBe('202');
    expect(calls).toHaveLength(2);
    // A poisoned restore would leave a CaptureRequest stub in place.
    expect(config.fetch).toBe(realFetch);

    // A third dispatch on the same model still works — the exact operation
    // the poisoning race breaks.
    expect(textOf(await gateway.doGenerate(callOptions))).toBe('203');
    expect(config.fetch).toBe(realFetch);
  });

  it('routes the captured provider request through the universal gateway endpoint', async () => {
    const realFetch = neverRoutedRealFetch();
    const { model, config } = fakeProviderModel(realFetch);
    const { options, calls } = gatewayOptions();
    const gateway = createCloudflareGatewayModel(model, options);

    expect(textOf(await gateway.doGenerate(callOptions))).toBe('201');
    expect(config.fetch).toBe(realFetch);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('https://gateway.ai.cloudflare.com/v1/account-1/gateway-1');
    expect(call!.headers.get('cf-aig-authorization')).toBe('Bearer gateway-key');
    expect(call!.body).toEqual([
      {
        provider: 'openai',
        endpoint: 'v1/chat/completions',
        headers: {},
        query: { model: 'test-model' },
      },
    ]);
  });

  it('refuses a model whose config exposes no interceptable fetch', async () => {
    const { model } = fakeProviderModel(neverRoutedRealFetch());
    delete (model as unknown as { config: { fetch?: unknown } }).config.fetch;
    const { options, calls } = gatewayOptions();
    const gateway = createCloudflareGatewayModel(model, options);

    await expect(gateway.doGenerate(callOptions)).rejects.toThrow(/cannot intercept provider/);
    expect(calls).toHaveLength(0);
  });

  it('handles bodyless requests and BOM-prefixed JSON bodies in parseRequestBody (F465)', async () => {
    const { model, config } = fakeProviderModel(neverRoutedRealFetch());
    const { options, calls } = gatewayOptions();
    let mode: 'get' | 'bom' = 'get';
    model.doGenerate = async () => {
      const providerFetch = config.fetch;
      if (!providerFetch) throw new Error('Fake provider fetch is not configured');
      if (mode === 'get') {
        await providerFetch('https://api.openai.com/v1/models', { method: 'GET' });
      } else {
        await providerFetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          body: `\uFEFF${JSON.stringify({ model: 'gpt-4o' })}`,
        });
      }
      return {
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      } as never;
    };
    const gateway = createCloudflareGatewayModel(model, options);
    await gateway.doGenerate(callOptions);
    mode = 'bom';
    await gateway.doGenerate(callOptions);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual([
      { provider: 'openai', endpoint: 'v1/models', headers: {}, query: {} },
    ]);
    expect(calls[1]?.body).toEqual([
      {
        provider: 'openai',
        endpoint: 'v1/chat/completions',
        headers: {},
        query: { model: 'gpt-4o' },
      },
    ]);
  });
});
