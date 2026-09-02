import { describe, expect, it } from 'vitest';
import {
  discoverOpenAICompatibleModels,
  mapCompatibleModel,
  resolveDiscoveryTargets,
} from '../src/auto-discover.js';

describe('mapCompatibleModel', () => {
  it('maps omniroute extended metadata onto a ModelsDevModel', () => {
    const m = mapCompatibleModel({
      id: 'cc/claude-opus-4-8',
      name: 'cc/Claude Opus 4.8',
      capabilities: { vision: true, tool_calling: true, reasoning: true, thinking: true },
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      context_length: 1000000,
      max_output_tokens: 128000,
      max_input_tokens: 1000000,
      created: 1782750388,
    });
    expect(m).toMatchObject({
      id: 'cc/claude-opus-4-8',
      name: 'cc/Claude Opus 4.8',
      tool_call: true,
      reasoning: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1000000, output: 128000 },
    });
  });

  it('infers vision from an image input modality when capability flag is absent', () => {
    const m = mapCompatibleModel({
      id: 'x/vision-model',
      input_modalities: ['text', 'image'],
      capabilities: { tool_calling: false },
    });
    expect(m?.modalities?.input).toContain('image');
  });

  it('treats reasoning OR thinking as reasoning-capable', () => {
    expect(mapCompatibleModel({ id: 'a', capabilities: { thinking: true } })?.reasoning).toBe(true);
    expect(mapCompatibleModel({ id: 'b', capabilities: { reasoning: true } })?.reasoning).toBe(
      true,
    );
    expect(mapCompatibleModel({ id: 'c', capabilities: { reasoning: false } })?.reasoning).toBe(
      false,
    );
  });

  it('leaves a capability UNSTATED when the source says nothing about it', () => {
    // A silent source must not be read as "unsupported": `capabilitiesFor`
    // inherits the transport baseline for `undefined` but restricts on `false`,
    // and collapsing the two made every metadata-less model tool-less.
    const silent = mapCompatibleModel({ id: 'c', capabilities: {} });
    expect(silent).not.toHaveProperty('reasoning');
    expect(silent).not.toHaveProperty('tool_call');
    expect(silent).not.toHaveProperty('temperature');

    const explicit = mapCompatibleModel({ id: 'd', capabilities: { tool_calling: false } });
    expect(explicit?.tool_call).toBe(false);
  });

  it('falls back to the id for the display name and drops invalid limits', () => {
    const m = mapCompatibleModel({ id: 'bare', context_length: 0, max_output_tokens: -1 });
    expect(m?.name).toBe('bare');
    expect(m?.limit).toBeUndefined();
  });

  it('returns undefined for an entry with no id', () => {
    expect(mapCompatibleModel({ name: 'no id' })).toBeUndefined();
  });

  it('maps a REAL OpenRouter /api/v1/models entry', () => {
    // Captured verbatim from https://openrouter.ai/api/v1/models. OpenRouter
    // states capabilities as a parameter list and nests modalities and
    // ceilings — none of which the omniroute-shaped mapping reached.
    const m = mapCompatibleModel({
      id: 'anthropic/claude-sonnet-5',
      canonical_slug: 'anthropic/claude-sonnet-5-20260630',
      name: 'Anthropic: Claude Sonnet 5',
      created: 1782843083,
      context_length: 1000000,
      architecture: {
        modality: 'text+image+file->text',
        input_modalities: ['text', 'image', 'file'],
        output_modalities: ['text'],
        tokenizer: 'Claude',
      },
      pricing: {
        prompt: '0.000002',
        completion: '0.00001',
        web_search: '0.01',
        input_cache_read: '0.0000002',
        input_cache_write: '0.0000025',
        input_cache_write_1h: '0.000004',
      },
      top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
      supported_parameters: [
        'include_reasoning',
        'max_completion_tokens',
        'max_tokens',
        'reasoning',
        'reasoning_effort',
        'response_format',
        'stop',
        'structured_outputs',
        'tool_choice',
        'tools',
        'verbosity',
      ],
    } as never);

    expect(m).toMatchObject({
      id: 'anthropic/claude-sonnet-5',
      tool_call: true,
      reasoning: true,
      // The list omits `temperature` — real, and it matches what models.dev
      // publishes for this model. Newer reasoning models reject the parameter,
      // so an enumerated list without it is a statement, not an omission.
      temperature: false,
      modalities: { input: ['text', 'image', 'file'], output: ['text'] },
      limit: { context: 1000000, output: 128000 },
      // per-token USD on the wire → per-1M USD, the models.dev unit
      cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    });
    // `web_search` is priced per call, not per token.
    expect(m?.cost).not.toHaveProperty('web_search');
  });

  it('reads an enumerated parameter list as an explicit capability denial', () => {
    // The array's PRESENCE is the signal: a server that lists its parameters
    // and omits `tools` is saying "no tools", not "I don't know".
    const m = mapCompatibleModel({
      id: 'x/no-tools',
      supported_parameters: ['temperature', 'top_p'],
    });
    expect(m?.tool_call).toBe(false);
    expect(m?.reasoning).toBe(false);
  });

  it('maps a REAL Vercel AI Gateway /v1/models entry', () => {
    // Captured verbatim from https://ai-gateway.vercel.sh/v1/models. The field
    // names differ from every other shape we handle — `context_window` (not
    // `context_length`), `type` (not `modelType`), and one nested `modalities`
    // object — so an invented fixture would have passed while the real
    // endpoint silently produced no context window and no model-class filter.
    const m = mapCompatibleModel({
      id: 'anthropic/claude-sonnet-5',
      object: 'model',
      name: 'Claude Sonnet 5',
      type: 'language',
      context_window: 1000000,
      max_tokens: 128000,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      supported_parameters: [
        'max_tokens',
        'temperature',
        'stop',
        'tools',
        'tool_choice',
        'reasoning',
        'include_reasoning',
      ],
      temperature: true,
      pricing: {
        input: '0.000002',
        output: '0.00001',
        input_cache_read: '0.0000002',
        input_cache_write: '0.0000025',
        web_search: '10',
        regional: { eu: { input: '0.0000022' } },
      },
    } as never);

    expect(m).toMatchObject({
      id: 'anthropic/claude-sonnet-5',
      tool_call: true,
      reasoning: true,
      temperature: true,
      limit: { context: 1000000, output: 128000 },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    });
    // `web_search` and `regional` are priced differently and must not be
    // mistaken for token rates.
    expect(Object.keys(m?.cost ?? {}).sort()).toEqual([
      'cache_read',
      'cache_write',
      'input',
      'output',
    ]);
  });

  it('drops gateway entries that are not language models', () => {
    // A gateway lists embeddings, image, speech and video alongside chat
    // models; offering `whisper-1` in a model picker is worse than omitting it.
    // Live census of the Gateway: 315 models, only 208 `language`. The rest
    // are embedding/video/image/reranking/transcription/realtime/speech.
    expect(
      mapCompatibleModel({ id: 'openai/whisper-1', type: 'transcription' } as never),
    ).toBeUndefined();
    expect(
      mapCompatibleModel({ id: 'alibaba/qwen3-embedding-0.6b', type: 'embedding' } as never),
    ).toBeUndefined();
    expect(mapCompatibleModel({ id: 'openai/gpt-image-2', modelType: 'image' })).toBeUndefined();
    expect(mapCompatibleModel({ id: 'openai/gpt-5.6-sol', type: 'language' } as never)?.id).toBe(
      'openai/gpt-5.6-sol',
    );
    // Providers that report no modelType still get filtered on output modality.
    expect(
      mapCompatibleModel({ id: 'x/embed', architecture: { output_modalities: ['embedding'] } }),
    ).toBeUndefined();
  });

  it('maps Vercel Gateway pricing field names', () => {
    const m = mapCompatibleModel({
      id: 'anthropic/claude-opus-5',
      modelType: 'language',
      pricing: {
        input: '0.000005',
        output: '0.000025',
        cachedInputTokens: '0.0000005',
        cacheCreationInputTokens: '0.00000625',
      },
    });
    expect(m?.cost).toEqual({ input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 });
  });
});

function mockModelsFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    })) as never as typeof fetch;
}

describe('discoverOpenAICompatibleModels', () => {
  it('builds a ModelsDevProvider classified to the openai-compatible family', async () => {
    const provider = await discoverOpenAICompatibleModels('omniroute', {
      baseUrl: 'http://localhost:20128/v1',
      apiKey: 'k',
      fetchImpl: mockModelsFetch({
        object: 'list',
        data: [
          { id: 'cc/claude-opus-4-8', capabilities: { tool_calling: true, reasoning: true } },
          { id: 'openai/gpt-5-codex', capabilities: { tool_calling: true } },
        ],
      }),
    });
    expect(provider?.id).toBe('omniroute');
    expect(provider?.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider?.api).toBe('http://localhost:20128/v1');
    expect(Object.keys(provider?.models ?? {})).toEqual([
      'cc/claude-opus-4-8',
      'openai/gpt-5-codex',
    ]);
  });

  it('returns undefined on a non-OK response (best-effort)', async () => {
    const provider = await discoverOpenAICompatibleModels('omniroute', {
      baseUrl: 'http://localhost:20128/v1',
      fetchImpl: mockModelsFetch({}, false),
    });
    expect(provider).toBeUndefined();
  });

  it('returns undefined on an empty list', async () => {
    const provider = await discoverOpenAICompatibleModels('omniroute', {
      baseUrl: 'http://localhost:20128/v1',
      fetchImpl: mockModelsFetch({ object: 'list', data: [] }),
    });
    expect(provider).toBeUndefined();
  });

  it('never throws on a network error', async () => {
    const provider = await discoverOpenAICompatibleModels('omniroute', {
      baseUrl: 'http://localhost:20128/v1',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as never as typeof fetch,
    });
    expect(provider).toBeUndefined();
  });
});

describe('resolveDiscoveryTargets', () => {
  const cfg = (providers: Record<string, unknown>) =>
    ({ providers }) as never as Parameters<typeof resolveDiscoveryTargets>[0];

  it('makes the AI Gateway discoverable from its definition alone', () => {
    // The user enters a key and nothing else; the model list must not depend
    // on models.dev knowing the provider.
    const [target] = resolveDiscoveryTargets(cfg({ 'ai-gateway': { type: 'ai-gateway' } }));

    expect(target).toMatchObject({
      id: 'ai-gateway',
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
    });
  });

  it('lets a user alias inherit the preset through cfg.type', () => {
    // Looked up by the config key alone, `gateway-work` would silently opt out
    // of discovery and show an empty model list.
    const [target] = resolveDiscoveryTargets(cfg({ 'gateway-work': { type: 'ai-gateway' } }));

    expect(target).toMatchObject({
      id: 'gateway-work',
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
    });
  });

  it('keys the cache on id + baseUrl so both hosts share entries', () => {
    // The CLI and WebUI copies used different separators and so never shared a
    // cache entry despite writing to the same file.
    const [target] = resolveDiscoveryTargets(cfg({ openrouter: { type: 'openrouter' } }));
    expect(target?.cacheKey).toContain('openrouter');
    expect(target?.cacheKey).toContain('https://openrouter.ai/api/v1');
  });

  it('skips providers that never opted in', () => {
    expect(resolveDiscoveryTargets(cfg({ anthropic: { type: 'anthropic' } }))).toEqual([]);
  });

  it('honours an explicit autoDiscoverModels opt-out', () => {
    expect(
      resolveDiscoveryTargets(
        cfg({ 'ai-gateway': { type: 'ai-gateway', autoDiscoverModels: false } }),
      ),
    ).toEqual([]);
  });
});
