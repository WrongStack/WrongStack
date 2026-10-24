import { EventBus } from '@wrongstack/contracts/kernel';
import {
  type Config,
  type Provider,
  ProviderError,
  type Request,
  type Response,
} from '@wrongstack/contracts/types';
import { createFallbackModelExtension, FallbackProfileManager } from '@wrongstack/core/agent';
import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import { ProviderRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';
import { resolveActiveApiKey } from '../src/provider-config-utils.js';
import { buildProviderForId } from '../src/wiring/provider-runtime.js';

describe('fallback auth profile identity', () => {
  it('builds a keyless local auth profile using its canonical provider type in config-only mode', () => {
    const config = {
      provider: 'primary',
      features: { modelsRegistry: false },
      providers: {
        'local-profile': {
          type: 'ollama',
          family: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:11434/v1',
          envVars: [],
        },
      },
    } as unknown as Config;
    expect(
      buildProviderForId({ config, providerRegistry: new ProviderRegistry() }, 'local-profile').id,
    ).toBe('local-profile');
  });
  it('hops to another account of the same provider/model with its own active key and independent health', async () => {
    const config = {
      provider: 'personal-account',
      model: 'same-model',
      apiKey: 'legacy-primary-key',
      baseUrl: 'https://primary-only.test/v1',
      features: { modelsRegistry: true },
      providers: {
        'personal-account': {
          type: 'openai',
          family: 'openai',
          baseUrl: 'https://primary-only.test/v1',
          activeKey: 'personal',
          apiKeys: [{ label: 'personal', apiKey: 'personal-key', createdAt: '' }],
          models: ['same-model'],
        },
        'work-account': {
          type: 'openai',
          family: 'openai',
          activeKey: 'work',
          apiKeys: [
            { label: 'old', apiKey: 'old-work-key', createdAt: '' },
            { label: 'work', apiKey: 'work-key', createdAt: '' },
          ],
          models: ['same-model'],
        },
      },
      fallbackModels: ['personal-account/same-model', 'work-account/same-model'],
      fallbackAuto: false,
    } as unknown as Config;
    const calls: Array<{
      alias: string;
      model: string;
      key: string | undefined;
      baseUrl: string | undefined;
    }> = [];
    const registry = new ProviderRegistry();
    const response = {
      content: [{ type: 'text', text: 'Work account answered' }],
      stopReason: 'end_turn',
      model: 'same-model',
      usage: { input: 1, output: 1 },
    } as Response;
    registry.register({
      type: 'openai',
      family: 'openai',
      create: (cfg) =>
        ({
          id: cfg.type,
          capabilities: {},
          complete: async (request: Request) => {
            calls.push({
              alias: cfg.type,
              model: request.model,
              key: resolveActiveApiKey(cfg),
              baseUrl: cfg.baseUrl,
            });
            if (cfg.type === 'personal-account')
              throw new ProviderError('rate limited', 429, true, cfg.type, { kind: 'rate_limit' });
            return response;
          },
          stream: vi.fn(),
        }) as unknown as Provider,
    });
    const build = (id: string) => buildProviderForId({ config, providerRegistry: registry }, id);
    const tracker = new ProviderModelStatusTracker();
    const manager = new FallbackProfileManager(config, { statusTracker: tracker });
    expect(manager.resolveRefs(config.fallbackModels!)).toHaveLength(2);
    const ctx = {
      provider: build('personal-account'),
      model: 'same-model',
      session: { id: 'profile-fallback' },
    } as Parameters<
      NonNullable<ReturnType<typeof createFallbackModelExtension>['wrapProviderRunner']>
    >[0];
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      fallbackProfileManager: manager,
      buildProvider: build,
      statusTracker: tracker,
      events: new EventBus(),
    });
    const request = { model: 'same-model', messages: [], maxTokens: 100 } as Request;
    const result = await ext.wrapProviderRunner!(ctx, request, (context, req) =>
      context.provider.complete(req, { signal: new AbortController().signal }),
    );
    expect(result).toBe(response);
    expect(calls).toEqual([
      {
        alias: 'personal-account',
        model: 'same-model',
        key: 'personal-key',
        baseUrl: 'https://primary-only.test/v1',
      },
      { alias: 'work-account', model: 'same-model', key: 'work-key', baseUrl: undefined },
    ]);
    expect(ctx.provider.id).toBe('work-account');
    expect(tracker.isAvailable('personal-account', 'same-model')).toBe(false);
    expect(tracker.isAvailable('work-account', 'same-model')).toBe(true);

    // Exercise real provider construction and HTTP headers as well as the
    // registry contract above. The account hop must reach the wire intact.
    const wireCalls: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization');
        wireCalls.push({ url: String(url), authorization });
        if (authorization === 'Bearer personal-key')
          return new globalThis.Response(
            JSON.stringify({ error: { message: 'Rate limit', type: 'rate_limit_error' } }),
            { status: 429 },
          );
        return new globalThis.Response(
          'data: {"choices":[{"delta":{"content":"Work account answered"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }),
    );
    try {
      const nativeConfig = { ...config, features: { ...config.features, modelsRegistry: false } };
      const nativeBuild = (id: string) =>
        buildProviderForId({ config: nativeConfig, providerRegistry: registry }, id);
      const nativeContext = ctx;
      nativeContext.provider = nativeBuild('personal-account');
      const nativeExtension = createFallbackModelExtension({
        getConfig: () => nativeConfig,
        buildProvider: nativeBuild,
        events: new EventBus(),
      });
      const nativeResponse = await nativeExtension.wrapProviderRunner!(
        nativeContext,
        { ...request },
        (context, req) => context.provider.complete(req, { signal: new AbortController().signal }),
      );
      expect(nativeResponse.content).toContainEqual({
        type: 'text',
        text: 'Work account answered',
      });
      expect(wireCalls).toEqual([
        {
          url: 'https://primary-only.test/v1/chat/completions',
          authorization: 'Bearer personal-key',
        },
        { url: 'https://api.openai.com/v1/chat/completions', authorization: 'Bearer work-key' },
      ]);
      expect(nativeContext.provider.id).toBe('work-account');
      // Selecting the fallback account as the configured primary must keep
      // using its own key and canonical endpoint on the next reconstruction.
      nativeConfig.provider = 'work-account';
      wireCalls.length = 0;
      await nativeBuild('work-account').complete(request, {
        signal: new AbortController().signal,
      });
      expect(wireCalls).toEqual([
        { url: 'https://api.openai.com/v1/chat/completions', authorization: 'Bearer work-key' },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
