import type { ProviderConfig } from '@wrongstack/contracts/types';
import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAccountQuotaReporting } from '../src/account-quota.js';
import { parseChatGPTAppQuota } from '../src/chatgpt-account-quota.js';
import {
  readConfiguredProviderAccountQuota,
  setChatGPTQuotaProviders,
} from '../src/configured-account-quota.js';
import { OpenAIResponsesProvider } from '../src/openai-responses.js';
import { makeProviderFromConfig } from '../src/provider-factory.js';

afterEach(() => {
  resetProviderQuota();
  vi.unstubAllGlobals();
  setAccountQuotaReporting(false);
  setChatGPTQuotaProviders(undefined);
});

const directConfig: ProviderConfig = {
  type: 'openai-chatgpt',
  family: 'openai',
  apiKeys: [
    {
      label: 'selected',
      apiKey: 'direct-token',
      createdAt: '',
      authMethod: 'oauth',
      oauthStrategyId: 'chatgpt-api',
      oauthClientId: 'oaiapp_wrongstack',
      scope: 'chatgpt.tokens.use.direct',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ],
};
const companion: ProviderConfig = {
  type: 'openai-codex',
  family: 'openai-codex',
  apiKey: 'backend-token',
};
const appPayload = {
  items: [
    { id: 'other-app', windows: [{ used_percent: 99, limit_window_seconds: 604800 }] },
    {
      id: 'oaiapp_wrongstack',
      allowed_usage_percent: 100,
      windows: [
        {
          used_percent: 14,
          remaining_percent: 86,
          limit_window_seconds: 604800,
          reset_at: 1800000000,
        },
      ],
    },
  ],
};

describe('ChatGPT OAuth account quota', () => {
  it('refreshes the runtime account after turns without changing its inference transport', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        if (url.endsWith('/responses')) {
          expect(new Headers(init.headers).get('authorization')).toBe('Bearer direct-token');
          return new Response(
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          );
        }
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer backend-token');
        return new Response(JSON.stringify(url.endsWith('/chatpass/apps') ? appPayload : {}));
      }),
    );
    setAccountQuotaReporting(true);
    setChatGPTQuotaProviders(async () => ({ work: directConfig, backend: companion }));
    const provider = makeProviderFromConfig('work', directConfig);
    await provider.complete(
      { model: 'gpt-6.1-sol', messages: [] },
      { signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(getProviderQuota('work')[0]?.windows[0]?.usedPercent).toBe(14));
    await provider.complete(
      { model: 'gpt-6.1-sol', messages: [] },
      { signal: new AbortController().signal },
    );
    expect(urls.filter((url) => url.endsWith('/chatpass/apps'))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith('/responses'))).toEqual([
      'https://api.openai.com/v1/responses',
      'https://api.openai.com/v1/responses',
    ]);
  });
  it('reads exact app windows and separate plan limits through the saved Codex transport', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer backend-token');
        return new Response(
          JSON.stringify(
            url.endsWith('/chatpass/apps')
              ? appPayload
              : {
                  plan_type: 'pro',
                  rate_limit: { primary_window: { used_percent: 33, limit_window_seconds: 18000 } },
                  additional_rate_limits: [
                    {
                      metered_feature: 'codex_other',
                      rate_limit: {
                        primary_window: { used_percent: 99, limit_window_seconds: 18000 },
                      },
                    },
                  ],
                },
          ),
        );
      }),
    );
    expect(
      await readConfiguredProviderAccountQuota('work', directConfig, {
        work: directConfig,
        backend: companion,
      }),
    ).toEqual({ vendor: 'chatgpt', ok: true });
    const snapshots = getProviderQuota('work');
    expect(snapshots.map((s) => [s.meterId, s.windows[0]?.usedPercent])).toEqual([
      ['chatgpt-plan', 33],
      ['chatgpt-app', 14],
    ]);
    expect(getProviderQuota('backend')).toEqual([]);
    expect(urls).toEqual([
      'https://chatgpt.com/backend-api/wham/usage/chatpass/apps',
      'https://chatgpt.com/backend-api/wham/usage',
    ]);
  });

  it('does not read another account or copy its plan when registration is absent', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ items: [appPayload.items[0]] })),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await readConfiguredProviderAccountQuota('work', directConfig, { backend: companion }),
    ).toEqual({ vendor: 'chatgpt', ok: false });
    expect(getProviderQuota('work')).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('makes no quota request without a companion OAuth account', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await readConfiguredProviderAccountQuota('work', directConfig, {})).toEqual({
      vendor: 'chatgpt',
      ok: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not confuse the configured app allowance with remaining usage', () => {
    expect(
      parseChatGPTAppQuota('work', 'oaiapp_wrongstack', appPayload)[0]?.windows[0]?.usedPercent,
    ).toBe(14);
    expect(
      parseChatGPTAppQuota('work', 'oaiapp_wrongstack', {
        items: [appPayload.items[1], appPayload.items[1]],
      }),
    ).toEqual([]);
    expect(
      parseChatGPTAppQuota('work', 'oaiapp_wrongstack', {
        items: [{ id: 'oaiapp_wrongstack', allowed_usage_percent: 100 }],
      }),
    ).toEqual([]);
  });
});

describe('ChatGPT plan response quota', () => {
  it.each([200, 429])(
    'records reported windows under the configured account on HTTP %s',
    async (status) => {
      const provider = new OpenAIResponsesProvider({
        id: 'chatgpt-work',
        apiKey: 'token',
        baseUrl: 'https://api.openai.com/v1',
        chatGPTPlan: true,
        fetchImpl: async () =>
          new Response(
            status === 200
              ? 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
              : '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}',
            {
              status,
              headers: {
                'content-type': 'text/event-stream',
                'x-codex-primary-used-percent': '72',
                'x-codex-primary-window-minutes': '300',
              },
            },
          ),
      });
      try {
        await provider.complete(
          { model: 'gpt-6.1-sol', messages: [] },
          { signal: new AbortController().signal },
        );
      } catch {
        if (status === 200) throw new Error('successful response failed');
      }
      expect(getProviderQuota('chatgpt-work')[0]?.windows[0]?.usedPercent).toBe(72);
      expect(getProviderQuota('openai-codex')).toEqual([]);
    },
  );

  it('does not invent a percentage when the public route omits quota headers', async () => {
    const provider = new OpenAIResponsesProvider({
      id: 'openai-chatgpt',
      apiKey: 'token',
      baseUrl: 'https://api.openai.com/v1',
      chatGPTPlan: true,
      fetchImpl: async () =>
        new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'),
    });
    await provider.complete(
      { model: 'gpt-6.1-sol', messages: [] },
      { signal: new AbortController().signal },
    );
    expect(getProviderQuota('openai-chatgpt')).toEqual([]);
  });
});
