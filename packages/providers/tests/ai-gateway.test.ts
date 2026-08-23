import type { ModelsRegistry, Request, StreamEvent, Tool } from '@wrongstack/core/types';
import { APICallError, type LanguageModelUsage, type TextStreamPart, type ToolSet } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiGatewayProvider,
  convertAiSdkStreamPart,
  convertMessages,
  convertProviderOptions,
  convertResponseFormat,
  convertTools,
  convertUsage,
  createAiGatewayProviderFactory,
  createStreamState,
  resolveGatewayWireBaseUrl,
  toProviderError,
} from '../src/ai-gateway.js';
import { capabilitiesFor } from '../src/capabilities.js';
import { capabilitiesForFamily } from '../src/family-capabilities.js';
import {
  buildProviderFactoriesFromRegistry,
  makeProviderFromConfig,
  withCatalogCapabilities,
} from '../src/index.js';

const usage: LanguageModelUsage = {
  inputTokens: 15,
  inputTokenDetails: {
    noCacheTokens: 10,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  },
  outputTokens: 7,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 2 },
  totalTokens: 22,
};

function request(overrides: Partial<Request> = {}): Request {
  return {
    model: 'anthropic/claude-test',
    system: [{ type: 'text', text: 'Be concise.' }],
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 128,
    ...overrides,
  };
}

async function* parts(values: TextStreamPart<ToolSet>[]): AsyncIterable<TextStreamPart<ToolSet>> {
  yield* values;
}

/**
 * A stream that fails on the first pull. Not a generator — a throw-only
 * `async function*` trips `lint/correctness/useYield`.
 */
function failingStream(raise: () => unknown): AsyncIterable<TextStreamPart<ToolSet>> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(raise()) }),
  };
}

async function collect(provider: AiGatewayProvider, req = request()): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of provider.stream(req, {
    signal: new AbortController().signal,
  })) {
    result.push(event);
  }
  return result;
}

describe('AiGatewayProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes a single-step request to AI SDK with retries disabled', async () => {
    const streamTextImpl = vi.fn(() => ({
      stream: parts([
        { type: 'text-start', id: 'txt-1' },
        { type: 'text-delta', id: 'txt-1', text: 'hello ' },
        { type: 'text-delta', id: 'txt-1', text: 'world' },
        { type: 'text-end', id: 'txt-1' },
        { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
      ]),
    }));
    const model = { specificationVersion: 'v4' } as never;
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => model,
      streamTextImpl: streamTextImpl as never,
    });

    const response = await provider.complete(
      request({
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        seed: 42,
        reasoning: { enabled: true, effort: 'max' },
      }),
      { signal: new AbortController().signal },
    );

    expect(streamTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        system: 'Be concise.',
        messages: [{ role: 'user', content: 'hello' }],
        maxOutputTokens: 128,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        seed: 42,
        reasoning: 'xhigh',
        maxRetries: 0,
      }),
    );
    expect(response).toEqual({
      model: 'anthropic/claude-test',
      content: [{ type: 'text', text: 'hello world' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 7, cacheRead: 3, cacheWrite: 2 },
    });
  });

  it('maps streamed tool input and preserves provider metadata', async () => {
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => ({ specificationVersion: 'v4' }) as never,
      streamTextImpl: (() => ({
        stream: parts([
          { type: 'tool-input-start', id: 'call-1', toolName: 'search' },
          { type: 'tool-input-delta', id: 'call-1', delta: '{"q":' },
          { type: 'tool-input-delta', id: 'call-1', delta: '"docs"}' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'search',
            input: { q: 'docs' },
            providerMetadata: { gateway: { route: 'anthropic' } },
            dynamic: true,
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_use',
            totalUsage: usage,
          },
        ]),
      })) as never,
    });

    const response = await provider.complete(request(), {
      signal: new AbortController().signal,
    });

    expect(response.stopReason).toBe('tool_use');
    expect(response.content).toEqual([
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'search',
        input: { q: 'docs' },
        providerMeta: { gateway: { route: 'anthropic' } },
      },
    ]);
  });

  it('surfaces reasoning stream parts', () => {
    const events = [
      ...convertAiSdkStreamPart({
        type: 'reasoning-start',
        id: 'reason-1',
        providerMetadata: { anthropic: { signature: 'sig' } },
      }),
      ...convertAiSdkStreamPart({ type: 'reasoning-delta', id: 'reason-1', text: 'thinking' }),
      ...convertAiSdkStreamPart({ type: 'reasoning-end', id: 'reason-1' }),
    ];

    expect(events).toEqual([
      {
        type: 'thinking_start',
        providerMeta: { anthropic: { signature: 'sig' } },
      },
      { type: 'thinking_delta', text: 'thinking' },
      { type: 'thinking_stop' },
    ]);
  });

  it('emits the thinking signature that only arrives on reasoning-end', () => {
    const state = createStreamState();
    const events = [
      ...convertAiSdkStreamPart({ type: 'reasoning-start', id: 'r1' }, 'ai-gateway', state),
      ...convertAiSdkStreamPart(
        { type: 'reasoning-delta', id: 'r1', text: 'thinking' },
        'ai-gateway',
        state,
      ),
      ...convertAiSdkStreamPart(
        { type: 'reasoning-end', id: 'r1', providerMetadata: { anthropic: { signature: 'sig' } } },
        'ai-gateway',
        state,
      ),
    ];

    expect(events).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: 'thinking' },
      { type: 'thinking_signature', signature: 'sig' },
      { type: 'thinking_stop' },
    ]);
  });

  it('keeps a tool call that arrives without a streamed tool-input-start', async () => {
    // Upstreams that emit the call in one piece never send tool-input-start;
    // both WrongStack aggregators key their buffer on that event.
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => ({ specificationVersion: 'v4' }) as never,
      streamTextImpl: (() => ({
        stream: parts([
          {
            type: 'tool-call',
            toolCallId: 'call-9',
            toolName: 'search',
            input: { q: 'docs' },
            dynamic: true,
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_use',
            totalUsage: usage,
          },
        ]),
      })) as never,
    });

    const response = await provider.complete(request(), {
      signal: new AbortController().signal,
    });

    expect(response.content).toEqual([
      { type: 'tool_use', id: 'call-9', name: 'search', input: { q: 'docs' } },
    ]);
  });

  it('does not announce a tool twice when the input was streamed', async () => {
    const events = await collect(
      new AiGatewayProvider({
        apiKey: 'test-key',
        resolveModel: () => ({ specificationVersion: 'v4' }) as never,
        streamTextImpl: (() => ({
          stream: parts([
            { type: 'tool-input-start', id: 'call-1', toolName: 'search' },
            { type: 'tool-input-delta', id: 'call-1', delta: '{"q":"docs"}' },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'search',
              input: { q: 'docs' },
              dynamic: true,
            },
          ]),
        })) as never,
      }),
    );

    expect(events.filter((e) => e.type === 'tool_use_start')).toHaveLength(1);
  });

  it('resolves the output ceiling from capabilities when the request omits it', async () => {
    const streamTextImpl = vi.fn(() => ({ stream: parts([]) }));
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      capabilities: capabilitiesForFamily('openai-compatible', { maxOutput: 64_000 }),
      resolveModel: () => ({ specificationVersion: 'v4' }) as never,
      streamTextImpl: streamTextImpl as never,
    });

    await provider.complete(request({ maxTokens: undefined }), {
      signal: new AbortController().signal,
    });

    expect(streamTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 64_000 }),
    );
  });

  it('passes spend attribution and cache intent through the gateway namespace', async () => {
    const streamTextImpl = vi.fn(() => ({ stream: parts([]) }));
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => ({ specificationVersion: 'v4' }) as never,
      streamTextImpl: streamTextImpl as never,
    });

    await provider.complete(request({ user: 'user-42', cache: { ttl: '5m' } }), {
      signal: new AbortController().signal,
    });

    expect(streamTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { gateway: { user: 'user-42', caching: 'auto' } },
      }),
    );
  });

  it('omits providerOptions entirely when the request carries none', async () => {
    const streamTextImpl = vi.fn(() => ({ stream: parts([]) }));
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => ({ specificationVersion: 'v4' }) as never,
      streamTextImpl: streamTextImpl as never,
    });

    await provider.complete(request(), { signal: new AbortController().signal });

    const firstCall = streamTextImpl.mock.calls[0] as [Record<string, unknown>] | undefined;
    expect(firstCall?.[0]).not.toHaveProperty('providerOptions');
  });

  it('scopes safety settings to Google-routed models only', () => {
    const safetySettings = [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }];

    expect(
      convertProviderOptions(request({ model: 'google/gemini-3.6-flash', safetySettings })),
    ).toEqual({ google: { safetySettings } });

    // The same knob must not ride along on a request the Gateway routes to
    // an upstream that has never heard of it.
    expect(
      convertProviderOptions(request({ model: 'anthropic/claude-test', safetySettings })),
    ).toEqual({});
  });

  it('maps a JSON-schema response format onto a native response format', async () => {
    const output = convertResponseFormat({
      type: 'json_schema',
      jsonSchema: {
        name: 'verdict',
        description: 'the call',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    });

    expect(await output?.responseFormat).toMatchObject({
      type: 'json',
      name: 'verdict',
      description: 'the call',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(convertResponseFormat({ type: 'text' })).toBeUndefined();
    expect(convertResponseFormat(undefined)).toBeUndefined();
    expect(await convertResponseFormat({ type: 'json_object' })?.responseFormat).toMatchObject({
      type: 'json',
    });
  });

  it('rethrows aborts without converting them into ProviderError', async () => {
    const controller = new AbortController();
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => ({ specificationVersion: 'v4' }) as never,
      streamTextImpl: (() => ({
        stream: failingStream(() => {
          controller.abort();
          return new DOMException('cancelled', 'AbortError');
        }),
      })) as never,
    });

    await expect(provider.complete(request(), { signal: controller.signal })).rejects.toMatchObject(
      { name: 'AbortError', message: 'cancelled' },
    );
  });

  it('normalizes AI SDK API errors for WrongStack fallback policy', async () => {
    const apiError = new APICallError({
      message: 'gateway overloaded',
      url: 'https://ai-gateway.vercel.sh/v4/ai',
      requestBodyValues: {},
      statusCode: 503,
      responseBody: '{"error":"busy"}',
      isRetryable: true,
    });
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => ({ specificationVersion: 'v4' }) as never,
      streamTextImpl: (() => ({
        stream: failingStream(() => apiError),
      })) as never,
    });

    await expect(
      provider.complete(request(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      providerId: 'ai-gateway',
      status: 503,
      retryable: true,
      kind: 'server',
      body: { raw: '{"error":"busy"}' },
    });
    expect(toProviderError(apiError)).toMatchObject({ status: 503, retryable: true });
  });

  it('honours a Gateway error that is not an APICallError', () => {
    // Observed live: an account with no payment method answers 403 with
    // `isRetryable: false`. GatewayError does not extend APICallError, so the
    // generic branch used to report `status 0` / retryable — which made
    // WrongStack retry a permanent failure instead of surfacing it.
    class GatewayInternalServerError extends Error {
      readonly statusCode = 403;
      readonly isRetryable = false;
      readonly type = 'internal_server_error';
    }

    expect(toProviderError(new GatewayInternalServerError('needs a credit card'))).toMatchObject({
      status: 403,
      retryable: false,
      kind: 'auth',
      body: { type: 'internal_server_error' },
    });
  });

  it('still treats a shapeless error as a retryable transport fault', () => {
    expect(toProviderError(new Error('socket hang up'))).toMatchObject({
      status: 0,
      retryable: true,
    });
  });

  it('normalizes synchronous model-resolution errors too', async () => {
    const apiError = new APICallError({
      message: 'model unavailable',
      url: 'https://ai-gateway.vercel.sh/v4/ai',
      requestBodyValues: {},
      statusCode: 404,
      isRetryable: false,
    });
    const provider = new AiGatewayProvider({
      apiKey: 'test-key',
      resolveModel: () => {
        throw apiError;
      },
    });

    await expect(
      provider.complete(request(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      providerId: 'ai-gateway',
      status: 404,
      retryable: false,
      kind: 'invalid_request',
    });
  });

  it('adds the AI Gateway factory to the built-in registry factories', async () => {
    const registry = {
      listProviders: vi.fn().mockResolvedValue([]),
    } as never as ModelsRegistry;

    const factories = await buildProviderFactoriesFromRegistry({ registry });

    expect(factories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ai-gateway', family: 'openai-compatible' }),
      ]),
    );
  });

  it('reads AI_GATEWAY_API_KEY when config contains no stored key', () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-env-key');
    const factory = createAiGatewayProviderFactory();

    expect(() => factory.create({ type: 'ai-gateway' })).not.toThrow();
  });

  it('constructs from config when the models registry is disabled', () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-env-key');

    const provider = makeProviderFromConfig('ai-gateway', {
      type: 'ai-gateway',
      envVars: ['AI_GATEWAY_API_KEY'],
    });

    expect(provider).toBeInstanceOf(AiGatewayProvider);
    expect(provider.id).toBe('ai-gateway');
  });

  it('creates a registerable factory and selects the active API key', () => {
    const factory = createAiGatewayProviderFactory();
    const provider = factory.create({
      type: 'ai-gateway',
      apiKeys: [
        { label: 'old', apiKey: 'old-key', createdAt: '2026-01-01T00:00:00Z' },
        { label: 'work', apiKey: 'work-key', createdAt: '2026-01-02T00:00:00Z' },
      ],
      activeKey: 'work',
    });

    expect(factory).toMatchObject({ type: 'ai-gateway', family: 'openai-compatible' });
    expect(provider).toBeInstanceOf(AiGatewayProvider);
  });

  it('preserves a user-visible alias id through the ai-gateway factory', () => {
    const factory = createAiGatewayProviderFactory();
    const provider = factory.create({ type: 'gateway-work', apiKey: 'test-key' });

    expect(provider.id).toBe('gateway-work');
  });

  it('falls back to the first key when activeKey is stale', () => {
    const factory = createAiGatewayProviderFactory();
    expect(() =>
      factory.create({
        type: 'ai-gateway',
        apiKeys: [{ label: 'first', apiKey: 'first-key', createdAt: '2026-01-01T00:00:00Z' }],
        activeKey: 'missing',
      }),
    ).not.toThrow();
  });
});

describe('AI Gateway wire base URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops the Vercel Gateway model-list base so the SDK keeps its wire default', () => {
    // The catalog preset — and therefore many saved configs — carries `/v1`,
    // which is the model-list endpoint, not the wire endpoint.
    expect(resolveGatewayWireBaseUrl('https://ai-gateway.vercel.sh/v1')).toBeUndefined();
    expect(resolveGatewayWireBaseUrl('https://ai-gateway.vercel.sh/v4/ai')).toBeUndefined();
    expect(resolveGatewayWireBaseUrl('https://AI-Gateway.Vercel.SH/v1')).toBeUndefined();
  });

  it('passes a self-hosted or proxied gateway base URL through untouched', () => {
    expect(resolveGatewayWireBaseUrl('https://gateway.internal.example/v4/ai')).toBe(
      'https://gateway.internal.example/v4/ai',
    );
    expect(resolveGatewayWireBaseUrl('http://localhost:9999/ai')).toBe('http://localhost:9999/ai');
  });

  it('ignores an unparseable base URL rather than building a broken request URL', () => {
    expect(resolveGatewayWireBaseUrl(undefined)).toBeUndefined();
    expect(resolveGatewayWireBaseUrl('not a url')).toBeUndefined();
  });

  it('never requests /v1/language-model for a config holding the model-list base', async () => {
    // End-to-end guard on the real AI SDK client: the transport, not just the
    // helper, must land on the Gateway's wire path.
    const urls: string[] = [];
    const fetchSpy = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      throw new Error('stop after URL capture');
    });
    vi.stubGlobal('fetch', fetchSpy);
    // The failing fetch surfaces through AI SDK streamText's default onError
    // handler, which console.errors the wrapped GatewayResponseError. Silence
    // it (restoreMocks re-enables it for later tests) so expected-failure
    // noise doesn't bury real failures in test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider = createAiGatewayProviderFactory().create({
      type: 'ai-gateway',
      apiKey: 'test-key',
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
    });

    await expect(
      (async () => {
        for await (const _ of provider.stream(
          { model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }] },
          { signal: new AbortController().signal },
        )) {
          // Drain; the stubbed fetch fails before any event can arrive.
        }
      })(),
    ).rejects.toThrow();

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.endsWith('/v1/language-model'))).toBe(false);
    expect(urls.some((url) => url.includes('/ai/language-model'))).toBe(true);
  });
});

describe('AI Gateway catalog capability overlay', () => {
  function registryFor(providers: Record<string, unknown>, models: Record<string, unknown>) {
    return {
      getProvider: vi.fn(async (id: string) => providers[id]),
      getModel: vi.fn(
        async (providerId: string, modelId: string) => models[`${providerId}/${modelId}`],
      ),
      listProviders: vi.fn().mockResolvedValue([]),
    } as never as ModelsRegistry;
  }

  it('resolves per-model facts from the models.dev `vercel` gateway catalog', async () => {
    // models.dev publishes the Gateway as provider `vercel`, keyed by the
    // gateway-form model id verbatim — NOT under `anthropic`, which slugs the
    // 4.x generation as `claude-sonnet-4-6` — the two catalogs are not
    // guaranteed to agree on a slug.
    const registry = registryFor(
      { vercel: { id: 'vercel', family: 'unsupported', models: [] } },
      {
        'vercel/anthropic/claude-sonnet-5': {
          capabilities: {
            tools: true,
            vision: true,
            reasoning: true,
            maxContext: 200_000,
            maxOutput: 64_000,
          },
        },
      },
    );

    const overlaid = await withCatalogCapabilities(
      registry,
      'gateway-work',
      new AiGatewayProvider({ apiKey: 'k' }),
      { type: 'ai-gateway', model: 'anthropic/claude-sonnet-5' },
    );

    expect(registry.getModel).toHaveBeenCalledWith('vercel', 'anthropic/claude-sonnet-5');
    expect(overlaid.capabilities).toMatchObject({
      tools: true,
      vision: true,
      reasoning: true,
      maxContext: 200_000,
      maxOutput: 64_000,
    });
  });

  it('keeps the transport usable when the catalog knows nothing about the model', async () => {
    const registry = registryFor({}, {});

    const overlaid = await withCatalogCapabilities(
      registry,
      'ai-gateway',
      new AiGatewayProvider({ apiKey: 'k' }),
      { type: 'ai-gateway', model: 'someprovider/some-model' },
    );

    // The `unsupported` family baseline would report tools: false and
    // streaming: false, silently disabling every tool call on the session.
    expect(overlaid.capabilities).toMatchObject({
      tools: true,
      streaming: true,
      systemPrompt: true,
    });
  });

  it('leaves non-gateway providers on their own catalog id', async () => {
    const registry = registryFor(
      { vercel: { id: 'vercel', family: 'unsupported', models: [] } },
      {
        'vercel/anthropic/claude-sonnet-5': { capabilities: { tools: true, maxContext: 200_000 } },
      },
    );

    await capabilitiesFor(registry, 'my-custom', 'anthropic/claude-sonnet-5');

    expect(registry.getProvider).toHaveBeenCalledWith('my-custom');
    expect(registry.getProvider).not.toHaveBeenCalledWith('vercel');
  });
});

describe('AI SDK conversion helpers', () => {
  it('keeps fresh and cached token counts disjoint', () => {
    expect(convertUsage(usage)).toEqual({
      input: 10,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
    });
  });

  it('preserves hybrid-gateway input deltas when separate cache exceeds input', () => {
    expect(
      convertUsage({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 15_000 },
        outputTokens: 20,
        outputTokenDetails: {},
        totalTokens: 15_120,
      }),
    ).toEqual({ input: 100, output: 20, cacheRead: 15_000 });
  });

  it('converts compacted system history into accepted user context', () => {
    expect(convertMessages([{ role: 'system', content: '[prior_turns_digest: summary]' }])).toEqual(
      [{ role: 'user', content: '[system context]\n[prior_turns_digest: summary]' }],
    );
  });

  it('keeps tool results adjacent to the assistant call that produced them', () => {
    // PostToolUse `contextAs: 'separate'` merges a leading text block into the
    // same user message as the results; the tool message must still land first.
    expect(
      convertMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'result follows' },
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              name: 'search',
              content: '{"ok":true}',
              is_error: true,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'search',
            output: { type: 'error-text', value: '{"ok":true}' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'result follows' }] },
    ]);
  });

  it('round-trips an Anthropic thinking signature as provider options', () => {
    expect(
      convertMessages([
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'weighing options', signature: 'sig-abc' }],
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'weighing options',
            providerOptions: { anthropic: { signature: 'sig-abc' } },
          },
        ],
      },
    ]);
  });

  it('declares tools without giving AI SDK execution ownership', () => {
    const wrongStackTool: Tool = {
      name: 'search',
      description: 'Search docs',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
      permission: 'auto',
      mutating: false,
      execute: vi.fn(),
    };

    const converted = convertTools([wrongStackTool]);
    expect(converted.search).toMatchObject({ description: 'Search docs' });
    expect(converted.search).not.toHaveProperty('execute');
  });
});
