/**
 * OmniRoute pool limits, prepaid balances (DeepSeek, Moonshot, SiliconFlow)
 * and the config-described `quotaEndpoint`. OmniRoute fixtures are shaped
 * after a live gateway (2026-09-30, names and ids replaced); the balance
 * bodies are the vendors' documented examples.
 */

import type { Provider } from '@wrongstack/contracts/types';
import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachAccountQuotaReporting,
  refreshProviderAccountQuota,
  setAccountQuotaReporting,
} from '../src/account-quota.js';

const NOW = Date.parse('2026-09-30T16:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);
const HOUR = 3_600_000;

afterEach(() => {
  resetProviderQuota();
  setAccountQuotaReporting(false);
  vi.useRealTimers();
});

interface Call {
  url: string;
  headers: Headers;
  redirect: RequestInit['redirect'];
}

function api(routes: Record<string, unknown>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    return url in routes
      ? new Response(JSON.stringify(routes[url]))
      : new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('OmniRoute pool limits', () => {
  const ROOT = 'http://localhost:20128';
  const fetchedAt = iso(NOW - 50 * 60_000);
  const LIMITS = {
    caches: {
      c1: {
        plan: 'default_claude_max_20x',
        message: null,
        fetchedAt,
        quotas: {
          'session (5h)': {
            used: 11,
            total: 100,
            remaining: 89,
            remainingPercentage: 89,
            resetAt: iso(NOW - 20 * 60_000),
            unlimited: false,
          },
          'weekly (7d)': {
            used: 60,
            total: 100,
            remaining: 40,
            remainingPercentage: 40,
            resetAt: iso(NOW + 40 * HOUR),
            unlimited: false,
          },
        },
        modelQuotas: {
          'weekly fable (7d)': {
            used: 0,
            total: 100,
            remainingPercentage: 100,
            resetAt: iso(NOW + 40 * HOUR),
            unlimited: false,
          },
        },
      },
      c2: {
        plan: 'Pro',
        message: null,
        fetchedAt,
        quotas: Object.fromEntries(
          ['gemini-pro', 'gemini-flash', 'claude-sonnet', 'gpt-oss'].map((m, i) => [
            m,
            {
              used: i < 3 ? 570 : 0,
              total: 1000,
              remainingPercentage: i < 3 ? 42.96991 : 100,
              resetAt: iso(NOW + (i < 3 ? 1 : 4) * HOUR),
              unlimited: false,
              fractionReported: true,
            },
          ]),
        ),
      },
      c3: {
        plan: 'Command Code',
        message: null,
        fetchedAt,
        quotas: {
          weekly: {
            used: 1.97,
            total: 6,
            remainingPercentage: 67.1,
            resetAt: iso(NOW + 60 * HOUR),
            currency: 'USD',
            displayName: 'Weekly window',
          },
          credits: {
            used: 0,
            total: 8.03,
            remaining: 8.026,
            remainingPercentage: 100,
            resetAt: null,
            currency: 'USD',
            displayName: 'Credits',
          },
        },
      },
      c4: {
        plan: 'Copilot Free',
        message: null,
        fetchedAt,
        quotas: {
          premium_interactions: {
            used: 100,
            total: 100,
            remaining: 0,
            remainingPercentage: 0,
            resetAt: iso(NOW + 8 * HOUR),
          },
          codex: { used: 39, total: 100, windowSeconds: 604800, resetAt: iso(NOW + 70 * HOUR) },
          unlimited: { unlimited: true, used: 0, total: 0 },
        },
      },
      // A deleted connection's cache entry, and a disabled one's.
      gone: { plan: 'Max', message: null, fetchedAt, quotas: { w: { used: 1, total: 2 } } },
      off: { plan: 'Pro', message: null, fetchedAt, quotas: { w: { used: 1, total: 2 } } },
      c5: { plan: null, message: 'Token expired — reconnect', fetchedAt, quotas: null },
    },
    intervalMinutes: 70,
  };
  const PROVIDERS = {
    connections: [
      { id: 'c1', provider: 'claude', name: 'work', isActive: true },
      { id: 'c2', provider: 'antigravity', name: 'a1', isActive: true },
      { id: 'c3', provider: 'command-code', isActive: true },
      { id: 'c4', provider: 'github', isActive: true },
      { id: 'c5', provider: 'codex', name: 'old', isActive: true },
      { id: 'off', provider: 'claude', isActive: false },
    ],
  };
  const routes = {
    [`${ROOT}/api/usage/provider-limits`]: LIMITS,
    [`${ROOT}/api/providers`]: PROVIDERS,
  };
  const refresh = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    refreshProviderAccountQuota({
      providerId: 'omniroute',
      type: 'omniroute',
      baseUrl: `${ROOT}/v1`,
      apiKey: '',
      managementToken: 'oma_test',
      fetchImpl,
      ...extra,
    });

  it('reads the pool with the management token only, never following a redirect', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { fetchImpl, calls } = api(routes);
    expect(await refresh(fetchImpl)).toEqual({ vendor: 'omniroute', ok: true });
    expect(calls.map((c) => c.url).sort()).toEqual([
      `${ROOT}/api/providers`,
      `${ROOT}/api/usage/provider-limits`,
    ]);
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe('Bearer oma_test');
      expect(call.redirect).toBe('error');
    }
  });

  it('records one pool meter per live connection', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await refresh(api(routes).fetchImpl);
    const meters = getProviderQuota('omniroute');
    expect(meters.map((m) => m.meterLabel).sort()).toEqual([
      'Antigravity · a1',
      'Claude · work',
      'Codex · old',
      'Command Code',
      'Copilot',
    ]);
    for (const m of meters) {
      expect(m.via).toBe('omniroute');
      expect(m.meterId).toMatch(/^omniroute:[a-z-]+:c\d$/);
      expect(m.capturedAt).toBe(Date.parse(fetchedAt));
    }
  });

  it('drops windows that reset after the cache was taken, and reads lengths it is told', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await refresh(api(routes).fetchImpl);
    const claude = getProviderQuota('omniroute').find((m) => m.meterId === 'omniroute:claude:c1');
    expect(claude?.planLabel).toBe('default_claude_max_20x');
    expect(claude?.windows).toEqual([
      {
        id: 'weekly (7d)',
        label: 'weekly (7d)',
        usedPercent: 60,
        windowMinutes: 10_080,
        resetsAt: sec(NOW + 40 * HOUR),
      },
      {
        id: 'weekly fable (7d)',
        label: 'weekly fable (7d)',
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt: sec(NOW + 40 * HOUR),
      },
    ]);
  });

  it('folds per-model buckets that move together', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await refresh(api(routes).fetchImpl);
    const agy = getProviderQuota('omniroute').find((m) => m.meterId === 'omniroute:antigravity:c2');
    expect(agy?.windows.map((w) => [w.label, Number(w.usedPercent.toFixed(2))])).toEqual([
      ['gemini-pro +2', 57.03],
      ['gpt-oss', 0],
    ]);
  });

  it('reads a currency amount without a reset as a balance, and a cut-off window', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await refresh(api(routes).fetchImpl);
    const meters = getProviderQuota('omniroute');
    const cc = meters.find((m) => m.meterId === 'omniroute:command-code:c3');
    expect(cc?.credits).toEqual({ hasCredits: true, unlimited: false, balance: '$8.03' });
    expect(cc?.windows.map((w) => w.label)).toEqual(['Weekly window']);
    const copilot = meters.find((m) => m.meterId === 'omniroute:github:c4');
    expect(copilot?.reachedWindowId).toBe('premium_interactions');
    expect(copilot?.windows.find((w) => w.id === 'codex')).toMatchObject({
      usedPercent: 39,
      windowMinutes: 10_080,
    });
    expect(copilot?.windows.some((w) => w.id === 'unlimited')).toBe(false);
  });

  it("shows an account's error, and clears it once the account recovers", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    await refresh(api(routes).fetchImpl);
    const note = () =>
      getProviderQuota('omniroute').find((m) => m.meterId === 'omniroute:codex:c5')?.note;
    expect(note()).toBe('Token expired — reconnect');
    const recovered = structuredClone(LIMITS) as typeof LIMITS;
    (recovered.caches as Record<string, unknown>)['c5'] = {
      plan: 'pro',
      message: null,
      fetchedAt,
      quotas: { session: { used: 5, total: 100, resetAt: iso(NOW + HOUR) } },
    };
    await refresh(api({ ...routes, [`${ROOT}/api/usage/provider-limits`]: recovered }).fetchImpl);
    expect(note()).toBe('');
  });

  it('needs the management token: the inference key alone reads nothing', async () => {
    const { fetchImpl, calls } = api(routes);
    expect(
      await refresh(fetchImpl, { managementToken: undefined, apiKey: 'sk-inference' }),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('records nothing when either read is refused', async () => {
    const { fetchImpl } = api({ [`${ROOT}/api/providers`]: PROVIDERS });
    expect(await refresh(fetchImpl)).toEqual({ vendor: 'omniroute', ok: false });
    expect(getProviderQuota('omniroute')).toEqual([]);
  });

  it('reads after turns for a keyless gateway that has a token', () => {
    setAccountQuotaReporting(true);
    const provider = { id: 'omniroute', stream: vi.fn(), complete: vi.fn() } as unknown as Provider;
    const { stream } = provider;
    attachAccountQuotaReporting(provider, {
      providerId: 'omniroute',
      type: 'omniroute',
      apiKey: '',
      managementToken: 'oma_test',
    });
    expect(provider.stream).not.toBe(stream);
  });
});

describe('prepaid balances', () => {
  it('reads DeepSeek, every currency', async () => {
    const { fetchImpl, calls } = api({
      'https://api.deepseek.com/user/balance': {
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '110.00',
            granted_balance: '10.00',
            topped_up_balance: '100.00',
          },
          { currency: 'USD', total_balance: '2.5', granted_balance: '0', topped_up_balance: '2.5' },
        ],
      },
    });
    expect(
      await refreshProviderAccountQuota({ providerId: 'deepseek', apiKey: 'sk-ds', fetchImpl }),
    ).toEqual({ vendor: 'deepseek', ok: true });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-ds');
    const [snapshot] = getProviderQuota('deepseek');
    expect(snapshot).toMatchObject({
      meterId: 'balance',
      meterLabel: 'DeepSeek',
      windows: [],
      credits: { hasCredits: true, unlimited: false, balance: '¥110.00 + $2.50' },
    });
  });

  it('reads Moonshot in the currency of its region', async () => {
    const body = {
      code: 0,
      data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
      scode: '0x0',
      status: true,
    };
    const { fetchImpl } = api({
      'https://api.moonshot.ai/v1/users/me/balance': body,
      'https://api.moonshot.cn/v1/users/me/balance': body,
    });
    await refreshProviderAccountQuota({ providerId: 'moonshotai', apiKey: 'k', fetchImpl });
    await refreshProviderAccountQuota({ providerId: 'moonshotai-cn', apiKey: 'k', fetchImpl });
    expect(getProviderQuota('moonshotai')[0]?.credits?.balance).toBe('$49.59');
    expect(getProviderQuota('moonshotai-cn')[0]?.credits?.balance).toBe('¥49.59');
  });

  it('reads only the balance from SiliconFlow, and nothing from a failed status', async () => {
    const { fetchImpl } = api({
      'https://api.siliconflow.com/v1/user/info': {
        code: 20000,
        status: true,
        data: { email: 'someone@example.com', balance: '0.88', totalBalance: '88.00' },
      },
      'https://api.siliconflow.cn/v1/user/info': { code: 30001, status: false, data: null },
    });
    await refreshProviderAccountQuota({ providerId: 'siliconflow', apiKey: 'k', fetchImpl });
    const [snapshot] = getProviderQuota('siliconflow');
    expect(snapshot?.credits?.balance).toBe('$88.00');
    expect(JSON.stringify(snapshot)).not.toContain('someone');
    expect(
      await refreshProviderAccountQuota({ providerId: 'siliconflow-cn', apiKey: 'k', fetchImpl }),
    ).toEqual({ vendor: 'siliconflow', ok: false });
  });

  it('sees the vendor through a WrongProxy mount', async () => {
    const { fetchImpl, calls } = api({});
    await refreshProviderAccountQuota({
      providerId: 'ds',
      baseUrl: 'http://localhost:3444/proxy/api.deepseek.com',
      apiKey: 'k',
      fetchImpl,
    });
    expect(calls.map((c) => c.url)).toEqual(['https://api.deepseek.com/user/balance']);
  });
});

describe('quotaEndpoint', () => {
  const baseUrl = 'https://relay.example.com/v1';

  it('reads a window and a balance from the configured paths', async () => {
    const reset = NOW + 5 * HOUR;
    const { fetchImpl, calls } = api({
      'https://relay.example.com/api/usage': {
        data: { plan: { used: '30', limit: 120, renews_at: sec(reset) }, wallet: [{ usd: 4.5 }] },
      },
    });
    const result = await refreshProviderAccountQuota({
      providerId: 'relay',
      baseUrl,
      apiKey: 'sk-relay',
      fetchImpl,
      quotaEndpoint: {
        url: 'https://relay.example.com/api/usage',
        used: '$.data.plan.used',
        total: 'data.plan.limit',
        resetAt: 'data.plan.renews_at',
        windowMinutes: 1440,
        label: 'daily',
        balance: 'data.wallet.0.usd',
      },
    });
    expect(result).toEqual({ vendor: 'custom', ok: true });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-relay');
    expect(calls[0]?.redirect).toBe('error');
    expect(getProviderQuota('relay')[0]).toMatchObject({
      windows: [
        {
          id: 'primary',
          label: 'daily',
          usedPercent: 25,
          windowMinutes: 1440,
          resetsAt: sec(reset),
        },
      ],
      credits: { hasCredits: true, balance: '$4.50' },
    });
  });

  it('reads remaining, a direct percent, ms and ISO resets, and x-api-key auth', async () => {
    const reset = NOW + HOUR;
    const { fetchImpl, calls } = api({
      'https://relay.example.com/a': { left: 25, cap: 100, at: reset },
      'https://relay.example.com/b': { pct: 91, at: iso(reset) },
    });
    const read = (providerId: string, quotaEndpoint: Record<string, unknown>) =>
      refreshProviderAccountQuota({
        providerId,
        baseUrl,
        apiKey: 'k',
        fetchImpl,
        quotaEndpoint: quotaEndpoint as never,
      });
    await read('a', {
      url: 'https://relay.example.com/a',
      remaining: 'left',
      total: 'cap',
      resetAt: 'at',
    });
    await read('b', {
      url: 'https://relay.example.com/b',
      percent: 'pct',
      resetAt: 'at',
      auth: 'x-api-key',
    });
    expect(getProviderQuota('a')[0]?.windows[0]).toMatchObject({
      usedPercent: 75,
      resetsAt: sec(reset),
    });
    expect(getProviderQuota('b')[0]?.windows[0]).toMatchObject({
      usedPercent: 91,
      resetsAt: sec(reset),
    });
    expect(calls[1]?.headers.get('x-api-key')).toBe('k');
    expect(calls[1]?.headers.get('authorization')).toBeNull();
  });

  it('never sends the key to another host, over plain http, or with credentials in the URL', async () => {
    const { fetchImpl, calls } = api({});
    for (const url of [
      'https://attacker.example.net/usage',
      'https://relay.example.com.attacker.net/usage',
      'http://relay.example.com/usage',
      'https://user:pw@relay.example.com/usage',
      'not a url',
    ]) {
      expect(
        await refreshProviderAccountQuota({
          providerId: 'relay',
          baseUrl,
          apiKey: 'k',
          fetchImpl,
          quotaEndpoint: { url, percent: 'p' },
        }),
      ).toEqual({ vendor: 'custom', ok: false });
    }
    expect(calls).toEqual([]);
  });

  it('allows plain http on loopback, and wins over the host-based reader', async () => {
    const { fetchImpl, calls } = api({ 'http://localhost:8080/quota': { p: 10 } });
    await refreshProviderAccountQuota({
      providerId: 'local',
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'k',
      fetchImpl,
      quotaEndpoint: { url: 'http://localhost:8080/quota', percent: 'p', auth: 'none' },
    });
    expect(calls[0]?.headers.get('authorization')).toBeNull();
    expect(getProviderQuota('local')[0]?.windows[0]?.usedPercent).toBe(10);

    const ds = api({ 'https://api.deepseek.com/custom': { p: 3 } });
    expect(
      await refreshProviderAccountQuota({
        providerId: 'deepseek',
        apiKey: 'k',
        fetchImpl: ds.fetchImpl,
        quotaEndpoint: { url: 'https://api.deepseek.com/custom', percent: 'p' },
      }),
    ).toEqual({ vendor: 'custom', ok: true });
  });

  it('does not walk into the prototype chain', async () => {
    const { fetchImpl } = api({ 'https://relay.example.com/u': { a: 1 } });
    expect(
      await refreshProviderAccountQuota({
        providerId: 'relay',
        baseUrl,
        apiKey: 'k',
        fetchImpl,
        quotaEndpoint: { url: 'https://relay.example.com/u', balance: '__proto__.toString.length' },
      }),
    ).toEqual({ vendor: 'custom', ok: false });
  });
});
