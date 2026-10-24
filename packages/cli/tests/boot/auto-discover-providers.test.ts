import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, ModelsDevPayload } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAndMergeProviders } from '../../src/boot/auto-discover-providers.js';

/** Minimal registry double capturing mergeOverlay calls. */
function fakeRegistry(): {
  merged: ModelsDevPayload[];
  mergeOptions: unknown[];
  mergeOverlay: (p: ModelsDevPayload, opts?: unknown) => void;
} {
  const merged: ModelsDevPayload[] = [];
  const mergeOptions: unknown[] = [];
  return {
    merged,
    mergeOptions,
    mergeOverlay: (p, opts) => {
      merged.push(p);
      mergeOptions.push(opts);
    },
  };
}

function modelsResponse(ids: string[]): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        object: 'list',
        data: ids.map((id) => ({ id, capabilities: { tool_calling: true } })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never as typeof fetch;
}

function xaiModelsResponse(ids: string[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ models: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as never as typeof fetch;
}

function cfgWith(providers: Config['providers']): Config {
  return { providers } as unknown as Config;
}

describe('discoverAndMergeProviders', () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-discover-'));
  });
  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it.each(['kimi', 'chatgpt-api'])(
    'renews expired %s OAuth before discovery and caches the rotated account',
    async (strategy) => {
      const id = strategy === 'kimi' ? 'kimi-for-coding' : 'openai-chatgpt';
      const credential = {
        label: 'personal',
        createdAt: '',
        authMethod: 'oauth' as const,
        oauthStrategyId: strategy,
        apiKey: 'expired-access',
        refreshToken: `old-refresh-${strategy}`,
        expiresAt: new Date(0).toISOString(),
        oauthClientId: 'test-client',
        scope: 'chatgpt.tokens.use.direct',
      };
      const saved = {
        type: id,
        baseUrl:
          strategy === 'kimi' ? 'https://api.kimi.ai/coding/v1' : 'https://api.openai.com/v1',
        apiKeys: [credential],
      };
      const config = cfgWith({ [id]: saved });
      const reg = fakeRegistry();
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/token'))
          return Response.json({
            access_token: 'fresh-access',
            refresh_token: `new-refresh-${strategy}`,
            expires_in: 3600,
            scope: 'chatgpt.tokens.use.direct',
          });
        if (new Headers(init?.headers).get('authorization') !== 'Bearer fresh-access') {
          return new Response('', { status: 401 });
        }
        return Response.json({ data: [{ id: 'live-model' }] });
      };
      await discoverAndMergeProviders({ config, registry: reg as never, cacheDir, fetchImpl });
      expect(Object.keys(reg.merged[0]?.[id]?.models ?? {})).toEqual(['live-model']);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('/token');
      expect(saved.apiKeys[0]?.apiKey).toBe('fresh-access');
      // The next launch uses the new refresh identity, so its offline fallback must find this cache.
      const offline = fakeRegistry();
      await discoverAndMergeProviders({
        config,
        registry: offline as never,
        cacheDir,
        fetchImpl: async () => {
          throw new Error('offline');
        },
      });
      expect(Object.keys(offline.merged[0]?.[id]?.models ?? {})).toEqual(['live-model']);
      // A successful renewal followed by a catalog outage still belongs to this account.
      saved.apiKeys[0]!.expiresAt = new Date(0).toISOString();
      const rotating = fakeRegistry();
      await discoverAndMergeProviders({
        config,
        registry: rotating as never,
        cacheDir,
        fetchImpl: async (input) =>
          String(input).endsWith('/token')
            ? Response.json({
                access_token: 'latest-access',
                refresh_token: `latest-refresh-${strategy}`,
                expires_in: 3600,
                scope: 'chatgpt.tokens.use.direct',
              })
            : new Response('', { status: 503 }),
      });
      expect(Object.keys(rotating.merged[0]?.[id]?.models ?? {})).toEqual(['live-model']);
      const nextLaunch = fakeRegistry();
      await discoverAndMergeProviders({
        config,
        registry: nextLaunch as never,
        cacheDir,
        fetchImpl: async () => new Response('', { status: 503 }),
      });
      expect(Object.keys(nextLaunch.merged[0]?.[id]?.models ?? {})).toEqual(['live-model']);
    },
  );

  it('reports HTTP auth errors without claiming the server is unreachable', async () => {
    const warn = vi.fn();
    await discoverAndMergeProviders({
      config: cfgWith({ omniroute: { type: 'omniroute' } }),
      registry: fakeRegistry() as never,
      cacheDir,
      logger: { warn } as never,
      fetchImpl: async () => new Response('secret-response-body', { status: 401 }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/unreachable|secret-response-body/);
  });

  it('discards catalog results if the account changes while the request is pending', async () => {
    const saved = {
      type: 'kimi-for-coding',
      activeKey: 'first',
      models: ['existing'],
      apiKeys: [
        {
          label: 'first',
          createdAt: '',
          authMethod: 'oauth' as const,
          oauthStrategyId: 'kimi',
          apiKey: 'first-access',
          refreshToken: 'first-refresh',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
        { label: 'second', createdAt: '', apiKey: 'second-access' },
      ],
    };
    const reg = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ 'kimi-for-coding': saved }),
      registry: reg as never,
      cacheDir,
      fetchImpl: async () => {
        saved.activeKey = 'second';
        return Response.json({ data: [{ id: 'foreign' }] });
      },
    });
    expect(reg.merged).toEqual([]);
    expect(saved.models).toEqual(['existing']);
  });

  it('replaces OAuth account lists with live IDs, clears authoritative empty catalogs and never reuses another account cache', async () => {
    const saved = {
      type: 'github-copilot',
      family: 'github-copilot' as const,
      models: ['stale'],
      apiKeys: [
        {
          label: 'personal',
          apiKey: 'token',
          refreshToken: 'account-a',
          authMethod: 'oauth' as const,
          createdAt: '',
        },
      ],
    };
    const config = cfgWith({ account: saved });
    const reg = fakeRegistry();
    const live = async () =>
      Response.json({
        data: [
          {
            id: 'account-new',
            model_picker_enabled: true,
            capabilities: { type: 'chat', supports: { tool_calls: true } },
          },
        ],
      });
    await discoverAndMergeProviders({ config, registry: reg as never, cacheDir, fetchImpl: live });
    expect(saved.models).toEqual(['account-new']);
    expect(reg.mergeOptions[0]).toMatchObject({ authoritativeProviderIds: ['account'] });
    await discoverAndMergeProviders({
      config,
      registry: reg as never,
      cacheDir,
      fetchImpl: async () => Response.json({ data: [] }),
    });
    expect(saved.models).toEqual([]);
    expect(reg.merged.at(-1)?.account?.models).toEqual({});
    saved.apiKeys[0]!.refreshToken = 'account-b';
    saved.models = ['foreign'];
    await discoverAndMergeProviders({
      config,
      registry: reg as never,
      cacheDir,
      fetchImpl: async () => new Response('', { status: 503 }),
    });
    expect(saved.models).toEqual([]);
    expect(reg.merged.at(-1)?.account?.models).toEqual({});
  });

  it('discovers + merges the omniroute preset provider (baseUrl from preset)', async () => {
    const reg = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ omniroute: { type: 'omniroute', apiKey: 'sk-x' } }),
      registry: reg as never,
      cacheDir,
      fetchImpl: modelsResponse(['cc/claude-opus-4-8', 'openai/gpt-5-codex']),
    });
    expect(reg.merged).toHaveLength(1);
    const omni = reg.merged[0]?.omniroute;
    expect(omni?.npm).toBe('@ai-sdk/openai-compatible');
    expect(Object.keys(omni?.models ?? {})).toHaveLength(2);
  });

  it('is a no-op when no provider opts in', async () => {
    const reg = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ openai: { type: 'openai', apiKey: 'sk-x' } }),
      registry: reg as never,
      cacheDir,
      fetchImpl: modelsResponse(['x']),
    });
    expect(reg.merged).toHaveLength(0);
  });

  it('falls back to the cached list when the server is unreachable', async () => {
    // Seed the cache with a prior successful fetch.
    const reg1 = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ omniroute: { type: 'omniroute', apiKey: 'sk-x' } }),
      registry: reg1 as never,
      cacheDir,
      fetchImpl: modelsResponse(['cached/model']),
    });
    expect(reg1.merged).toHaveLength(1);

    // Now the server is down — discovery returns undefined, cache kicks in.
    const reg2 = fakeRegistry();
    await discoverAndMergeProviders({
      config: cfgWith({ omniroute: { type: 'omniroute', apiKey: 'sk-x' } }),
      registry: reg2 as never,
      cacheDir,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as never as typeof fetch,
    });
    expect(reg2.merged).toHaveLength(1);
    expect(Object.keys(reg2.merged[0]?.omniroute?.models ?? {})).toEqual(['cached/model']);
  });

  it('honors the explicit autoDiscoverModels flag with a custom baseUrl', async () => {
    const reg = fakeRegistry();
    const fetchSpy = vi.fn(modelsResponse(['litellm/gpt-4o'])) as never as typeof fetch;
    await discoverAndMergeProviders({
      config: cfgWith({
        mygw: {
          type: 'mygw',
          baseUrl: 'http://localhost:4000/v1',
          apiKey: 'k',
          autoDiscoverModels: true,
        },
      }),
      registry: reg as never,
      cacheDir,
      fetchImpl: fetchSpy,
    });
    expect(reg.merged).toHaveLength(1);
    expect(reg.merged[0]?.mygw).toBeDefined();
  });

  it('marks xAI account discovery as an authoritative registry snapshot', async () => {
    const reg = fakeRegistry();
    const config = cfgWith({ xai: { type: 'xai', apiKey: 'xai-key' } });
    await discoverAndMergeProviders({
      config,
      registry: reg as never,
      cacheDir,
      fetchImpl: xaiModelsResponse(['grok-4.6', 'grok-4.20']),
    });
    expect(config.providers?.xai?.models).toBeUndefined();
    expect(reg.mergeOptions[0]).toMatchObject({ authoritativeProviderIds: ['xai'] });

    const curated = cfgWith({
      xai: { type: 'xai', apiKey: 'xai-key', models: ['grok-4.6'] },
    });
    await discoverAndMergeProviders({
      config: curated,
      registry: fakeRegistry() as never,
      cacheDir,
      fetchImpl: xaiModelsResponse(['grok-4.6', 'grok-4.20']),
    });
    expect(curated.providers?.xai?.models).toEqual(['grok-4.6']);
  });
});
