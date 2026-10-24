import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelsDevPayload } from '@wrongstack/contracts/types';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { DefaultModelsRegistry } from '@wrongstack/core/models';
import { providerIdentities } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  buildProviderFactoriesFromRegistry,
  CatalogRoutedProvider,
  MiniMaxProvider,
  makeProviderFromConfig,
  ZaiAccountProvider,
} from '../src/index.js';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    models: {
      'anthropic-test-model': {
        id: 'anthropic-test-model',
        name: 'Anthropic Test Model',
        tool_call: true,
        limit: { context: 200_000 },
      },
    },
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    env: ['GROQ_API_KEY'],
    npm: '@ai-sdk/groq',
    api: 'https://api.groq.com/openai/v1',
    models: { 'llama-3.3-70b': { id: 'llama-3.3-70b', name: 'Llama 3.3' } },
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GEMINI_API_KEY'],
    npm: '@ai-sdk/google',
    models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' } },
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    npm: '@ai-sdk/mistral',
    env: ['MISTRAL_API_KEY'],
    api: 'https://api.mistral.ai/v1',
    models: { 'mistral-large': { id: 'mistral-large', name: 'Mistral Large' } },
  },
  mixed: {
    id: 'mixed',
    name: 'Mixed provider',
    npm: '@ai-sdk/openai-compatible',
    env: ['MIXED_API_KEY'],
    api: 'https://mixed.example/v1',
    models: {
      chat: { id: 'chat', name: 'Chat' },
      claude: {
        id: 'claude',
        name: 'Claude',
        provider: { npm: '@ai-sdk/anthropic', api: 'https://mixed.example/anthropic/v1' },
      },
    },
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere',
    npm: '@ai-sdk/cohere',
    env: ['COHERE_API_KEY'],
    models: { command: { id: 'command', name: 'Command' } },
  },
  azure: {
    id: 'azure',
    name: 'Azure',
    npm: '@ai-sdk/azure',
    env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
    models: { gpt: { id: 'gpt', name: 'GPT' } },
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    npm: '@ai-sdk/amazon-bedrock',
    env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    models: { model: { id: 'model', name: 'Model' } },
  },
  'google-vertex': {
    id: 'google-vertex',
    name: 'Google Vertex',
    npm: '@ai-sdk/google-vertex',
    env: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
    models: { gemini: { id: 'gemini', name: 'Gemini' } },
  },
  'cloudflare-ai-gateway': {
    id: 'cloudflare-ai-gateway',
    name: 'Cloudflare AI Gateway',
    npm: 'ai-gateway-provider',
    env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
    models: { model: { id: 'model', name: 'Model' } },
  },
};

function makeRegistry() {
  return new DefaultModelsRegistry({
    cacheFile: path.join(os.tmpdir(), `wstack-factest-${Date.now()}.json`),
    seed: SAMPLE,
  });
}

describe('buildProviderFactoriesFromRegistry', () => {
  it('produces a factory for each supported provider plus generic openai-compatible', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const types = factories.map((f) => f.type).sort();
    expect(types).toContain('anthropic');
    expect(types).toContain('groq');
    expect(types).toContain('google');
    expect(types).toContain('mistral');
    expect(types).toContain('openai-compatible');
  });

  it('generic openai-compatible factory takes a keyless server on loopback, not a remote one', async () => {
    const factories = await buildProviderFactoriesFromRegistry({ registry: makeRegistry() });
    const f = factories.find((x) => x.type === 'openai-compatible');
    expect(
      f!.create({ type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9915/v1' }),
    ).toBeDefined();
    expect(() =>
      f!.create({ type: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' }),
    ).toThrow(/requires apiKey/);
  });

  it('anthropic factory builds an AnthropicProvider', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'anthropic');
    const provider = f!.create({ type: 'anthropic', apiKey: 'sk-test' });
    expect(provider.id).toBe('anthropic');
  });

  it('groq factory builds an openai-compatible provider with the catalog base URL', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'groq');
    const provider = f!.create({ type: 'groq', apiKey: 'gsk-test' });
    expect(provider.id).toBe('groq');
  });

  it('honors the envVars: [] sentinel — preset env fallback suppressed (VULN-006)', async () => {
    // VULN-006: provider_manage's endpointChanged persists `envVars: []` as a
    // SENTINEL — "endpoint changed; do not silently re-arm the credential from
    // the preset env var". Present-but-empty must NOT fall through to the
    // preset (ANTHROPIC_API_KEY here); only an ABSENT envVars may. The
    // decoupled path cannot pin this (it synthesizes `envVars: cfg.envVars ??
    // []`, erasing the distinction) — the catalog path is where it matters.
    process.env['ANTHROPIC_API_KEY'] = 'sk-from-env';
    try {
      const registry = makeRegistry();
      const factories = await buildProviderFactoriesFromRegistry({ registry });
      const f = factories.find((x) => x.type === 'anthropic')!;
      // Control: absent envVars → the preset's ANTHROPIC_API_KEY is consulted
      // and the provider constructs. If this control cannot pass, the preset
      // env is not wired for this id and the sentinel assertion is vacuous.
      expect(() => f.create({ type: 'anthropic' })).not.toThrow();
      // Sentinel: present-but-empty → preset suppressed → no key → ConfigError.
      expect(() => f.create({ type: 'anthropic', envVars: [] })).toThrow(/requires an API key/);
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('rejects invalid compatibility quirks', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'groq');
    expect(() =>
      f!.create({
        type: 'groq',
        apiKey: 'gsk-test',
        quirks: { unknownField: true },
      }),
    ).toThrow(/Invalid quirks/);
  });

  it('google factory builds a GoogleProvider', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'google');
    const provider = f!.create({ type: 'google', apiKey: 'AIza-test' });
    expect(provider.id).toBe('google');
  });

  it('mistral factory builds an openai-compatible provider from the catalog', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'mistral');
    const provider = f!.create({ type: 'mistral', apiKey: 'msk-test' });
    expect(provider.id).toBe('mistral');
  });

  it('names a provider by the config key the host asks for, not the catalog entry', async () => {
    // Every host builds `{ ...cfg, type: providerId }` with the factory type
    // apart. The factories named the provider by the catalog entry instead, so
    // a second account `work` (type "anthropic") ran as `anthropic` and every
    // lookup of its own config entry read another one.
    const factories = await buildProviderFactoriesFromRegistry({ registry: makeRegistry() });
    const build = (factory: string, cfg: Record<string, unknown>) =>
      factories.find((x) => x.type === factory)!.create(cfg as never);

    const work = build('anthropic', { type: 'work', apiKey: 'sk-work' });
    expect(work.id).toBe('work');
    expect(providerIdentities(work)).toEqual(['work', 'anthropic']);
    expect(build('mistral', { type: 'my-mistral', apiKey: 'msk' }).id).toBe('my-mistral');
    const local = build('openai-compatible', {
      type: 'my-local',
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    expect(local.id).toBe('my-local');
    expect(providerIdentities(local)).toEqual(['my-local', 'openai-compatible']);
    // Asked for by its own name, it is just that.
    const plain = build('anthropic', { type: 'anthropic', apiKey: 'sk' });
    expect(providerIdentities(plain)).toEqual(['anthropic']);
  });

  it('builds a catalog router when one provider mixes supported wire SDKs', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const factory = factories.find((entry) => entry.type === 'mixed');
    const provider = factory!.create({
      type: 'mixed',
      apiKey: 'mixed-key',
      family: 'openai-compatible',
      baseUrl: 'https://mixed.example/v1',
    });
    expect(provider).toBeInstanceOf(CatalogRoutedProvider);
  });

  it('builds a native AI SDK provider for a native catalog family', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const factory = factories.find((entry) => entry.type === 'cohere');
    const provider = factory!.create({ type: 'cohere', apiKey: 'cohere-key' });
    expect(provider.id).toBe('cohere');
    expect(provider.constructor.name).toBe('AiGatewayProvider');
  });

  it.each([
    ['azure', 'native-key'],
    ['amazon-bedrock', undefined],
    ['google-vertex', undefined],
    ['cloudflare-ai-gateway', 'native-key'],
  ] as const)('registers and constructs native provider %s', async (id, apiKey) => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const factory = factories.find((entry) => entry.type === id);
    expect(factory).toBeDefined();
    const provider = factory!.create({ type: id, ...(apiKey ? { apiKey } : {}) });
    expect(provider.id).toBe(id);
  });

  // WS-2026-09-26-01: the native SDKs read their own env vars and credential
  // chains (AWS keys, Google ADC, AZURE_API_KEY) when handed no key, so the
  // sentinel above did nothing for them — a repointed Bedrock/Vertex entry
  // signed or bearer-authed requests to the new base URL with the machine's
  // credentials. With the sentinel and no key of its own, it must not build.
  it.each(['azure', 'cohere', 'amazon-bedrock', 'google-vertex', 'cloudflare-ai-gateway'])(
    'native %s refuses a repointed endpoint with no key of its own',
    async (id) => {
      const factories = await buildProviderFactoriesFromRegistry({ registry: makeRegistry() });
      const factory = factories.find((entry) => entry.type === id)!;
      const repointed = { type: id, baseUrl: 'https://attacker.example/v1', envVars: [] };
      expect(() => factory.create(repointed)).toThrow(/no environment credential/);
      // Its own key is still honoured.
      expect(() => factory.create({ ...repointed, apiKey: 'own-key' })).not.toThrow();
    },
  );

  it('keeps a genuinely different explicit family override authoritative', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const factory = factories.find((entry) => entry.type === 'mixed');
    const provider = factory!.create({
      type: 'mixed',
      apiKey: 'mixed-key',
      family: 'anthropic',
      baseUrl: 'https://override.example/v1',
    });
    expect(provider).not.toBeInstanceOf(CatalogRoutedProvider);
  });

  it('reads apiKey from env vars when not provided in config', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-from-env-' + Math.random();
    try {
      const registry = makeRegistry();
      const factories = await buildProviderFactoriesFromRegistry({ registry });
      const f = factories.find((x) => x.type === 'anthropic');
      const provider = f!.create({ type: 'anthropic' });
      expect(provider.id).toBe('anthropic');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });

  it('throws on missing apiKey + missing env', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'anthropic');
    expect(() => f!.create({ type: 'anthropic' })).toThrow(/API key/);
  });

  it('logs unsupported providers via the logger', async () => {
    const registry = makeRegistry();
    const logger = new DefaultLogger({ level: 'info' });
    const spy = vi.spyOn(logger, 'info');
    await buildProviderFactoriesFromRegistry({ registry, log: logger });
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('mistral'))).toBe(false);
  });

  // ── maxTools quirks acceptance ─────────────────────────────

  it('accepts quirks.maxTools for anthropic family providers', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'anthropic');
    expect(() =>
      f!.create({
        type: 'anthropic',
        apiKey: 'sk-test',
        quirks: { maxTools: 128 },
      }),
    ).not.toThrow();
  });

  it('accepts quirks.maxTools for google family providers', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'google');
    expect(() =>
      f!.create({
        type: 'google',
        apiKey: 'AIza-test',
        quirks: { maxTools: 128 },
      }),
    ).not.toThrow();
  });

  it('accepts quirks.maxTools for openai-compatible family providers', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'groq');
    expect(() =>
      f!.create({
        type: 'groq',
        apiKey: 'gsk-test',
        quirks: { maxTools: 64 },
      }),
    ).not.toThrow();
  });

  it('rejects invalid maxTools (non-integer) for any family', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'groq');
    expect(() =>
      f!.create({
        type: 'groq',
        apiKey: 'gsk-test',
        quirks: { maxTools: 2.5 },
      }),
    ).toThrow(/Invalid quirks/);
  });

  it('rejects invalid maxTools (zero) for any family', async () => {
    const registry = makeRegistry();
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    const f = factories.find((x) => x.type === 'anthropic');
    expect(() =>
      f!.create({
        type: 'anthropic',
        apiKey: 'sk-test',
        quirks: { maxTools: 0 },
      }),
    ).toThrow(/Invalid quirks/);
  });
});

describe('MiniMax routing', () => {
  // models.dev publishes every MiniMax entry under the Anthropic family, so
  // without host-keyed routing they all built a plain AnthropicProvider and
  // missed the MiniMax transport (thinking mapping, quota, region hints).
  const minimaxModels = {
    'MiniMax-M3': { id: 'MiniMax-M3', name: 'MiniMax-M3', tool_call: true },
  };
  const MINIMAX_SAMPLE: ModelsDevPayload = {
    ...SAMPLE,
    minimax: {
      id: 'minimax',
      name: 'MiniMax',
      npm: '@ai-sdk/anthropic',
      env: ['MINIMAX_API_KEY'],
      api: 'https://api.minimax.io/anthropic/v1',
      models: minimaxModels,
    },
    'minimax-coding-plan': {
      id: 'minimax-coding-plan',
      name: 'MiniMax Coding Plan',
      npm: '@ai-sdk/anthropic',
      env: ['MINIMAX_API_KEY'],
      api: 'https://api.minimax.io/anthropic/v1',
      models: minimaxModels,
    },
    'minimax-cn': {
      id: 'minimax-cn',
      name: 'MiniMax (China)',
      npm: '@ai-sdk/anthropic',
      env: ['MINIMAX_API_KEY'],
      api: 'https://api.minimax.cn/anthropic/v1',
      models: minimaxModels,
    },
    'minimax-cn-coding-plan': {
      id: 'minimax-cn-coding-plan',
      name: 'MiniMax Coding Plan (China)',
      npm: '@ai-sdk/anthropic',
      env: ['MINIMAX_API_KEY'],
      api: 'https://api.minimax.cn/anthropic/v1',
      models: minimaxModels,
    },
  };

  it('builds the MiniMax transport for every catalog MiniMax id, both regions', async () => {
    const registry = new DefaultModelsRegistry({
      cacheFile: path.join(os.tmpdir(), `wstack-factest-mm-${Date.now()}.json`),
      seed: MINIMAX_SAMPLE,
    });
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    for (const id of ['minimax', 'minimax-coding-plan', 'minimax-cn', 'minimax-cn-coding-plan']) {
      const factory = factories.find((f) => f.type === id);
      const provider = factory?.create({ type: id, apiKey: 'k' });
      expect(provider, id).toBeInstanceOf(MiniMaxProvider);
      expect(provider?.id).toBe(id);
    }
    const anthropic = factories
      .find((f) => f.type === 'anthropic')
      ?.create({
        type: 'anthropic',
        apiKey: 'k',
      });
    expect(anthropic).toBeInstanceOf(AnthropicProvider);

    // WrongProxy on: the host layer hands the factory a proxy-mounted base
    // URL. The vendor behind `localhost` must still get the MiniMax transport,
    // or turning tracing on silently switches quota and thinking mapping off.
    const proxied = factories
      .find((f) => f.type === 'minimax-coding-plan')
      ?.create({
        type: 'minimax-coding-plan',
        apiKey: 'k',
        baseUrl: 'http://localhost:3444/proxy/api.minimax.io/anthropic/v1',
      });
    expect(proxied).toBeInstanceOf(MiniMaxProvider);
  });

  it('routes a hand-written alias by host, whatever family it declares', () => {
    const viaAnthropic = makeProviderFromConfig('my-minimax', {
      type: 'my-minimax',
      family: 'anthropic',
      apiKey: 'k',
      baseUrl: 'https://api.minimaxi.com/anthropic',
    });
    expect(viaAnthropic).toBeInstanceOf(MiniMaxProvider);
    const viaCompat = makeProviderFromConfig('work', {
      type: 'work',
      family: 'openai-compatible',
      apiKey: 'k',
      baseUrl: 'https://api.minimax.io/v1',
    });
    expect(viaCompat).toBeInstanceOf(MiniMaxProvider);
    const elsewhere = makeProviderFromConfig('proxy', {
      type: 'proxy',
      family: 'anthropic',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.com/anthropic',
    });
    expect(elsewhere).not.toBeInstanceOf(MiniMaxProvider);
  });
});

describe('Z.AI / BigModel routing', () => {
  // models.dev files all four GLM providers under openai-compatible; only the
  // `zai*` presets carried the GLM request policy, so BigModel ids sent the
  // generic effort fill. Every one of them gets the account plane.
  const glmModels = { 'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3', tool_call: true } };
  const entry = (id: string, api: string) => ({
    id,
    name: id,
    npm: '@ai-sdk/openai-compatible',
    env: ['ZHIPU_API_KEY'],
    api,
    models: glmModels,
  });
  const ZAI_SAMPLE: ModelsDevPayload = {
    ...SAMPLE,
    zai: entry('zai', 'https://api.z.ai/api/paas/v4'),
    'zai-coding-plan': entry('zai-coding-plan', 'https://api.z.ai/api/coding/paas/v4'),
    zhipuai: entry('zhipuai', 'https://open.bigmodel.cn/api/paas/v4'),
    'zhipuai-coding-plan': entry(
      'zhipuai-coding-plan',
      'https://open.bigmodel.cn/api/coding/paas/v4',
    ),
  };

  // Stubbed BEFORE any provider is built: transports capture `fetch` at
  // construction, and these tests must never reach the network.
  let bodies: Record<string, unknown>[] = [];
  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response('', { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function wireBody(provider: {
    stream: ZaiAccountProvider['stream'];
  }): Promise<Record<string, unknown>> {
    bodies = [];
    for await (const _ of provider.stream(
      {
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1024,
        reasoning: { effort: 'medium' },
      },
      { signal: new AbortController().signal },
    )) {
      // drained
    }
    return bodies[0] ?? {};
  }

  it('wraps every catalog GLM id and gives BigModel the GLM wire contract', async () => {
    const registry = new DefaultModelsRegistry({
      cacheFile: path.join(os.tmpdir(), `wstack-factest-zai-${Date.now()}.json`),
      seed: ZAI_SAMPLE,
    });
    const factories = await buildProviderFactoriesFromRegistry({ registry });
    for (const id of ['zai', 'zai-coding-plan', 'zhipuai', 'zhipuai-coding-plan']) {
      const provider = factories.find((f) => f.type === id)?.create({ type: id, apiKey: 'k' });
      expect(provider, id).toBeInstanceOf(ZaiAccountProvider);
      expect(provider?.id).toBe(id);
    }
    const bigmodel = factories
      .find((f) => f.type === 'zhipuai-coding-plan')
      ?.create({ type: 'zhipuai-coding-plan', apiKey: 'k' }) as ZaiAccountProvider;
    const body = await wireBody(bigmodel);
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['reasoning_effort']).toBe('high');
  });

  it('routes aliases and hand-rolled providers by host', async () => {
    const viaAnthropic = makeProviderFromConfig('glm-claude', {
      type: 'glm-claude',
      family: 'anthropic',
      apiKey: 'k',
      baseUrl: 'https://api.z.ai/api/anthropic',
    });
    expect(viaAnthropic).toBeInstanceOf(ZaiAccountProvider);
    const custom = makeProviderFromConfig('glm-work', {
      type: 'glm-work',
      family: 'openai-compatible',
      apiKey: 'k',
      baseUrl: 'http://localhost:3444/proxy/open.bigmodel.cn/api/coding/paas/v4',
    });
    expect(custom).toBeInstanceOf(ZaiAccountProvider);
    expect((await wireBody(custom as ZaiAccountProvider))['reasoning_effort']).toBe('high');
    const elsewhere = makeProviderFromConfig('other', {
      type: 'other',
      family: 'openai-compatible',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
    });
    expect(elsewhere).not.toBeInstanceOf(ZaiAccountProvider);
  });
});
