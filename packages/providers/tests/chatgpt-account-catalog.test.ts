/**
 * The ChatGPT account catalogs (`openai-codex` via chatgpt.com, `openai-chatgpt`
 * via the plan API) end to end: account snapshot → registry → capabilities,
 * output ceiling and picker descriptor.
 *
 * Fixture entries are trimmed copies of the live `/codex/models` payload
 * (2026-10-05). Before these fixes every surface disagreed: the CLI listing
 * showed `?` for every model, Codex models resolved as non-reasoning with no
 * output ceiling, and the plan provider reported the public API's 1.05M window
 * while its account serves 872K.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultModelsRegistry, resolveProviderModelList } from '@wrongstack/core/models';
import type { Config, ModelsDevPayload } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  CHATGPT_ACCOUNT_METADATA_CATALOG,
  discoverOpenAICompatibleModels,
  discoveryOverlay,
  mapCompatibleModel,
  pruneDiscoveryCache,
  resolveDiscoveryTargets,
} from '../src/auto-discover.js';
import { capabilitiesFor, catalogProviderIdFor } from '../src/capabilities.js';
import {
  clearModelOutputLimitResolver,
  installCatalogModelOutputLimits,
  resolveMaxOutputTokens,
} from '../src/model-output-limits.js';
import { CODEX_CLIENT_VERSION } from '../src/oauth/codex-protocol.js';
import { fetchSubscriptionModels } from '../src/oauth/subscription-models.js';

const LIVE_ASTRA = {
  slug: 'gpt-6-astra',
  display_name: 'GPT-6-Astra',
  description: 'Frontier intelligence for the most demanding work.',
  context_window: 272000,
  max_context_window: 872000,
  input_modalities: ['text', 'image'],
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: '' },
    { effort: 'medium', description: '' },
    { effort: 'high', description: '' },
    { effort: 'xhigh', description: '' },
    { effort: 'max', description: '' },
    { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
  ],
  visibility: 'list',
  minimal_client_version: '0.153.0',
  upgrade: null,
};
const LIVE_GPT55 = {
  slug: 'gpt-5.5',
  display_name: 'GPT-5.5',
  context_window: 272000,
  max_context_window: 272000,
  input_modalities: ['text', 'image'],
  supported_reasoning_levels: [
    { effort: 'low' },
    { effort: 'medium' },
    { effort: 'high' },
    { effort: 'xhigh' },
  ],
  visibility: 'list',
  upgrade: {
    model: 'gpt-6.1-sol',
    migration_markdown: 'GPT-5.5 retires on October 14, 2026.',
    retirement_at: '2026-10-14T19:00:00Z',
  },
};
const LIVE_HIDDEN = { ...LIVE_ASTRA, slug: 'codex-auto-review', visibility: 'hide' };

/** The public API catalog: same ids, a different (API-key) window, plus API-only models. */
const CATALOG: ModelsDevPayload = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-6-astra': {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        family: 'gpt',
        reasoning: true,
        tool_call: true,
        knowledge: '2026-04-30',
        cost: { input: 5, output: 30 },
        limit: { context: 1_050_000, output: 128_000 },
      },
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        reasoning: true,
        tool_call: true,
        knowledge: '2025-12-01',
        limit: { context: 1_050_000, output: 128_000 },
      },
      'text-embedding-3-small': {
        id: 'text-embedding-3-small',
        name: 'Embedding',
        limit: { context: 8191, output: 1536 },
      },
    },
  },
  // What the curated overlay ships for the two account providers.
  'openai-codex': { id: 'openai-codex', name: 'OpenAI Codex (ChatGPT sign-in)', models: {} },
  'openai-chatgpt': { id: 'openai-chatgpt', name: 'OpenAI (ChatGPT plan)', models: {} },
};

const ACCOUNT_KEY = (strategy?: string) => ({
  label: 'oauth-default',
  apiKey: 'access-token',
  refreshToken: 'refresh-token',
  authMethod: 'oauth' as const,
  ...(strategy ? { oauthStrategyId: strategy, scope: 'chatgpt.tokens.use.direct' } : {}),
  createdAt: '2026-10-05T00:00:00.000Z',
});

const CONFIG = {
  providers: {
    'openai-codex': {
      type: 'openai-codex',
      family: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      activeKey: 'oauth-default',
      apiKeys: [ACCOUNT_KEY()],
    },
    'openai-chatgpt': {
      type: 'openai-chatgpt',
      family: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      activeKey: 'oauth-default',
      apiKeys: [ACCOUNT_KEY('chatgpt-api')],
    },
  },
} as unknown as Config;

function liveFetch(seen: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input));
    return Response.json({ models: [LIVE_ASTRA, LIVE_HIDDEN, LIVE_GPT55] });
  }) as typeof fetch;
}

async function registryWithAccounts(): Promise<{
  registry: DefaultModelsRegistry;
  seen: string[];
}> {
  const registry = new DefaultModelsRegistry({
    cacheFile: path.join(os.tmpdir(), `ws-chatgpt-account-${process.pid}.json`),
    seed: CATALOG,
  });
  await registry.load();
  const seen: string[] = [];
  for (const target of resolveDiscoveryTargets(CONFIG)) {
    const provider = await discoverOpenAICompatibleModels(target.id, {
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      accountCatalog: target.accountCatalog,
      modelsUrl: target.modelsUrl,
      modelDiscoveryPath: target.modelDiscoveryPath,
      inheritWireFamily: target.inheritWireFamily,
      fetchImpl: liveFetch(seen),
    });
    expect(provider).toBeDefined();
    const merge = discoveryOverlay(target, provider!, '2026-10-05T07:00:00.000Z');
    registry.mergeOverlay(merge.payload, merge.options);
  }
  return { registry, seen };
}

describe('ChatGPT account catalogs', () => {
  it('advertise the pinned Codex client version on BOTH catalog requests', async () => {
    const { seen } = await registryWithAccounts();
    const version = `client_version=${CODEX_CLIENT_VERSION}`;
    expect(seen).toHaveLength(2);
    // The plan API gates its catalog exactly like the Codex backend; without
    // the parameter it served 5 of the account's 8 models.
    expect(seen.find((url) => url.startsWith('https://api.openai.com/v1/models'))).toContain(
      version,
    );
    expect(seen.find((url) => url.startsWith('https://chatgpt.com/'))).toContain(version);
  });

  it('map the account entry: max window, reasoning levels, retirement', () => {
    const astra = mapCompatibleModel(LIVE_ASTRA);
    expect(astra?.limit).toEqual({ context: 872000 });
    expect(astra?.reasoning).toBe(true);
    expect(astra?.reasoning_options).toEqual([
      { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    ]);
    expect(astra?.status).toBeUndefined();
    expect(mapCompatibleModel(LIVE_GPT55)?.status).toBe('deprecated');
  });

  it('keep their own wire family instead of the openai-compatible stamp', async () => {
    const { registry } = await registryWithAccounts();
    expect((await registry.getProvider('openai-codex'))?.family).toBe('openai-codex');
    expect((await registry.getProvider('openai-chatgpt'))?.family).toBe('openai');
    // The curated display name survives the snapshot, which is named after the config id.
    expect((await registry.getProvider('openai-codex'))?.name).toBe(
      'OpenAI Codex (ChatGPT sign-in)',
    );
    // A snapshot cached by an older build still carries the stamp; the merge strips it.
    const [codex] = resolveDiscoveryTargets(CONFIG);
    const merge = discoveryOverlay(codex!, {
      id: 'openai-codex',
      name: 'openai-codex',
      npm: '@ai-sdk/openai-compatible',
      models: {},
    });
    expect(merge.payload['openai-codex']?.npm).toBeUndefined();
    expect(merge.options.metadataFallbackProviderId).toBe(CHATGPT_ACCOUNT_METADATA_CATALOG);
  });

  it.each(['openai-codex', 'openai-chatgpt'])(
    '%s: account window wins, catalog fills only the gaps',
    async (providerId) => {
      const { registry } = await registryWithAccounts();
      const cfg = CONFIG.providers![providerId]!;
      const caps = await capabilitiesFor(registry, providerId, 'gpt-6-astra', undefined, {
        catalogProviderId: catalogProviderIdFor(providerId, cfg.type),
      });
      expect(caps.maxContext).toBe(872000); // account, not the API's 1_050_000
      expect(caps.maxOutput).toBe(128000); // the account never states one
      expect(caps.reasoning).toBe(true);
      expect(caps.tools).toBe(true);

      const astra = (await registry.getProvider(providerId))?.models.find(
        (m) => m.id === 'gpt-6-astra',
      );
      expect(astra?.knowledge).toBe('2026-04-30');
      expect(astra?.cost).toBeUndefined(); // API prices never land on a subscription
      expect(astra?.reasoningConfig?.effortLevels).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      expect(astra?.provenance?.primary).toBe('provider-discovery');
      expect(astra?.provenance?.sources).toContain('models-dev');

      const gpt55 = (await registry.getProvider(providerId))?.models.find(
        (m) => m.id === 'gpt-5.5',
      );
      // Retirement comes from the account, and the catalog's status is not copied.
      expect(gpt55?.status).toBe('deprecated');
      expect(gpt55?.reasoningConfig?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
    },
  );

  it('offer exactly the account models, with limits, in the picker', async () => {
    const { registry } = await registryWithAccounts();
    for (const providerId of ['openai-codex', 'openai-chatgpt']) {
      const list = resolveProviderModelList(
        CONFIG.providers![providerId]!.models,
        await registry.getProvider(catalogProviderIdFor(providerId, providerId)),
        providerId,
        await registry.getProvider('openai'),
        true,
      );
      expect(list.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5']);
      expect(list[0]).toMatchObject({ contextWindow: 872000, maxOutput: 128000 });
      expect(list[0]?.capabilities).toEqual(['tools', 'reasoning', 'vision']);
    }
  });

  it('resolve the same output ceiling at request time', async () => {
    const { registry } = await registryWithAccounts();
    await installCatalogModelOutputLimits({ registry, getConfig: () => CONFIG });
    try {
      for (const providerId of ['openai-codex', 'openai-chatgpt']) {
        const capabilities = await capabilitiesFor(registry, providerId, 'gpt-6-astra');
        expect(resolveMaxOutputTokens({ model: 'gpt-6-astra' }, { providerId, capabilities })).toBe(
          128000,
        );
      }
    } finally {
      clearModelOutputLimitResolver();
    }
  });

  it('fall back to the API catalog only for a model the snapshot lacks', async () => {
    const { registry } = await registryWithAccounts();
    const caps = await capabilitiesFor(registry, 'openai-chatgpt', 'text-embedding-3-small');
    expect(caps.maxContext).toBe(8191);
  });

  it('read the larger window in the runtime plan probe', async () => {
    const models = await fetchSubscriptionModels('https://api.openai.com/v1', 'token', (async () =>
      Response.json({ models: [LIVE_ASTRA, LIVE_GPT55] })) as typeof fetch);
    expect(models?.map((m) => [m.id, m.maxContext])).toEqual([
      ['gpt-6-astra', 872000],
      ['gpt-5.5', 272000],
    ]);
  });

  it('prune snapshots cached under rotated refresh tokens', () => {
    const target = {
      id: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api',
      accountCatalog: true,
      cacheKey: 'openai-codex\u0000https://chatgpt.com/backend-api\u0000new',
    };
    const cache: Record<string, unknown> = {
      [target.cacheKey]: 1,
      'openai-codex\u0000https://chatgpt.com/backend-api\u0000old-1': 1,
      'openai-codex\u0000https://chatgpt.com/backend-api\u0000old-2': 1,
      'openai-codex-work\u0000https://chatgpt.com/backend-api\u0000other': 1,
      'omniroute\u0000http://localhost:20128/v1': 1,
    };
    expect(pruneDiscoveryCache(cache, target)).toBe(true);
    expect(Object.keys(cache).sort()).toEqual(
      [
        target.cacheKey,
        'omniroute\u0000http://localhost:20128/v1',
        'openai-codex-work\u0000https://chatgpt.com/backend-api\u0000other',
      ].sort(),
    );
    expect(pruneDiscoveryCache(cache, { ...target, accountCatalog: false })).toBe(false);
  });
});
