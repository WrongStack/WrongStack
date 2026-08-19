import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultModelsRegistry, classifyFamily } from '../../src/models/models-registry.js';
import type { ModelsDevPayload } from '../../src/types/models-registry.js';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    doc: 'https://docs.anthropic.com',
    models: {
      'anthropic-test-model': {
        id: 'anthropic-test-model',
        name: 'Anthropic Test Model',
        release_date: '2025-09-01',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 3, output: 15 },
        limit: { context: 200_000, output: 8192 },
      },
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        release_date: '2025-11-15',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 15, output: 75 },
        limit: { context: 200_000 },
      },
    },
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    npm: '@ai-sdk/google',
    models: {
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        release_date: '2025-09-01',
        tool_call: true,
        limit: { context: 1_000_000 },
        cost: { input: 0.075, output: 0.3 },
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    npm: '@ai-sdk/mistral',
    models: {},
  },
};

describe('classifyFamily', () => {
  it('maps anthropic family', () => {
    expect(classifyFamily('@ai-sdk/anthropic')).toBe('anthropic');
  });
  it('maps openai family', () => {
    expect(classifyFamily('@ai-sdk/openai')).toBe('openai');
  });
  it('maps openai-compatible aliases', () => {
    expect(classifyFamily('@ai-sdk/groq')).toBe('openai-compatible');
    expect(classifyFamily('@ai-sdk/xai')).toBe('openai-compatible');
    expect(classifyFamily('@openrouter/ai-sdk-provider')).toBe('openai-compatible');
  });
  it('maps google', () => {
    expect(classifyFamily('@ai-sdk/google')).toBe('google');
  });
  it('marks unknown as unsupported', () => {
    expect(classifyFamily('@ai-sdk/cohere')).toBe('unsupported');
    expect(classifyFamily(undefined)).toBe('unsupported');
  });
});

describe('DefaultModelsRegistry', () => {
  let cacheDir: string;
  let cacheFile: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mreg-'));
    cacheFile = path.join(cacheDir, 'models.dev.json');
  });
  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('uses seed payload without network', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    const providers = await reg.listProviders();
    expect(providers.map((p) => p.id).sort()).toEqual(['anthropic', 'google', 'mistral']);
  });

  it('classifies providers into families', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    const a = await reg.getProvider('anthropic');
    expect(a?.family).toBe('anthropic');
    const g = await reg.getProvider('google');
    expect(g?.family).toBe('google');
    const m = await reg.getProvider('mistral');
    expect(m?.family).toBe('openai-compatible');
  });

  it('classifies bundled subscription providers by id when npm is absent', async () => {
    const reg = new DefaultModelsRegistry({
      cacheFile,
      seed: {
        ...SAMPLE,
        'openai-codex': {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          models: {},
        },
      },
    });
    const p = await reg.getProvider('openai-codex');
    expect(p?.family).toBe('openai-codex');
  });

  it('getModel returns capabilities + cost', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    const m = await reg.getModel('anthropic', 'anthropic-test-model');
    expect(m?.capabilities.tools).toBe(true);
    expect(m?.capabilities.vision).toBe(true);
    expect(m?.capabilities.maxContext).toBe(200_000);
    expect(m?.cost?.input).toBe(3);
  });

  it('normalizes models.dev reasoning_options and interleaved metadata', async () => {
    const reg = new DefaultModelsRegistry({
      cacheFile,
      seed: {
        gateway: {
          id: 'gateway',
          name: 'Gateway',
          npm: '@ai-sdk/openai-compatible',
          models: {
            frontier: {
              id: 'frontier',
              name: 'Frontier',
              reasoning: true,
              reasoning_options: [
                { type: 'toggle' },
                { type: 'effort', values: ['low', 'high', 'max'] },
              ],
              interleaved: { field: 'reasoning_content' },
            },
          },
        },
      },
    });

    const model = await reg.getModel('gateway', 'frontier');

    expect(model?.capabilities.reasoningConfig).toEqual({
      default: 'enabled',
      disableSupported: true,
      effortSupported: true,
      effortLevels: ['low', 'high', 'max'],
      preserveThinking: 'always_on',
    });
  });

  it('marks reasoning:true with no options as effort-undocumented (B6 tri-state)', async () => {
    const reg = new DefaultModelsRegistry({
      cacheFile,
      seed: {
        gateway: {
          id: 'gateway',
          name: 'Gateway',
          npm: '@ai-sdk/openai-compatible',
          models: {
            silentthinker: {
              id: 'silentthinker',
              name: 'Silent Thinker',
              // reasoning: true, but the catalog publishes no reasoning_options
              // — effort vocabulary undocumented.
              reasoning: true,
            },
          },
        },
      },
    });

    const model = await reg.getModel('gateway', 'silentthinker');

    // `effortSupported` is ABSENT (not false): the catalog never said this
    // model lacks effort control, only that it didn't enumerate it. The
    // resolver forwards requested effort and the wire adapter gates it.
    expect(model?.capabilities.reasoningConfig).toEqual({
      default: 'always_on',
      disableSupported: false,
      effortLevels: [],
      preserveThinking: 'unsupported',
    });
    expect(
      model?.capabilities.reasoningConfig?.effortSupported,
    ).toBeUndefined();
  });

  it('marks toggle-only reasoning as effort-unsupported (documented absence)', async () => {
    const reg = new DefaultModelsRegistry({
      cacheFile,
      seed: {
        gateway: {
          id: 'gateway',
          name: 'Gateway',
          npm: '@ai-sdk/openai-compatible',
          models: {
            toggler: {
              id: 'toggler',
              name: 'Toggler',
              reasoning: true,
              reasoning_options: [{ type: 'toggle' }],
            },
          },
        },
      },
    });

    const model = await reg.getModel('gateway', 'toggler');

    // Options PRESENT and document that effort control does not exist —
    // explicit `false`, so the resolver drops effort with a warning.
    expect(model?.capabilities.reasoningConfig?.effortSupported).toBe(false);
    expect(model?.capabilities.reasoningConfig?.disableSupported).toBe(true);
  });

  it('marks an explicitly EMPTY reasoning_options array as documented absence', async () => {
    // The discriminator is `raw === undefined`, NOT `options.length === 0`:
    // `reasoning_options: []` is an explicit statement that this model has no
    // reasoning controls, so effortSupported must be `false` (reject+warn) —
    // distinct from a MISSING field, which leaves it `undefined` (forward).
    const reg = new DefaultModelsRegistry({
      cacheFile,
      seed: {
        gateway: {
          id: 'gateway',
          name: 'Gateway',
          npm: '@ai-sdk/openai-compatible',
          models: {
            emptyopts: {
              id: 'emptyopts',
              name: 'Empty Opts',
              reasoning: true,
              reasoning_options: [],
            },
          },
        },
      },
    });

    const model = await reg.getModel('gateway', 'emptyopts');
    expect(model?.capabilities.reasoningConfig?.effortSupported).toBe(false);
  });

  it('suggestModel returns the newest', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    expect(await reg.suggestModel('anthropic')).toBe('claude-opus-4-7');
  });

  it('mergeOverlay injects a runtime-discovered provider with resolvable capabilities', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    await reg.load();
    reg.mergeOverlay({
      omniroute: {
        id: 'omniroute',
        name: 'OmniRoute',
        npm: '@ai-sdk/openai-compatible',
        api: 'http://localhost:20128/v1',
        models: {
          'cc/claude-opus-4-8': {
            id: 'cc/claude-opus-4-8',
            name: 'cc/Claude Opus 4.8',
            tool_call: true,
            reasoning: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 1_000_000, output: 128_000 },
          },
        },
      },
    });
    const providers = await reg.listProviders();
    expect(providers.map((p) => p.id)).toContain('omniroute');
    const prov = await reg.getProvider('omniroute');
    expect(prov?.family).toBe('openai-compatible');
    const model = await reg.getModel('omniroute', 'cc/claude-opus-4-8');
    expect(model?.capabilities.tools).toBe(true);
    expect(model?.capabilities.reasoning).toBe(true);
    expect(model?.capabilities.vision).toBe(true);
    expect(model?.capabilities.maxContext).toBe(1_000_000);
    expect(model?.capabilities.maxOutput).toBe(128_000);
  });

  it('keeps a discovered provider when mergeOverlay runs before the first load()', async () => {
    // The seed path returned the seed verbatim, dropping `extraOverlay`, so a
    // discovery that landed before anything called load() vanished. The test
    // above happens to call load() first and so never exercised this. It is the
    // ordering an offline local gateway hits.
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    reg.mergeOverlay({
      omniroute: {
        id: 'omniroute',
        name: 'OmniRoute',
        npm: '@ai-sdk/openai-compatible',
        api: 'http://localhost:20128/v1',
        models: {
          'cc/model': { id: 'cc/model', name: 'cc/model', limit: { context: 1000, output: 100 } },
        },
      },
    });

    expect((await reg.listProviders()).map((p) => p.id)).toContain('omniroute');
    expect(await reg.getModel('omniroute', 'cc/model')).toBeDefined();
  });

  it('mergeOverlay survives a refresh()', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(SAMPLE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl });
    await reg.load();
    reg.mergeOverlay({
      omniroute: {
        id: 'omniroute',
        name: 'OmniRoute',
        npm: '@ai-sdk/openai-compatible',
        models: { m: { id: 'm', name: 'm' } },
      },
    });
    await reg.refresh();
    const providers = await reg.listProviders();
    expect(providers.map((p) => p.id)).toContain('omniroute');
  });

  it('refresh writes cache via fetch impl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE,
    } as never as Response) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl });
    await reg.refresh();
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    expect(cached.payload.anthropic).toBeDefined();
    expect(cached.fetchedAt).toBeTruthy();
  });

  it('load falls back to stale cache on network failure', async () => {
    // Pre-write stale cache (recent enough to pass maxStaleAgeSeconds check)
    const recentCache = {
      fetchedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
      url: 'https://models.dev/api.json',
      payload: SAMPLE,
    };
    await fs.writeFile(cacheFile, JSON.stringify(recentCache));
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, ttlSeconds: 0 });
    const payload = await reg.load();
    expect(Object.keys(payload).length).toBeGreaterThan(0);
  });

  it('throws when network fails and no cache exists', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as never as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl });
    await expect(reg.load()).rejects.toThrow(/offline/);
  });

  it('reports ageSeconds', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    await reg.load();
    const age = await reg.ageSeconds();
    expect(age).toBeLessThan(60);
  });

  describe('overlay merge', () => {
    const okFetch = (payload: ModelsDevPayload) =>
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      } as never as Response) as never as typeof fetch;

    it('in-memory overlay overrides a base model field', async () => {
      const fetchImpl = okFetch(SAMPLE);
      const overlay: ModelsDevPayload = {
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'anthropic-test-model': {
              id: 'anthropic-test-model',
              name: 'Anthropic Test Model',
              limit: { context: 1_000_000 },
            },
          },
        },
      };
      const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, overlay });
      const m = await reg.getModel('anthropic', 'anthropic-test-model');
      expect(m?.capabilities.maxContext).toBe(1_000_000); // overridden
    });

    it('overlay adds a provider absent from the base', async () => {
      const fetchImpl = okFetch(SAMPLE);
      const overlay: ModelsDevPayload = {
        myco: {
          id: 'myco',
          name: 'My Co',
          npm: '@ai-sdk/openai-compatible',
          api: 'https://api.myco.example',
          env: ['MYCO_API_KEY'],
          models: { 'myco-1': { id: 'myco-1', name: 'MyCo One', limit: { context: 64_000 } } },
        },
      };
      const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, overlay });
      const ids = (await reg.listProviders()).map((p) => p.id);
      expect(ids).toContain('myco');
      const m = await reg.getModel('myco', 'myco-1');
      expect(m?.capabilities.maxContext).toBe(64_000);
    });

    it('reads the overlay from overlayFile when overlayUrl fetch fails', async () => {
      const overlayFile = path.join(cacheDir, 'providers.json');
      await fs.writeFile(
        overlayFile,
        JSON.stringify({
          anthropic: {
            id: 'anthropic',
            name: 'Anthropic',
            models: {
              'anthropic-test-model': {
                id: 'anthropic-test-model',
                name: 'Anthropic Test Model',
                limit: { context: 500_000 },
              },
            },
          },
        }),
      );
      // base fetch ok, overlay URL fetch fails → falls back to the file.
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).includes('providers.json')) throw new Error('overlay offline');
        return { ok: true, status: 200, json: async () => SAMPLE } as never as Response;
      }) as never as typeof fetch;
      const reg = new DefaultModelsRegistry({
        cacheFile,
        fetchImpl,
        overlayUrl: 'https://example.test/providers.json',
        overlayFile,
        overlayCacheFile: path.join(cacheDir, 'overlay-cache.json'),
      });
      const m = await reg.getModel('anthropic', 'anthropic-test-model');
      expect(m?.capabilities.maxContext).toBe(500_000);
    });

    it('uses bundled overlay-only model limits when the base catalog lacks a model', async () => {
      const overlayFile = path.join(cacheDir, 'providers.json');
      await fs.writeFile(
        overlayFile,
        JSON.stringify({
          openai: {
            id: 'openai',
            name: 'OpenAI',
            npm: '@ai-sdk/openai',
            models: {
              'gpt-5.5': {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                tool_call: true,
                limit: { context: 1_050_000 },
              },
            },
          },
        }),
      );
      const fetchImpl = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => SAMPLE,
          }) as never as Response,
      ) as never as typeof fetch;
      const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, overlayFile });
      const model = await reg.getModel('openai', 'gpt-5.5');
      expect(model?.capabilities.maxContext).toBe(1_050_000);
    });

    it('falls back to bundled overlay when the fetched overlay cache is empty', async () => {
      const overlayFile = path.join(cacheDir, 'providers.json');
      const overlayCacheFile = path.join(cacheDir, 'overlay-cache.json');
      await fs.writeFile(
        overlayFile,
        JSON.stringify({
          openai: {
            id: 'openai',
            name: 'OpenAI',
            npm: '@ai-sdk/openai',
            models: {
              'gpt-5.5': {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                limit: { context: 1_050_000 },
              },
            },
          },
        }),
      );
      await fs.writeFile(
        overlayCacheFile,
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          url: 'https://example.test/providers.json',
          payload: {},
        }),
      );
      const fetchImpl = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => SAMPLE,
          }) as never as Response,
      ) as never as typeof fetch;
      const reg = new DefaultModelsRegistry({
        cacheFile,
        fetchImpl,
        overlayUrl: 'https://example.test/providers.json',
        overlayFile,
        overlayCacheFile,
      });
      const model = await reg.getModel('openai', 'gpt-5.5');
      expect(model?.capabilities.maxContext).toBe(1_050_000);
    });

    it('degrades to overlay-only when models.dev fails and no cache exists', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as never as typeof fetch;
      const overlay: ModelsDevPayload = {
        myco: {
          id: 'myco',
          name: 'My Co',
          npm: '@ai-sdk/openai-compatible',
          models: { 'myco-1': { id: 'myco-1', name: 'MyCo One' } },
        },
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, overlay });
      const providers = await reg.listProviders();
      expect(providers.map((p) => p.id)).toEqual(['myco']); // base empty, overlay served
      warn.mockRestore();
    });

    it('still throws offline when there is no overlay source and no cache', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as never as typeof fetch;
      const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl });
      await expect(reg.load()).rejects.toThrow(/offline/);
    });
  });
});
