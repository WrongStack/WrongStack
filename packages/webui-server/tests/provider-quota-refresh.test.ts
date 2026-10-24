/**
 * `provider.quota.refresh` — the WebUI quota panel's on-demand read. Only the
 * saved providers whose quota lives on a free account endpoint are read
 * (ChatGPT / Codex `/wham/usage`, MiniMax, Z.AI Coding Plan); the
 * requesting tab gets a full replay plus each read's outcome; repeat requests
 * inside the throttle window do not reach the vendor again.
 */

import type { ProviderConfig } from '@wrongstack/contracts/types';
import { resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ProviderServiceContext } from '../src/server/provider/mutations.js';
import { createQuotaRefreshHandlers } from '../src/server/provider/quota-refresh.js';

const HOUR = 3_600_000;
let urls: string[] = [];

beforeEach(() => {
  urls = [];
  // Stubbed before any read: the vendor calls go through the global fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/api/monitor/usage/quota/limit')) {
        return new Response(
          JSON.stringify({
            code: 200,
            success: true,
            data: {
              level: 'max',
              limits: [
                {
                  type: 'TOKENS_LIMIT',
                  unit: 3,
                  number: 5,
                  percentage: 8,
                  nextResetTime: Date.now() + HOUR,
                },
              ],
            },
          }),
        );
      }
      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        return new Response(
          JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
              limit_reached: false,
              secondary_window: { used_percent: 39, limit_window_seconds: 604_800 },
            },
          }),
        );
      }
      // MiniMax: the key is rejected.
      return new Response(JSON.stringify({ base_resp: { status_code: 1004 } }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderQuota();
});

function context(providers: Record<string, ProviderConfig>) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    loadConfigProviders: vi.fn(async () => providers),
    sendMessage: vi.fn(
      (_ws: WebSocket, msg: { type: string; payload: Record<string, unknown> }) => {
        sent.push(msg);
      },
    ),
  } as never as ProviderServiceContext;
  return { ctx, sent };
}

const ws = {} as WebSocket;

const SAVED: Record<string, ProviderConfig> = {
  'zai-coding-plan': {
    type: 'zai-coding-plan',
    baseUrl: 'http://localhost:5173/proxy/api.z.ai/api/coding/paas/v4',
    apiKeys: [{ label: 'default', apiKey: 'zai-key' }],
    activeKey: 'default',
  } as ProviderConfig,
  'minimax-coding-plan': {
    type: 'minimax-coding-plan',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    apiKeys: [{ label: 'default', apiKey: 'mm-key' }],
  } as ProviderConfig,
  'openai-codex': {
    type: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    apiKeys: [{ label: 'default', apiKey: 'oauth-token' }],
  } as ProviderConfig,
  'no-key': { type: 'zai-coding-plan' } as ProviderConfig,
};

describe('provider.quota.refresh', () => {
  it('reads only the account-endpoint vendors and replies with readings and outcomes', async () => {
    const { ctx, sent } = context(SAVED);
    await createQuotaRefreshHandlers(ctx).handleProviderQuotaRefresh(ws);

    expect(urls.sort()).toEqual([
      'https://api.minimax.io/v1/token_plan/remains',
      'https://api.z.ai/api/monitor/usage/quota/limit',
      'https://chatgpt.com/backend-api/wham/usage',
    ]);
    const reply = sent.at(-1);
    expect(reply?.type).toBe('provider.quota');
    const refreshed = reply?.payload['refreshed'] as Array<Record<string, unknown>>;
    expect(
      refreshed.sort((a, b) => String(a['providerId']).localeCompare(String(b['providerId']))),
    ).toEqual([
      { providerId: 'minimax-coding-plan', vendor: 'minimax', ok: false },
      { providerId: 'openai-codex', vendor: 'codex', ok: true },
      { providerId: 'zai-coding-plan', vendor: 'zai', ok: true },
    ]);
    const snapshots = reply?.payload['snapshots'] as Array<{ providerId: string }>;
    expect(snapshots.map((s) => s.providerId)).toContain('zai-coding-plan');
    expect(snapshots.map((s) => s.providerId)).toContain('openai-codex');
  });

  it('reads direct ChatGPT app windows under an alias using the companion Codex account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith('/chatpass/apps')
                ? {
                    items: [
                      {
                        id: 'oaiapp_work',
                        windows: [{ used_percent: 14, limit_window_seconds: 604800 }],
                      },
                    ],
                  }
                : {},
            ),
          ),
      ),
    );
    const { ctx, sent } = context({
      work: {
        type: 'openai-chatgpt',
        family: 'openai',
        apiKeys: [
          {
            label: 'personal',
            apiKey: 'direct',
            createdAt: '',
            authMethod: 'oauth',
            oauthStrategyId: 'chatgpt-api',
            oauthClientId: 'oaiapp_work',
            scope: 'chatgpt.tokens.use.direct',
          },
        ],
      },
      backend: { type: 'openai-codex', family: 'openai-codex', apiKey: 'backend' },
    });
    await createQuotaRefreshHandlers(ctx).handleProviderQuotaRefresh(ws);
    const refreshed = sent.at(-1)?.payload['refreshed'] as Array<Record<string, unknown>>;
    expect(refreshed).toContainEqual({ providerId: 'work', vendor: 'chatgpt', ok: true });
    const snapshots = sent.at(-1)?.payload['snapshots'] as Array<{
      providerId: string;
      windows: Array<{ usedPercent: number }>;
    }>;
    expect(snapshots.find((s) => s.providerId === 'work')?.windows[0]?.usedPercent).toBe(14);
  });

  it('reads a ChatGPT sign-in saved under any key and reports a failed read', async () => {
    const { ctx, sent } = context({
      'my-chatgpt': {
        type: 'openai-codex',
        apiKeys: [{ label: 'default', apiKey: 'oauth-token' }],
      } as ProviderConfig,
      'broken-chatgpt': {
        family: 'openai-codex',
        type: 'openai-codex',
        baseUrl: 'https://chatgpt.example/backend-api',
        apiKeys: [{ label: 'default', apiKey: 'oauth-token' }],
      } as ProviderConfig,
    });
    await createQuotaRefreshHandlers(ctx).handleProviderQuotaRefresh(ws);
    const refreshed = sent.at(-1)?.payload['refreshed'] as Array<Record<string, unknown>>;
    expect(
      refreshed.sort((a, b) => String(a['providerId']).localeCompare(String(b['providerId']))),
    ).toEqual([
      { providerId: 'broken-chatgpt', vendor: 'codex', ok: false },
      { providerId: 'my-chatgpt', vendor: 'codex', ok: true },
    ]);
  });

  it('does not reach the vendor again inside the throttle window', async () => {
    const { ctx, sent } = context(SAVED);
    const handlers = createQuotaRefreshHandlers(ctx);
    await handlers.handleProviderQuotaRefresh(ws);
    const firstCalls = urls.length;
    await handlers.handleProviderQuotaRefresh(ws);

    expect(urls).toHaveLength(firstCalls);
    const refreshed = sent.at(-1)?.payload['refreshed'] as Array<Record<string, unknown>>;
    expect(refreshed.every((o) => o['throttled'] === true)).toBe(true);
    expect(refreshed.find((o) => o['providerId'] === 'zai-coding-plan')?.['ok']).toBe(true);
  });

  it('still replies when the config cannot be read', async () => {
    const { ctx, sent } = context({});
    (ctx.loadConfigProviders as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('locked'),
    );
    await createQuotaRefreshHandlers(ctx).handleProviderQuotaRefresh(ws);
    expect(sent.at(-1)).toMatchObject({ type: 'provider.quota', payload: { refreshed: [] } });
  });
});
