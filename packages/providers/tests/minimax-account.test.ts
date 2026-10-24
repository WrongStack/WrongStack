/**
 * MiniMax transport — what is MiniMax-specific beyond the wire routing covered
 * in minimax.test.ts: the documented thinking controls (M3 toggle, M3.1 effort,
 * M2.x fixed), the 5-minute-only cache, the Token Plan quota read after turns
 * and on quota failures, and region-aware auth errors.
 */

import { ProviderError, type Request } from '@wrongstack/contracts/types';
import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMiniMaxHost, isMiniMaxProviderId, MiniMaxProvider } from '../src/minimax.js';

afterEach(() => {
  resetProviderQuota();
});

const HOUR = 3_600_000;

function request(model: string, extra: Partial<Request> = {}): Request {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8192,
    ...extra,
  };
}

async function drain(provider: MiniMaxProvider, req: Request): Promise<void> {
  for await (const _event of provider.stream(req, { signal: new AbortController().signal })) {
    // Assertions inspect the captured fetch calls.
  }
}

async function failure(provider: MiniMaxProvider, req: Request): Promise<ProviderError> {
  try {
    await drain(provider, req);
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('expected the stream to fail');
}

function quotaBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      {
        model_name: 'MiniMax-M*',
        start_time: now - 2 * HOUR,
        end_time: now + 3 * HOUR,
        remains_time: 3 * HOUR,
        current_interval_total_count: 1500,
        current_interval_usage_count: 1500,
        current_interval_remaining_percent: 40,
        current_interval_status: 1,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_status: 3,
        ...overrides,
      },
    ],
  };
}

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** Route fetches by path: chat surfaces, the quota endpoint, anything else. */
function router(routes: { chat?: () => Response; quota?: (url: string) => Response }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    if (url.includes('/token_plan/') || url.includes('/account/')) {
      return routes.quota ? routes.quota(url) : new Response('{}', { status: 404 });
    }
    return routes.chat ? routes.chat() : new Response('', { status: 200 });
  }) as never as typeof fetch;
  return { fetchImpl, calls };
}

/** The Messages-surface body MiniMax receives for one request. */
async function wireBody(
  model: string,
  extra: Partial<Request> = {},
): Promise<Record<string, unknown>> {
  const { fetchImpl, calls } = router({});
  const provider = new MiniMaxProvider({ apiKey: 'k', fetchImpl, quotaReporting: false });
  await drain(provider, request(model, extra));
  return calls[0]?.body ?? {};
}

describe('thinking controls (MiniMax Messages API)', () => {
  it('turns M3 thinking on with `adaptive` — omitted means OFF on M3', async () => {
    for (const model of ['MiniMax-M3', 'minimax-m3-highspeed']) {
      for (const reasoning of [{ enabled: true }, { effort: 'medium' as const }]) {
        const body = await wireBody(model, { reasoning });
        expect(body['thinking'], model).toEqual({ type: 'adaptive' });
        expect(body).not.toHaveProperty('output_config');
      }
    }
    for (const reasoning of [{ enabled: false }, { effort: 'none' as const }, {}, undefined]) {
      expect(await wireBody('MiniMax-M3', { reasoning })).not.toHaveProperty('thinking');
    }
  });

  it('tunes M3.1 depth via output_config.effort and never sends a thinking type', async () => {
    const cases: Array<[Request['reasoning'], string | undefined]> = [
      [{ effort: 'high' }, 'high'],
      [{ effort: 'max' }, 'max'],
      [{ effort: 'xhigh' }, 'xhigh'],
      [{ effort: 'minimal' }, 'low'],
      [{ effort: 'none' }, 'low'],
      [{ enabled: false }, 'low'],
      [{ enabled: true }, undefined],
    ];
    for (const [reasoning, effort] of cases) {
      const body = await wireBody('MiniMax-M3.1-Flash-Preview', { reasoning });
      expect(body).not.toHaveProperty('thinking');
      if (effort === undefined) expect(body).not.toHaveProperty('output_config');
      else expect(body['output_config']).toEqual({ effort });
    }
  });

  it('sends nothing to the always-thinking M2.x models', async () => {
    for (const model of ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']) {
      const body = await wireBody(model, { reasoning: { enabled: true, effort: 'high' } });
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('output_config');
    }
  });

  it('keeps temperature — MiniMax does not tie sampling to thinking like Anthropic', async () => {
    const body = await wireBody('MiniMax-M3', { reasoning: { effort: 'high' }, temperature: 0.2 });
    expect(body['temperature']).toBe(0.2);
  });
});

describe('prompt cache TTL', () => {
  it('keeps the configured 1h TTL off a system breakpoint', async () => {
    const body = await wireBody('MiniMax-M2.7', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      cache: { ttl: '1h' },
    });
    expect(JSON.stringify(body)).not.toContain('"ttl"');
    expect(JSON.stringify(body['system'])).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it('keeps it off the conversation-boundary breakpoint too', async () => {
    const body = await wireBody('MiniMax-M2.7', {
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'boundary', cache_control: { type: 'ephemeral' } }],
        },
        { role: 'user', content: [{ type: 'text', text: 'tail' }] },
      ],
      cache: { ttl: '1h' },
    });
    expect(JSON.stringify(body)).not.toContain('"ttl"');
    const messages = body['messages'] as Array<{ content: unknown }>;
    expect(JSON.stringify(messages[1]?.content)).toContain('"cache_control":{"type":"ephemeral"}');
  });
});

describe('host and id recognition', () => {
  it('recognises both regions and the legacy domains', () => {
    expect(isMiniMaxHost('https://api.minimax.io/anthropic/v1')).toBe(true);
    expect(isMiniMaxHost('https://api.minimax.cn')).toBe(true);
    expect(isMiniMaxHost('https://api.minimaxi.com/v1')).toBe(true);
    expect(isMiniMaxHost('https://api.minimaxi.chat')).toBe(true);
    expect(isMiniMaxHost('https://evilminimax.io')).toBe(false);
    expect(isMiniMaxHost('https://proxy.example.com/minimax')).toBe(false);
    expect(isMiniMaxHost('http://localhost:3444/proxy/api.minimax.io/anthropic/v1')).toBe(true);
    expect(isMiniMaxHost('http://localhost:3444/proxy/api.example.com/v1')).toBe(false);
    expect(isMiniMaxHost('not a url')).toBe(false);
    expect(isMiniMaxHost(undefined)).toBe(false);
  });

  it('recognises the catalog ids', () => {
    for (const id of ['minimax', 'minimax-coding-plan', 'minimax-cn', 'MiniMax-cn-coding-plan']) {
      expect(isMiniMaxProviderId(id)).toBe(true);
    }
    expect(isMiniMaxProviderId('minimaxx')).toBe(false);
    expect(isMiniMaxProviderId(undefined)).toBe(false);
  });
});

describe('Token Plan quota', () => {
  it('reads the quota after a completed turn, at most once a minute', async () => {
    const { fetchImpl, calls } = router({
      quota: () => new Response(JSON.stringify(quotaBody()), { status: 200 }),
    });
    const provider = new MiniMaxProvider({ id: 'minimax-coding-plan', apiKey: 'k', fetchImpl });
    await drain(provider, request('MiniMax-M3'));
    await vi.waitFor(() => expect(getProviderQuota('minimax-coding-plan')).toHaveLength(1));
    await drain(provider, request('MiniMax-M3'));
    await provider
      .complete(request('MiniMax-M3'), { signal: new AbortController().signal })
      .catch(() => undefined);
    expect(calls.filter((c) => c.url.includes('/token_plan/'))).toHaveLength(1);
    expect(calls.find((c) => c.url.includes('/token_plan/'))?.url).toBe(
      'https://api.minimax.io/v1/token_plan/remains',
    );
  });

  it('traces chat through WrongProxy but reads quota straight from MiniMax', async () => {
    const { fetchImpl, calls } = router({
      quota: () => new Response(JSON.stringify(quotaBody()), { status: 200 }),
    });
    const provider = new MiniMaxProvider({
      id: 'minimax-coding-plan',
      apiKey: 'k',
      baseUrl: 'http://localhost:3444/proxy/api.minimax.io/anthropic/v1',
      fetchImpl,
    });
    await drain(provider, request('MiniMax-M3'));
    await vi.waitFor(() => expect(getProviderQuota('minimax-coding-plan')).toHaveLength(1));
    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:3444/proxy/api.minimax.io/anthropic/v1/messages',
      'https://api.minimax.io/v1/token_plan/remains',
    ]);
  });

  it('never probes a non-MiniMax host with the key', async () => {
    const { fetchImpl, calls } = router({});
    const provider = new MiniMaxProvider({
      apiKey: 'k',
      baseUrl: 'https://proxy.example.com/anthropic',
      fetchImpl,
    });
    await drain(provider, request('MiniMax-M3'));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.url)).toEqual(['https://proxy.example.com/anthropic/v1/messages']);
  });

  it('turns "usage limit exceeded" into a wait until the real window reset', async () => {
    const { fetchImpl } = router({
      chat: () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'usage limit exceeded (2056)' },
          }),
          { status: 429 },
        ),
      quota: () =>
        new Response(
          JSON.stringify(
            quotaBody({ current_interval_status: 2, current_interval_remaining_percent: 0 }),
          ),
          { status: 200 },
        ),
    });
    const provider = new MiniMaxProvider({ apiKey: 'k', fetchImpl });
    const err = await failure(provider, request('MiniMax-M2.7'));
    expect(err.kind).toBe('quota_exhausted');
    const wait = err.body?.retryAfterMs ?? 0;
    expect(wait).toBeGreaterThan(3 * HOUR - 60_000);
    expect(wait).toBeLessThanOrEqual(3 * HOUR);
    expect(getProviderQuota('minimax')[0]?.reachedWindowId).toBe('primary');
  });

  it('leaves a quota failure alone when the plan shows nothing exhausted', async () => {
    const { fetchImpl } = router({
      chat: () =>
        new Response(JSON.stringify({ error: { message: 'insufficient balance (1008)' } }), {
          status: 402,
        }),
      quota: () => new Response(JSON.stringify(quotaBody()), { status: 200 }),
    });
    const err = await failure(
      new MiniMaxProvider({ apiKey: 'k', fetchImpl }),
      request('MiniMax-M3'),
    );
    expect(err.kind).toBe('quota_exhausted');
    expect(err.body?.retryAfterMs).toBeUndefined();
  });
});

describe('region-bound keys', () => {
  it('names the other region when it accepts the rejected key', async () => {
    const { fetchImpl, calls } = router({
      chat: () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid api key' },
          }),
          { status: 401 },
        ),
      quota: (url) =>
        url.startsWith('https://api.minimax.cn')
          ? new Response(JSON.stringify(quotaBody()), { status: 200 })
          : new Response('{}', { status: 401 }),
    });
    const err = await failure(
      new MiniMaxProvider({ apiKey: 'k', fetchImpl }),
      request('MiniMax-M3'),
    );
    expect(err.status).toBe(401);
    expect(err.body?.message).toContain("MiniMax's China region");
    expect(err.body?.message).toContain('https://api.minimax.cn');
    expect(err.body?.message?.startsWith('invalid api key — ')).toBe(true);
    expect(calls.some((c) => c.url === 'https://api.minimax.cn/v1/token_plan/remains')).toBe(true);
  });

  it('points a China host at the international one', async () => {
    const { fetchImpl } = router({
      chat: () => new Response('', { status: 401 }),
      quota: (url) =>
        url.startsWith('https://api.minimax.io')
          ? new Response(JSON.stringify(quotaBody()), { status: 200 })
          : new Response('{}', { status: 401 }),
    });
    const err = await failure(
      new MiniMaxProvider({
        apiKey: 'k',
        baseUrl: 'https://api.minimax.cn/anthropic/v1',
        fetchImpl,
      }),
      request('MiniMax-M3'),
    );
    expect(err.body?.message).toContain("MiniMax's international region");
  });

  it('adds nothing when the other region rejects the key too', async () => {
    const { fetchImpl } = router({
      chat: () => new Response('', { status: 401 }),
      quota: () => new Response('{}', { status: 401 }),
    });
    const err = await failure(
      new MiniMaxProvider({ apiKey: 'k', fetchImpl }),
      request('MiniMax-M3'),
    );
    expect(err.body?.message ?? '').not.toContain('region');
  });

  it('passes failures it cannot explain through as the same object', async () => {
    const boom = new Error('socket hang up');
    const fetchImpl = vi.fn(async () => {
      throw boom;
    }) as never as typeof fetch;
    const provider = new MiniMaxProvider({ apiKey: 'k', fetchImpl, quotaReporting: false });
    const direct = await provider
      .complete(request('some-other-model'), { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    // Whatever the transport made of the socket error (raw, or a network-kind
    // ProviderError) must arrive unchanged — no probe, no rewrite.
    expect(direct === boom || (direct instanceof ProviderError && direct.kind === 'network')).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAI-surface failures', () => {
  it('raises a 200 stream carrying a MiniMax error envelope instead of an empty turn', async () => {
    const sse = `data: ${JSON.stringify({
      id: 'r1',
      choices: null,
      base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
    })}

`;
    const { fetchImpl } = router({
      chat: () =>
        new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const err = await failure(
      new MiniMaxProvider({ apiKey: 'k', fetchImpl, quotaReporting: false }),
      request('some-other-model'),
    );
    expect(err.kind).toBe('quota_exhausted');
    expect(err.body?.message).toBe('insufficient balance (1008)');
  });
});
