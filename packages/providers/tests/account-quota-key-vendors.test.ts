/**
 * Kimi Code, OpenCode Go and OpenRouter plan quota: the three account reads
 * whose transports cannot report usage themselves. Fixtures are shaped after
 * live responses (2026-09-30), identities removed.
 */

import type {
  Provider,
  Response as ProviderResponse,
  StreamEvent,
} from '@wrongstack/contracts/types';
import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachAccountQuotaReporting,
  refreshProviderAccountQuota,
  setAccountQuotaReporting,
} from '../src/account-quota.js';
import { reportKimiCodeQuota } from '../src/kimi-code-quota.js';
import { reportOpenCodeQuota } from '../src/opencode-quota.js';
import { reportOpenRouterQuota } from '../src/openrouter-quota.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const sec = (ms: number) => Math.floor(ms / 1000);
const HOUR = 3_600_000;

afterEach(() => {
  resetProviderQuota();
  setAccountQuotaReporting(false);
  vi.useRealTimers();
});

/** A fetch that answers every request with `body`, or per URL suffix. */
function answering(body: unknown | ((url: string) => unknown)): typeof fetch {
  return (async (input: unknown) =>
    new Response(
      JSON.stringify(typeof body === 'function' ? body(String(input)) : body),
    )) as unknown as typeof fetch;
}

const kimi = (providerId: string, body: unknown, now: number) =>
  reportKimiCodeQuota(providerId, { apiKey: 'k', fetchImpl: answering(body), now });
const openCode = (providerId: string, body: unknown, now: number) =>
  reportOpenCodeQuota(providerId, { apiKey: 'k', fetchImpl: answering(body), now });
async function openRouter(key: unknown, credits: unknown = {}) {
  const fetchImpl = answering((url: string) => (url.endsWith('/key') ? key : credits));
  const [snapshot] = await reportOpenRouterQuota('openrouter', {
    apiKey: 'k',
    fetchImpl,
    now: NOW,
  });
  return snapshot;
}

describe('Kimi Code usages', () => {
  const weeklyReset = NOW + 5 * 24 * HOUR;
  const sessionReset = NOW + 3 * HOUR;

  it('reads the weekly counter when the 7d ratio is a zero placeholder (live shape)', async () => {
    const [snapshot] = await kimi(
      'kimi-for-coding',
      {
        usage: { limit: '100', used: '20', remaining: '80', resetTime: iso(weeklyReset) },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { limit: '100', remaining: '100', resetTime: iso(sessionReset) },
          },
        ],
        usages: {
          limit_5h: { used_ratio: 0, reset_time: iso(sessionReset + 700) },
          limit_7d: { used_ratio: 0, reset_time: iso(weeklyReset + 1_300) },
        },
      },
      NOW,
    );
    expect(snapshot).toMatchObject({ providerId: 'kimi-for-coding', meterLabel: 'Kimi Code' });
    expect(snapshot?.windows).toEqual([
      { id: 'primary', usedPercent: 0, windowMinutes: 300, resetsAt: sec(sessionReset + 700) },
      { id: 'secondary', usedPercent: 20, windowMinutes: 10_080, resetsAt: sec(weeklyReset) },
    ]);
  });

  it('keeps a non-zero ratio over the counter', async () => {
    const [snapshot] = await kimi(
      'k',
      {
        usage: { limit: 100, used: 20, resetTime: iso(weeklyReset) },
        usages: { limit_7d: { used_ratio: 0.35, reset_time: iso(weeklyReset) } },
      },
      NOW,
    );
    expect(snapshot?.windows).toEqual([
      { id: 'secondary', usedPercent: 35, windowMinutes: 10_080, resetsAt: sec(weeklyReset) },
    ]);
  });

  it('keeps a zero ratio when the response carries the monthly pool', async () => {
    const [snapshot] = await kimi(
      'k',
      {
        usage: { limit: 100, used: 20, resetTime: iso(weeklyReset) },
        usages: {
          limit_7d: { used_ratio: 0, reset_time: iso(weeklyReset) },
          limit_month_total: { used_ratio: 0.5, reset_time: iso(NOW + 20 * 24 * HOUR) },
        },
      },
      NOW,
    );
    expect(snapshot?.windows.map((w) => [w.id, w.usedPercent, w.label])).toEqual([
      ['secondary', 0, undefined],
      ['monthly', 50, 'month'],
    ]);
  });

  it('keeps a zero ratio when the counter resets at a different time', async () => {
    const [snapshot] = await kimi(
      'k',
      {
        usage: { limit: 100, used: 20, resetTime: iso(weeklyReset) },
        usages: { limit_7d: { used_ratio: 0, reset_time: iso(weeklyReset + 60_000) } },
      },
      NOW,
    );
    expect(snapshot?.windows[0]?.usedPercent).toBe(0);
  });

  it('derives use from remaining, and drops the duration of an unreliable counter', async () => {
    const [counted] = await kimi(
      'k',
      { usage: { limit: '50', remaining: '40', resetTime: iso(weeklyReset) } },
      NOW,
    );
    expect(counted?.windows[0]).toMatchObject({ usedPercent: 20, windowMinutes: 10_080 });
    const [unreliable] = await kimi('k', { usage: { limit: 50 } }, NOW);
    expect(unreliable?.windows[0]).toEqual({ id: 'secondary', usedPercent: 0 });
  });

  it('records nothing for a body without windows', async () => {
    expect(await kimi('k', {}, NOW)).toEqual([]);
    expect(await kimi('k', null, NOW)).toEqual([]);
    expect(await kimi('k', { usage: { limit: 0, used: 0 } }, NOW)).toEqual([]);
  });
});

describe('OpenCode Go usage', () => {
  const rolling = NOW + 2 * HOUR;
  const weekly = NOW + 3 * 24 * HOUR;
  const monthly = NOW + 20 * 24 * HOUR;

  it('maps the three windows and marks the cut-off one as reached', async () => {
    const [snapshot] = await openCode(
      'opencode-go',
      {
        usage: {
          rolling: { status: 'ok', percent: 12, resetsAt: iso(rolling) },
          weekly: { status: 'rate-limited', percent: 80, resetsAt: iso(weekly) },
          monthly: { status: 'ok', percent: 5, resetsAt: iso(monthly) },
        },
      },
      NOW,
    );
    expect(snapshot).toMatchObject({ meterLabel: 'OpenCode Go', reachedWindowId: 'secondary' });
    expect(snapshot?.windows).toEqual([
      { id: 'primary', usedPercent: 12, windowMinutes: 300, resetsAt: sec(rolling) },
      { id: 'secondary', usedPercent: 100, windowMinutes: 10_080, resetsAt: sec(weekly) },
      { id: 'monthly', label: 'month', usedPercent: 5, resetsAt: sec(monthly) },
    ]);
  });

  it('skips malformed windows instead of guessing', async () => {
    const [snapshot] = await openCode(
      'o',
      {
        usage: {
          rolling: { status: 'ok', percent: 12, resetsAt: iso(rolling) },
          weekly: { status: 'unknown', percent: 1, resetsAt: iso(weekly) },
          monthly: { status: 'ok', percent: 140, resetsAt: iso(monthly) },
        },
      },
      NOW,
    );
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['primary']);
    expect(snapshot?.reachedWindowId).toBeUndefined();
    expect(await openCode('o', { usage: {} }, NOW)).toEqual([]);
  });
});

describe('OpenRouter limits and balance', () => {
  it('reads the free-model allowance and a resetting key limit', async () => {
    const snapshot = await openRouter({
      data: {
        is_free_tier: true,
        limit: 10,
        limit_remaining: 7.5,
        limit_reset: 'weekly',
        free_model_daily_requests: { used: 5, limit: 50, remaining: 45 },
      },
    });
    expect(snapshot).toMatchObject({ meterLabel: 'OpenRouter', planLabel: 'free tier' });
    expect(snapshot?.windows).toEqual([
      { id: 'free-daily', label: 'free/day', usedPercent: 10, windowMinutes: 1440 },
      { id: 'key-limit', label: 'key/week', usedPercent: 25, windowMinutes: 10_080 },
    ]);
  });

  it('records no key window for an uncapped key (live shape)', async () => {
    const snapshot = await openRouter({
      data: {
        is_free_tier: true,
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        free_model_daily_requests: { used: 0, limit: 50, remaining: 50 },
      },
    });
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['free-daily']);
  });

  it('formats the balance, negative included', async () => {
    expect(
      (await openRouter({}, { data: { total_credits: 0, total_usage: 0.087 } }))?.credits,
    ).toEqual({ hasCredits: false, unlimited: false, balance: '-$0.09' });
    expect(
      (await openRouter({}, { data: { total_credits: 20, total_usage: 4.5 } }))?.credits,
    ).toEqual({ hasCredits: true, unlimited: false, balance: '$15.50' });
  });

  it('records nothing when neither read is usable', async () => {
    expect(await openRouter({}, { data: {} })).toBeUndefined();
    expect(getProviderQuota('openrouter')).toEqual([]);
  });
});

function vendorApi(): { fetchImpl: typeof fetch; calls: Array<{ url: string; auth: string }> } {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization') ?? '' });
    const reset = iso(Date.now() + HOUR);
    if (url.endsWith('/coding/v1/usages')) {
      return new Response(
        JSON.stringify({ usages: { limit_5h: { used_ratio: 0.4, reset_time: reset } } }),
      );
    }
    if (url === 'https://opencode.ai/zen/go/v1/usage') {
      return new Response(
        JSON.stringify({ usage: { rolling: { status: 'ok', percent: 9, resetsAt: reset } } }),
      );
    }
    if (url === 'https://openrouter.ai/api/v1/key') {
      return new Response(
        JSON.stringify({ data: { free_model_daily_requests: { used: 1, limit: 50 } } }),
      );
    }
    if (url === 'https://openrouter.ai/api/v1/credits') {
      return new Response(JSON.stringify({ data: { total_credits: 5, total_usage: 1 } }));
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('refreshProviderAccountQuota — key-read vendors', () => {
  it('reads Kimi Code on the host the key was issued for', async () => {
    const api = vendorApi();
    const result = await refreshProviderAccountQuota({
      providerId: 'kimi-intl',
      baseUrl: 'https://api.kimi.ai/coding/v1',
      apiKey: 'sk-kimi',
      fetchImpl: api.fetchImpl,
    });
    expect(result).toEqual({ vendor: 'kimi', ok: true });
    expect(api.calls).toEqual([
      { url: 'https://api.kimi.ai/coding/v1/usages', auth: 'Bearer sk-kimi' },
    ]);
    expect(getProviderQuota('kimi-intl')[0]?.windows[0]?.usedPercent).toBe(40);
  });

  it('uses the catalog default for a provider saved without a base URL', async () => {
    const api = vendorApi();
    const result = await refreshProviderAccountQuota({
      providerId: 'kimi-for-coding',
      apiKey: 'sk-kimi',
      fetchImpl: api.fetchImpl,
    });
    expect(result).toEqual({ vendor: 'kimi', ok: true });
    expect(api.calls[0]?.url).toBe('https://api.kimi.com/coding/v1/usages');
  });

  it('sees the vendor through a WrongProxy mount', async () => {
    const api = vendorApi();
    const result = await refreshProviderAccountQuota({
      providerId: 'my-go',
      baseUrl: 'http://localhost:3444/proxy/opencode.ai/zen/go/v1',
      apiKey: 'sk-oc',
      fetchImpl: api.fetchImpl,
    });
    expect(result).toEqual({ vendor: 'opencode', ok: true });
    expect(api.calls.map((c) => c.url)).toEqual(['https://opencode.ai/zen/go/v1/usage']);
  });

  it('reads OpenRouter limits and balance together', async () => {
    const api = vendorApi();
    const result = await refreshProviderAccountQuota({
      providerId: 'openrouter',
      apiKey: 'sk-or',
      fetchImpl: api.fetchImpl,
    });
    expect(result).toEqual({ vendor: 'openrouter', ok: true });
    const [snapshot] = getProviderQuota('openrouter');
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['free-daily']);
    expect(snapshot?.credits?.balance).toBe('$4.00');
  });

  it('leaves other hosts on those domains alone', async () => {
    const api = vendorApi();
    for (const baseUrl of [
      'https://api.kimi.com/v1',
      'https://opencode.ai/api',
      // Look-alike hosts are not the vendor.
      'https://api.deepseek.com.example.net/v1',
    ]) {
      expect(
        await refreshProviderAccountQuota({
          providerId: 'x',
          baseUrl,
          apiKey: 'k',
          fetchImpl: api.fetchImpl,
        }),
      ).toBeUndefined();
    }
    expect(api.calls).toEqual([]);
  });

  it('reports a failed read without recording anything', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const result = await refreshProviderAccountQuota({
      providerId: 'opencode-go',
      apiKey: 'bad',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ vendor: 'opencode', ok: false });
    expect(getProviderQuota('opencode-go')).toEqual([]);
  });
});

describe('attachAccountQuotaReporting', () => {
  const done: ProviderResponse = {
    content: [],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
  } as unknown as ProviderResponse;

  function fakeProvider(fail = false): Provider {
    return {
      id: 'kimi-for-coding',
      async *stream(): AsyncGenerator<StreamEvent> {
        if (fail) throw new Error('429');
        yield { type: 'message_stop' } as unknown as StreamEvent;
      },
      async complete() {
        if (fail) throw new Error('429');
        return done;
      },
    } as unknown as Provider;
  }

  const drain = async (provider: Provider) => {
    for await (const _ of provider.stream({} as never, {} as never)) {
      // consume
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  let api: ReturnType<typeof vendorApi>;
  beforeEach(() => {
    api = vendorApi();
  });

  it('is off until a host enables it', () => {
    const provider = fakeProvider();
    const { stream } = provider;
    attachAccountQuotaReporting(provider, {
      providerId: 'kimi-for-coding',
      apiKey: 'k',
      fetchImpl: api.fetchImpl,
    });
    expect(provider.stream).toBe(stream);
  });

  it('leaves providers without a post-turn read untouched', () => {
    setAccountQuotaReporting(true);
    for (const input of [
      { providerId: 'minimax', apiKey: 'k' },
      { providerId: 'anthropic', apiKey: 'k' },
      { providerId: 'kimi-for-coding', apiKey: '  ' },
    ]) {
      const provider = fakeProvider();
      const { stream, complete } = provider;
      expect(attachAccountQuotaReporting(provider, input)).toBe(provider);
      expect(provider.stream).toBe(stream);
      expect(provider.complete).toBe(complete);
    }
  });

  it('reads after a turn, in place, and throttles the next reads', async () => {
    setAccountQuotaReporting(true);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const provider = fakeProvider();
    const returned = attachAccountQuotaReporting(provider, {
      providerId: 'kimi-for-coding',
      apiKey: 'k',
      fetchImpl: api.fetchImpl,
    });
    expect(returned).toBe(provider);

    await drain(provider);
    await settle();
    expect(api.calls).toHaveLength(1);
    expect(getProviderQuota('kimi-for-coding')).toHaveLength(1);

    await provider.complete({} as never, {} as never);
    await drain(provider);
    await settle();
    expect(api.calls).toHaveLength(1);

    vi.setSystemTime(NOW + 61_000);
    await provider.complete({} as never, {} as never);
    await settle();
    expect(api.calls).toHaveLength(2);
  });

  it('still reads after a failed call — a refusal is when the reading matters', async () => {
    setAccountQuotaReporting(true);
    const provider = attachAccountQuotaReporting(fakeProvider(true), {
      providerId: 'openrouter',
      apiKey: 'k',
      fetchImpl: api.fetchImpl,
    });
    await expect(drain(provider)).rejects.toThrow('429');
    await settle();
    expect(api.calls.map((c) => c.url).sort()).toEqual([
      'https://openrouter.ai/api/v1/credits',
      'https://openrouter.ai/api/v1/key',
    ]);
  });
});

describe('provider factory', () => {
  it('instruments a key-read vendor built from config once a host enables it', async () => {
    const { makeProviderFromConfig } = await import('../src/index.js');
    const cfg = {
      type: 'openai-compatible',
      family: 'openai-compatible' as const,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or',
    };
    const plain = makeProviderFromConfig('my-router', cfg);
    expect(Object.hasOwn(plain, 'stream')).toBe(false);
    setAccountQuotaReporting(true);
    const reporting = makeProviderFromConfig('my-router', cfg);
    expect(Object.hasOwn(reporting, 'stream')).toBe(true);
    expect(Object.getPrototypeOf(reporting)).toBe(Object.getPrototypeOf(plain));
    const other = makeProviderFromConfig('elsewhere', {
      ...cfg,
      baseUrl: 'https://api.example.com/v1',
    });
    expect(Object.hasOwn(other, 'stream')).toBe(false);
  });
});
