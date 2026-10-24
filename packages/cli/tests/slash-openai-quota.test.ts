/**
 * `/openai-quota` renders whatever the Codex transport last observed, and says
 * something useful when it has observed nothing yet. Before rendering it asks
 * the ChatGPT account usage endpoint — through the active transport, or a
 * saved sign-in when the session runs on another provider — so a reading
 * exists before any turn.
 */

import type { Provider, SlashCommand } from '@wrongstack/contracts/types';
import { recordProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportWrongForgeQuota } from '../src/fleet/wrongforge-quota.js';

vi.mock('../src/fleet/wrongforge-quota.js', () => ({
  reportWrongForgeQuota: vi.fn(async () => false),
}));

import {
  buildOpenAIQuotaCommand,
  buildProviderQuotaCommand,
} from '../src/slash-commands/openai-quota.js';

type AgentContext = NonNullable<Parameters<SlashCommand['run']>[1]>;

afterEach(() => {
  resetProviderQuota();
  vi.unstubAllGlobals();
});

async function render(): Promise<string> {
  const result = await buildOpenAIQuotaCommand().run('');
  return (result as { message: string }).message;
}

it('/provider-quota refreshes and renders WrongForge even without a saved provider entry', async () => {
  vi.mocked(reportWrongForgeQuota).mockImplementationOnce(async () => {
    recordProviderQuota('wrongforge', [
      {
        providerId: 'wrongforge',
        meterId: 'default',
        meterLabel: 'WrongForge',
        windows: [{ id: 'primary', usedPercent: 18, windowMinutes: 300 }],
        capturedAt: Date.now(),
      },
    ]);
    return true;
  });
  const result = await buildProviderQuotaCommand().run('');
  expect(result?.message).toContain('wrongforge');
  expect(result?.message).toContain('18%');
  expect(reportWrongForgeQuota).toHaveBeenCalledWith({ force: true });
});

describe('/openai-quota', () => {
  it('reads direct ChatGPT app quota through a saved companion and renders real percentages', async () => {
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
    const cmd = buildOpenAIQuotaCommand({
      providers: () => ({
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
      }),
    });
    const result = await cmd.run('');
    expect(result?.message).toContain('14%');
    expect(result?.message).toContain('86%');
    expect(result?.message).toContain('App limit');
  });
  it('renders direct ChatGPT readings and explains unavailable public-route numbers', async () => {
    recordProviderQuota('openai-chatgpt', [
      {
        providerId: 'openai-chatgpt',
        meterId: 'codex',
        windows: [{ id: 'primary', usedPercent: 72 }],
        capturedAt: Date.now(),
      },
    ]);
    expect(await render()).toContain('72%');
    resetProviderQuota();
    const result = await buildOpenAIQuotaCommand({
      providers: () => ({ 'openai-chatgpt': { type: 'openai-chatgpt', family: 'openai' } }),
    }).run('');
    expect(result?.message).toContain('https://chatgpt.com/settings/usage');
  });
  it('is provider-scoped and claims no generic aliases', () => {
    const cmd = buildOpenAIQuotaCommand();
    expect(cmd.name).toBe('openai-quota');
    expect(cmd.aliases ?? []).toEqual([]);
  });

  it('explains how to get a reading when none has arrived', async () => {
    expect(await render()).toContain('No quota reading yet');
  });

  it('shows each window with its percentage and reset countdown', async () => {
    recordProviderQuota('openai-codex', [
      {
        providerId: 'openai-codex',
        meterId: 'codex',
        planLabel: 'pro',
        windows: [
          {
            id: 'primary',
            usedPercent: 51,
            windowMinutes: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
          },
          { id: 'secondary', usedPercent: 24, windowMinutes: 10080 },
        ],
        capturedAt: Date.now(),
      },
    ]);
    const out = await render();
    expect(out).toContain('5h');
    expect(out).toContain('51%');
    expect(out).toContain('49% left');
    expect(out).toContain('resets in 1h 59m');
    expect(out).toContain('7d');
    expect(out).toContain('plan: pro');
  });

  it('names the limit that was reached', async () => {
    recordProviderQuota('openai-codex', [
      {
        providerId: 'openai-codex',
        meterId: 'codex',
        windows: [{ id: 'primary', usedPercent: 100 }],
        reachedWindowId: 'primary',
        capturedAt: Date.now(),
      },
    ]);
    expect(await render()).toContain('limit reached: primary');
  });
});

function fakeJwt(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

const USAGE = {
  plan_type: 'plus',
  rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 33, limit_window_seconds: 18_000, reset_after_seconds: 600 },
  },
};

/** Stub the network before any provider is built — transports capture fetch. */
function stubUsageEndpoint(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify(USAGE), { status: 200 });
    }),
  );
  return urls;
}

describe('account quota read before rendering', () => {
  it('reads the active ChatGPT transport without a turn', async () => {
    const urls = stubUsageEndpoint();
    const provider = makeProviderFromConfig('openai-codex', {
      type: 'openai-codex',
      family: 'openai-codex',
      apiKey: fakeJwt('acc_1'),
    });
    const result = await buildOpenAIQuotaCommand().run('', { provider } as AgentContext);
    const out = (result as { message: string }).message;

    expect(urls).toEqual(['https://chatgpt.com/backend-api/wham/usage']);
    expect(out).toContain('33%');
    expect(out).toContain('plan: plus');
    expect(out).not.toContain('No quota reading yet');
  });

  it('reads a saved ChatGPT sign-in while the session runs on another provider', async () => {
    const urls = stubUsageEndpoint();
    const other = { id: 'zai-coding-plan', stream: vi.fn() } as never as Provider;
    const cmd = buildProviderQuotaCommand({
      providers: () => ({
        'zai-coding-plan': { type: 'zai-coding-plan', apiKey: 'k' },
        'openai-codex': { type: 'openai-codex', apiKey: fakeJwt('acc_1') },
      }),
    });
    const result = await cmd.run('', { provider: other } as AgentContext);
    const out = (result as { message: string }).message;

    // The saved Z.AI key is asked too (its read fails here: wrong body shape).
    expect(urls).toContain('https://chatgpt.com/backend-api/wham/usage');
    expect(urls.some((u) => u.startsWith('https://api.z.ai/api/monitor/usage/quota/limit'))).toBe(
      true,
    );
    expect(out).toContain('openai-codex');
    expect(out).toContain('33%');
  });

  it('reads a keyless OmniRoute gateway with its management token, and a balance', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
        if (url === 'http://localhost:20128/api/usage/provider-limits') {
          return new Response(
            JSON.stringify({
              caches: {
                c1: {
                  plan: 'max',
                  message: null,
                  fetchedAt: new Date().toISOString(),
                  quotas: { 'weekly (7d)': { used: 60, total: 100, resetAt } },
                },
              },
            }),
          );
        }
        if (url === 'http://localhost:20128/api/providers') {
          return new Response(
            JSON.stringify({ connections: [{ id: 'c1', provider: 'claude', name: 'work' }] }),
          );
        }
        if (url === 'https://api.deepseek.com/user/balance') {
          return new Response(
            JSON.stringify({
              is_available: true,
              balance_infos: [{ currency: 'USD', total_balance: '12.40' }],
            }),
          );
        }
        return new Response('no', { status: 404 });
      }),
    );
    const cmd = buildProviderQuotaCommand({
      providers: () => ({
        omniroute: {
          type: 'omniroute',
          baseUrl: 'http://localhost:20128/v1',
          managementToken: 'oma_test',
        },
        deepseek: { type: 'deepseek', apiKey: 'sk-ds' },
      }),
    });
    const out = ((await cmd.run('')) as { message: string }).message;

    expect(
      calls.filter((c) => c.url.startsWith('http://localhost:20128')).map((c) => c.auth),
    ).toEqual(['Bearer oma_test', 'Bearer oma_test']);
    expect(out).toContain('Claude · work');
    expect(out).toContain('(pool account)');
    expect(out).toContain('60%');
    expect(out).toContain('credits:');
    expect(out).toContain('$12.40');
  });

  it('reads saved key-based accounts and folds one account seen through several keys', async () => {
    const urls: string[] = [];
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        if (url === 'https://opencode.ai/zen/go/v1/usage') {
          return new Response(
            JSON.stringify({ usage: { rolling: { status: 'ok', percent: 42, resetsAt } } }),
          );
        }
        if (url === 'https://api.kimi.com/coding/v1/usages') {
          return new Response(
            JSON.stringify({ usages: { limit_5h: { used_ratio: 0.07, reset_time: resetsAt } } }),
          );
        }
        return new Response('no', { status: 404 });
      }),
    );
    const cmd = buildProviderQuotaCommand({
      providers: () => ({
        opencode: {
          type: 'opencode',
          apiKeys: [{ label: 'a', apiKey: 'zen-key', createdAt: '2026-09-30T00:00:00.000Z' }],
        },
        'opencode-go': { type: 'opencode-go', apiKey: 'go-key' },
        'kimi-for-coding': { type: 'kimi-for-coding', apiKey: 'kimi-key' },
        // Keyless and pay-as-you-go providers are not asked.
        openrouter: { type: 'openrouter', apiKey: '  ' },
        anthropic: { type: 'anthropic', apiKey: 'sk-ant' },
      }),
    });
    const out = ((await cmd.run('')) as { message: string }).message;

    expect(urls.sort()).toEqual([
      'https://api.kimi.com/coding/v1/usages',
      'https://opencode.ai/zen/go/v1/usage',
      'https://opencode.ai/zen/go/v1/usage',
    ]);
    expect(out).toContain('opencode, opencode-go');
    expect(out).toContain('(one account)');
    expect(out.match(/42%/g)).toHaveLength(1);
    expect(out).toContain('kimi-for-coding');
    expect(out).toContain('7.0%');
  });

  it('still renders when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const cmd = buildOpenAIQuotaCommand({
      providers: () => ({ 'openai-codex': { type: 'openai-codex', apiKey: fakeJwt('acc_1') } }),
    });
    const out = ((await cmd.run('')) as { message: string }).message;
    expect(out).toContain('No quota reading yet');
  });
});
