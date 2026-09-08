/**
 * Codex quota reporter — the `x-codex-*` headers and the `codex.rate_limits`
 * SSE event, mapped onto the provider-neutral snapshot shape.
 *
 * The store itself is tested in `packages/core/tests/provider-quota.test.ts`;
 * what belongs here is the wire-format half: which headers exist, how a family
 * is discovered, what "not metered" looks like on this backend, and that the
 * transport actually reports what it sees — including off a 429, whose reset
 * time is the difference between parking a model and re-probing an exhausted
 * plan on a backoff schedule.
 */

import {
  getProviderQuota,
  hasQuotaData,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  resetProviderQuota,
} from '@wrongstack/core/quota';
import type { Request, StreamEvent } from '@wrongstack/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICodexProvider, parseOpenAIResponsesStream } from '../src/openai-codex.js';
import {
  parseCodexRateLimitEvent,
  parseCodexRateLimitHeaders,
} from '../src/openai-codex-rate-limits.js';

afterEach(() => {
  resetProviderQuota();
});

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function windowOf(
  snapshot: ProviderQuotaSnapshot | undefined,
  id: string,
): ProviderQuotaWindow | undefined {
  return snapshot?.windows.find((w) => w.id === id);
}

/** The account-wide meter, which is the one every response carries. */
function codexMeter(): ProviderQuotaSnapshot | undefined {
  return getProviderQuota('openai-codex').find((s) => s.meterId === 'codex');
}

function sseBody(events: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    pull(c) {
      c.enqueue(enc.encode(events));
      c.close();
    },
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('parseCodexRateLimitHeaders', () => {
  it('reads the account-wide family with both windows', () => {
    const [snapshot] = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '12.5',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '1704069000',
        'x-codex-secondary-used-percent': '80',
        'x-codex-secondary-window-minutes': '10080',
      }),
      1_000,
    );
    expect(snapshot?.providerId).toBe('openai-codex');
    expect(snapshot?.meterId).toBe('codex');
    expect(windowOf(snapshot, 'primary')).toEqual({
      id: 'primary',
      usedPercent: 12.5,
      windowMinutes: 300,
      resetsAt: 1704069000,
    });
    expect(windowOf(snapshot, 'secondary')).toEqual({
      id: 'secondary',
      usedPercent: 80,
      windowMinutes: 10080,
    });
    expect(snapshot?.capturedAt).toBe(1_000);
  });

  it('treats an all-zero window as unmetered rather than 0% used', () => {
    const [snapshot] = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '0',
        'x-codex-primary-window-minutes': '0',
      }),
    );
    expect(snapshot?.windows).toEqual([]);
    expect(hasQuotaData(snapshot!)).toBe(false);
  });

  it('keeps a real zero-percent window when it carries a reset time', () => {
    const [snapshot] = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '0',
        'x-codex-primary-reset-at': '1704069000',
      }),
    );
    expect(windowOf(snapshot, 'primary')?.usedPercent).toBe(0);
  });

  it('falls back to reset-after-seconds when reset-at comes back empty', () => {
    // Observed live on a `pro` account: the backend filled in
    // `x-codex-secondary-reset-after-seconds` and left
    // `x-codex-secondary-reset-at` as an empty string.
    const [snapshot] = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': '',
        'x-codex-primary-reset-after-seconds': '1800',
      }),
      1_000_000,
    );
    expect(windowOf(snapshot, 'primary')?.resetsAt).toBe(1_000 + 1_800);
  });

  it('prefers the absolute reset when the backend sends both', () => {
    const [snapshot] = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-reset-at': '1704069000',
        'x-codex-primary-reset-after-seconds': '1800',
      }),
      1_000_000,
    );
    expect(windowOf(snapshot, 'primary')?.resetsAt).toBe(1704069000);
  });

  it('reads the live plan tier off the header rather than the token claim', () => {
    const [snapshot] = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '2',
        'x-codex-plan-type': 'pro',
      }),
    );
    expect(snapshot?.planLabel).toBe('pro');
  });

  it('discovers additional metered families from their header prefix', () => {
    const snapshots = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '12.5',
        'x-codex-secondary-primary-used-percent': '80',
        'x-codex-secondary-limit-name': 'gpt-5.2-codex-sonic',
      }),
    );
    expect(snapshots.map((s) => s.meterId)).toEqual(['codex', 'codex_secondary']);
    expect(snapshots[1]?.meterLabel).toBe('gpt-5.2-codex-sonic');
    expect(windowOf(snapshots[1], 'primary')?.usedPercent).toBe(80);
  });

  it('reads credits, note, and the reached window alongside the windows', () => {
    const [snapshot] = parseCodexRateLimitHeaders(
      headers({
        'x-codex-primary-used-percent': '100',
        'x-codex-credits-has-credits': 'true',
        'x-codex-credits-unlimited': 'false',
        'x-codex-credits-balance': '12.40',
        'x-codex-rate-limit-reached-type': 'primary',
        'x-codex-promo-message': 'Upgrade for more',
      }),
    );
    expect(snapshot?.credits).toEqual({ hasCredits: true, unlimited: false, balance: '12.40' });
    expect(snapshot?.reachedWindowId).toBe('primary');
    expect(snapshot?.note).toBe('Upgrade for more');
  });

  it('returns nothing for absent headers', () => {
    expect(parseCodexRateLimitHeaders(undefined)).toEqual([]);
    const [snapshot] = parseCodexRateLimitHeaders(headers({}));
    expect(hasQuotaData(snapshot!)).toBe(false);
  });
});

describe('parseCodexRateLimitEvent', () => {
  it('maps the SSE shape onto the same snapshot as the headers', () => {
    const snapshot = parseCodexRateLimitEvent(
      {
        type: 'codex.rate_limits',
        plan_type: 'pro',
        rate_limits: {
          primary: { used_percent: 42, window_minutes: 300, reset_at: 1704069000 },
          secondary: { used_percent: 7 },
        },
        credits: { has_credits: true, unlimited: false, balance: '3.00' },
      },
      2_000,
    );
    expect(snapshot?.meterId).toBe('codex');
    expect(snapshot?.planLabel).toBe('pro');
    expect(windowOf(snapshot ?? undefined, 'primary')).toEqual({
      id: 'primary',
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: 1704069000,
    });
    expect(windowOf(snapshot ?? undefined, 'secondary')).toEqual({
      id: 'secondary',
      usedPercent: 7,
    });
    expect(snapshot?.credits?.balance).toBe('3.00');
    expect(snapshot?.capturedAt).toBe(2_000);
  });

  it('ignores every other event type', () => {
    expect(parseCodexRateLimitEvent({ type: 'response.completed' })).toBeNull();
    expect(parseCodexRateLimitEvent(null)).toBeNull();
  });
});

describe('the Codex transport records what it observes', () => {
  const req: Request = {
    model: 'gpt-5-codex',
    messages: [{ role: 'user', content: 'hi' }],
    cache: { sessionId: 'sess-quota' },
  };

  function fetchWith(responseHeaders: Record<string, string>): typeof fetch {
    return (async () =>
      new Response(sseBody('data: {"type":"response.completed","response":{}}\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...responseHeaders },
      })) as never as typeof fetch;
  }

  it('records the quota headers of a successful response', async () => {
    const provider = new OpenAICodexProvider({
      id: 'openai-codex',
      credentials: { accessToken: 'tok' },
      fetchImpl: fetchWith({
        'x-codex-primary-used-percent': '64',
        'x-codex-primary-window-minutes': '300',
      }),
    });
    await collect(provider.stream(req, { signal: new AbortController().signal }));
    expect(windowOf(codexMeter(), 'primary')).toEqual({
      id: 'primary',
      usedPercent: 64,
      windowMinutes: 300,
    });
  });

  it('records the quota restated as an SSE event', async () => {
    const events =
      'data: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":91}}}\n\n' +
      'data: {"type":"response.completed","response":{}}\n\n';
    await collect(parseOpenAIResponsesStream(sseBody(events), 'gpt-5-codex', 'openai-codex'));
    expect(windowOf(codexMeter(), 'primary')?.usedPercent).toBe(91);
  });
});

describe('a 429 parks the model until the published reset', () => {
  async function errorFrom(
    status: number,
    responseHeaders: Record<string, string>,
  ): Promise<{ body?: { retryAfterMs?: number } } | null> {
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: 'tok' },
      fetchImpl: (async () =>
        new Response('{"error":{"message":"Usage limit reached."}}', {
          status,
          headers: responseHeaders,
        })) as never as typeof fetch,
    });
    const req: Request = { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'hi' }] };
    return collect(provider.stream(req, { signal: new AbortController().signal })).then(
      () => null,
      (e: unknown) => e as { body?: { retryAfterMs?: number } },
    );
  }

  it('turns the exhausted window’s reset-at into an exact retry hint', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 4 * 3600;
    const err = await errorFrom(429, {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(resetAt),
      'x-codex-rate-limit-reached-type': 'primary',
    });
    expect(err?.body?.retryAfterMs).toBeGreaterThan(3.9 * 3_600_000);
    expect(err?.body?.retryAfterMs).toBeLessThanOrEqual(4 * 3_600_000);
    // The 429's own headers are still a quota reading worth keeping.
    expect(codexMeter()?.reachedWindowId).toBe('primary');
  });

  it('never parks on a window that still has room', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 4 * 3600;
    const err = await errorFrom(500, {
      'x-codex-primary-used-percent': '40',
      'x-codex-primary-reset-at': String(resetAt),
    });
    expect(err?.body?.retryAfterMs).toBeUndefined();
  });
});
