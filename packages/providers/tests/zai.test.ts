/**
 * Z.AI / BigModel transport layer: post-turn plan quota, business-code
 * classification, exact reset times, region-aware 401s, and GLM's thinking
 * contract on the Anthropic-compatible surface. Errors travel the real
 * OpenAI-compatible parse path so `error.code` reaches the decorator the way
 * it does in production.
 */

import { type Provider, ProviderError, type Request } from '@wrongstack/contracts/types';
import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/openai-compatible.js';
import {
  listZaiAccounts,
  withZaiAccountPlane,
  ZaiAccountProvider,
  ZaiMessagesProvider,
} from '../src/zai.js';

afterEach(() => {
  resetProviderQuota();
  vi.useRealTimers();
});

const CODING = 'https://api.z.ai/api/coding/paas/v4';
const HOUR = 3_600_000;

function request(model: string, extra: Partial<Request> = {}): Request {
  return { model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096, ...extra };
}

function quotaBody(percentage: number, resetAt: number): string {
  return JSON.stringify({
    code: 200,
    success: true,
    data: {
      level: 'pro',
      limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: resetAt }],
    },
  });
}

interface Routes {
  chat?: () => Response;
  quota?: (url: string) => Response;
}

function router(routes: Routes): { fetchImpl: typeof fetch; urls: string[]; bodies: unknown[] } {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/monitor/')) {
      return routes.quota ? routes.quota(url) : new Response('{}', { status: 404 });
    }
    bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return routes.chat ? routes.chat() : new Response('', { status: 200 });
  }) as never as typeof fetch;
  return { fetchImpl, urls, bodies };
}

function zaiProvider(baseUrl: string, fetchImpl: typeof fetch, id = 'zai-coding-plan'): Provider {
  return withZaiAccountPlane(
    new OpenAICompatibleProvider({ id, apiKey: 'key', baseUrl, fetchImpl }),
    { apiKey: 'key', baseUrl, fetchImpl },
  );
}

async function drain(provider: Provider, req: Request): Promise<void> {
  for await (const _ of provider.stream(req, { signal: new AbortController().signal })) {
    // drained
  }
}

async function failure(provider: Provider, req: Request): Promise<ProviderError> {
  try {
    await drain(provider, req);
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('expected the stream to fail');
}

function zaiError(status: number, code: string, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('wrapping', () => {
  it('wraps only Z.AI / BigModel hosts', () => {
    const { fetchImpl } = router({});
    const other = new OpenAICompatibleProvider({
      id: 'x',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      fetchImpl,
    });
    expect(withZaiAccountPlane(other, { apiKey: 'k', baseUrl: 'https://api.example.com/v1' })).toBe(
      other,
    );
    expect(zaiProvider(CODING, fetchImpl)).toBeInstanceOf(ZaiAccountProvider);
    expect(
      zaiProvider('http://localhost:3444/proxy/api.z.ai/api/coding/paas/v4', fetchImpl),
    ).toBeInstanceOf(ZaiAccountProvider);
  });

  it('keeps the inner id and optional members, and registers the account', () => {
    const { fetchImpl } = router({});
    const provider = zaiProvider(CODING, fetchImpl, 'glm-work');
    expect(provider.id).toBe('glm-work');
    expect(typeof provider.warm).toBe('function');
    const account = listZaiAccounts().find((a) => a.providerId === 'glm-work');
    expect([account?.region, account?.codingPlan]).toEqual(['zai', true]);
  });

  it('exposes an optional member only when the inner transport has it', () => {
    const bare: Provider = {
      id: 'bare',
      capabilities: {} as Provider['capabilities'],
      stream: async function* () {},
      complete: () => Promise.reject(new Error('unused')),
    };
    const wrapped = withZaiAccountPlane(bare, { apiKey: 'k', baseUrl: CODING });
    expect(wrapped.generateImage).toBeUndefined();
    expect(wrapped.warm).toBeUndefined();
    expect(wrapped.refreshContextLimit).toBeUndefined();
  });

  it('carries a capability overlay down to the inner transport', async () => {
    const { fetchImpl } = router({});
    const inner = new OpenAICompatibleProvider({
      id: 'z',
      apiKey: 'k',
      baseUrl: CODING,
      fetchImpl,
    });
    const outer = withZaiAccountPlane(inner, { apiKey: 'k', baseUrl: CODING, fetchImpl });
    const overlay = { ...outer.capabilities, maxContext: 123_456 };
    Object.defineProperty(outer, 'capabilities', {
      value: overlay,
      writable: true,
      configurable: true,
    });
    await drain(outer, request('glm-5.3'));
    expect(inner.capabilities).toBe(overlay);
  });
});

describe('plan quota', () => {
  it('reads the quota after a completed turn and records it under the provider id', async () => {
    const reset = Date.now() + 2 * HOUR;
    const { fetchImpl, urls } = router({ quota: () => new Response(quotaBody(37, reset)) });
    await drain(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    await settle();
    expect(urls.filter((u) => u.includes('/quota/limit'))).toEqual([
      'https://api.z.ai/api/monitor/usage/quota/limit',
    ]);
    const [snapshot] = getProviderQuota('zai-coding-plan');
    expect(snapshot?.planLabel).toBe('coding pro');
    expect(snapshot?.windows[0]).toMatchObject({
      id: 'primary',
      usedPercent: 37,
      windowMinutes: 300,
    });
  });

  it('throttles post-turn reads', async () => {
    const { fetchImpl, urls } = router({
      quota: () => new Response(quotaBody(1, Date.now() + HOUR)),
    });
    const provider = zaiProvider(CODING, fetchImpl);
    await drain(provider, request('glm-5.3'));
    await settle();
    await drain(provider, request('glm-5.3'));
    await settle();
    expect(urls.filter((u) => u.includes('/quota/limit'))).toHaveLength(1);
  });

  it('never reads the plan for the pay-as-you-go endpoint', async () => {
    const { fetchImpl, urls } = router({
      quota: () => new Response(quotaBody(1, Date.now() + HOUR)),
    });
    await drain(zaiProvider('https://api.z.ai/api/paas/v4', fetchImpl, 'zai'), request('glm-5.3'));
    await settle();
    expect(urls.some((u) => u.includes('/api/monitor/'))).toBe(false);
    expect(getProviderQuota('zai')).toEqual([]);
  });
});

describe('business codes', () => {
  it('reads the code from the `[1312]…` bracket prefix when error.code is absent', async () => {
    const { fetchImpl } = router({
      chat: () =>
        new Response(JSON.stringify({ error: { message: '[1312][Service busy][req-1]' } }), {
          status: 500,
        }),
    });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    expect(err.kind).toBe('overloaded');
  });

  it('leaves an unrecognised failure as the wire classified it', async () => {
    const { fetchImpl } = router({ chat: zaiError(400, 'invalid_request', 'bad field') });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    expect(err.kind).toBe('invalid_request');
    expect(err.body?.message).toBe('bad field');
  });

  it('files 1310 as an exhausted plan with the exact reset from the quota read', async () => {
    const reset = Date.now() + 3 * HOUR;
    const { fetchImpl } = router({
      chat: zaiError(
        429,
        '1310',
        'Weekly/Monthly Limit Exhausted. Your limit will reset at 2099-01-01 00:00:00',
      ),
      quota: () => new Response(quotaBody(100, reset)),
    });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    expect(err.kind).toBe('quota_exhausted');
    expect(err.retryable).toBe(false);
    expect(err.body?.retryAfterMs).toBeGreaterThan(3 * HOUR - 5_000);
    expect(err.body?.retryAfterMs).toBeLessThanOrEqual(3 * HOUR);
  });

  it('falls back to the message stamp read in platform time (UTC+8)', async () => {
    // 1 h 30 m ahead in UTC, written as a Beijing wall-clock stamp.
    const at = new Date(Date.now() + 90 * 60_000 + 8 * HOUR);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(
      at.getUTCHours(),
    )}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
    const { fetchImpl } = router({
      chat: zaiError(
        429,
        '1308',
        `Usage limit reached for 5 hour. Your limit will reset at ${stamp}`,
      ),
      quota: () => new Response('{"code":500,"success":false}'),
    });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    expect(err.kind).toBe('quota_exhausted');
    expect(err.body?.retryAfterMs).toBeGreaterThan(89 * 60_000);
    expect(err.body?.retryAfterMs).toBeLessThanOrEqual(90 * 60_000);
  });

  it('keeps transient codes retryable and names overload', async () => {
    const rate = await failure(
      zaiProvider(CODING, router({ chat: zaiError(429, '1302', 'High concurrency') }).fetchImpl),
      request('glm-5.3'),
    );
    expect(rate.kind).toBe('rate_limit');
    expect(rate.retryable).toBe(true);
    const busy = await failure(
      zaiProvider(CODING, router({ chat: zaiError(429, '1312', 'Service busy') }).fetchImpl),
      request('glm-5.3'),
    );
    expect(busy.kind).toBe('overloaded');
  });

  it('points an expired plan at the subscription page', async () => {
    const { fetchImpl } = router({ chat: zaiError(403, '1309', 'Your plan has expired') });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    expect(err.kind).toBe('quota_exhausted');
    expect(err.body?.message).toContain('https://z.ai/manage-apikey/subscription');
  });

  it('lists the plan models when a model is outside the plan', async () => {
    const { fetchImpl } = router({
      chat: () =>
        new Response(
          JSON.stringify({
            error: { code: '1311', message: 'The current plan does not include this model' },
            allowed_models: ['glm-5.3', 'glm-5.3-flash'],
          }),
          { status: 403 },
        ),
    });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5v-turbo'));
    expect(err.body?.message).toContain('this plan includes: glm-5.3, glm-5.3-flash');
  });
});

describe('region-bound keys', () => {
  it('says so when a rejected key belongs to BigModel', async () => {
    const { fetchImpl, urls } = router({
      chat: zaiError(401, '1000', 'Authentication failed'),
      quota: (url) =>
        url.includes('bigmodel.cn')
          ? new Response(quotaBody(1, Date.now() + HOUR))
          : new Response('{"code":401,"success":false}'),
    });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    expect(err.kind).toBe('auth');
    expect(err.body?.message).toContain('belongs to BigModel');
    expect(urls.some((u) => u.startsWith('https://open.bigmodel.cn/api/monitor/'))).toBe(true);
  });

  it('adds nothing when the other region rejects the key too', async () => {
    const { fetchImpl } = router({
      chat: zaiError(401, '1000', 'Authentication failed'),
      quota: () => new Response('{"code":401,"success":false}'),
    });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    expect(err.body?.message).toBe('Authentication failed');
  });
});

describe('reset stamp', () => {
  it('reads the stamp as UTC+8 regardless of the machine zone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
    const { fetchImpl } = router({
      chat: zaiError(
        429,
        '1308',
        'Usage limit reached for 5 hour. Your limit will reset at 2026-09-30 18:21:49',
      ),
      quota: () => new Response('{"code":500,"success":false}'),
    });
    const err = await failure(zaiProvider(CODING, fetchImpl), request('glm-5.3'));
    // 18:21:49 in Beijing is 10:21:49 UTC — 21m49s away, on any machine.
    expect(err.body?.retryAfterMs).toBe(21 * 60_000 + 49_000);
  });
});

describe('Anthropic surface thinking (ZCode contract)', () => {
  async function wireBody(
    model: string,
    reasoning: Request['reasoning'],
  ): Promise<Record<string, unknown>> {
    const { fetchImpl, bodies } = router({});
    const provider = new ZaiMessagesProvider({
      id: 'zai-anthropic',
      apiKey: 'k',
      baseUrl: 'https://api.z.ai/api/anthropic',
      fetchImpl,
    });
    await drain(provider, request(model, { reasoning, temperature: 0.3 }));
    return (bodies[0] ?? {}) as Record<string, unknown>;
  }

  it('GLM-5.3: always thinking, depth via output_config.effort', async () => {
    const cases: Array<[Request['reasoning'], string]> = [
      [{ effort: 'max' }, 'max'],
      [{ effort: 'xhigh' }, 'max'],
      [{ effort: 'high' }, 'high'],
      [{ effort: 'medium' }, 'high'],
      [{ effort: 'low' }, 'low'],
      [{ enabled: false }, 'low'],
      [{ enabled: true }, 'max'],
    ];
    for (const [reasoning, effort] of cases) {
      const body = await wireBody('glm-5.3', reasoning);
      expect(body['thinking']).toEqual({ type: 'enabled' });
      expect(body['output_config']).toEqual({ effort });
    }
  });

  it('GLM-5.2: off, or on with high | max', async () => {
    expect((await wireBody('GLM-5.2', { enabled: false }))['thinking']).toEqual({
      type: 'disabled',
    });
    const on = await wireBody('GLM-5.2', { effort: 'low' });
    expect(on['thinking']).toEqual({ type: 'enabled' });
    expect(on['output_config']).toEqual({ effort: 'high' });
    expect((await wireBody('GLM-5.2', { effort: 'max' }))['output_config']).toEqual({
      effort: 'max',
    });
  });

  it('older GLM: a bare toggle, never budget_tokens, sampling kept', async () => {
    const on = await wireBody('glm-4.7', { effort: 'high' });
    expect(on['thinking']).toEqual({ type: 'enabled' });
    expect(on).not.toHaveProperty('output_config');
    expect(on['temperature']).toBe(0.3);
    expect((await wireBody('glm-5-turbo', { enabled: false }))['thinking']).toEqual({
      type: 'disabled',
    });
    expect(await wireBody('glm-4.7', undefined)).not.toHaveProperty('thinking');
  });
});
