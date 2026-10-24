/**
 * Anthropic quota reporter — the `anthropic-ratelimit-unified-*` headers
 * mapped onto the provider-neutral snapshot shape.
 *
 * The store is tested in `packages/core/tests/provider-quota.test.ts`; what
 * belongs here is the wire half: the fraction-vs-percent reading, why the
 * per-minute throughput buckets must stay out of the plan store, and the
 * condition under which `-representative-claim` counts as "you are cut off"
 * rather than "this is the window that would bite first".
 */

import type { Request } from '@wrongstack/contracts/types';
import {
  getProviderQuota,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  reachedQuotaWindow,
  resetProviderQuota,
  worstProviderQuotaWindow,
} from '@wrongstack/core/quota';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';
import { parseAnthropicRateLimitHeaders } from '../src/anthropic-rate-limits.js';

afterEach(() => {
  resetProviderQuota();
});

const PREFIX = 'anthropic-ratelimit-unified';

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

function windowOf(
  snapshot: ProviderQuotaSnapshot | undefined,
  id: string,
): ProviderQuotaWindow | undefined {
  return snapshot?.windows.find((w) => w.id === id);
}

describe('parseAnthropicRateLimitHeaders', () => {
  it('reads both rolling windows off one response', () => {
    const now = 1_700_000_000_000;
    const [snapshot] = parseAnthropicRateLimitHeaders(
      'anthropic-oauth',
      headers({
        [`${PREFIX}-5h-utilization`]: '0.42',
        [`${PREFIX}-5h-reset`]: '1700001800',
        [`${PREFIX}-7d-utilization`]: '0.08',
        [`${PREFIX}-7d-reset`]: '1700500000',
      }),
      now,
    );
    expect(snapshot?.meterId).toBe('claude');
    expect(snapshot?.providerId).toBe('anthropic-oauth');
    expect(snapshot?.capturedAt).toBe(now);
    expect(windowOf(snapshot, '5h')).toMatchObject({
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: 1_700_001_800,
      label: '5h',
    });
    expect(windowOf(snapshot, '7d')).toMatchObject({
      usedPercent: 8,
      windowMinutes: 10_080,
      resetsAt: 1_700_500_000,
    });
  });

  it('records under the caller id so two accounts never merge', () => {
    // The same transport serves the first-party login and any configured
    // Anthropic-compatible provider. A constant provider id here would blend
    // two subscriptions' burn into one bar.
    const [first] = parseAnthropicRateLimitHeaders(
      'anthropic-oauth',
      headers({ [`${PREFIX}-5h-utilization`]: '0.9' }),
    );
    const [second] = parseAnthropicRateLimitHeaders(
      'claude-work',
      headers({ [`${PREFIX}-5h-utilization`]: '0.1' }),
    );
    expect(first?.providerId).toBe('anthropic-oauth');
    expect(second?.providerId).toBe('claude-work');
  });

  it('treats a value above 1 as an already-scaled percentage', () => {
    // The family is undocumented. If the backend ever switches to whole
    // percents, reading 40 as 0.4% would under-report a nearly-spent plan as
    // essentially untouched — the worse of the two failure directions.
    const [snapshot] = parseAnthropicRateLimitHeaders(
      'anthropic-oauth',
      headers({ [`${PREFIX}-5h-utilization`]: '40' }),
    );
    expect(windowOf(snapshot, '5h')?.usedPercent).toBe(40);
  });

  it('clamps a utilization above full', () => {
    const [snapshot] = parseAnthropicRateLimitHeaders(
      'anthropic-oauth',
      headers({ [`${PREFIX}-5h-utilization`]: '104' }),
    );
    expect(windowOf(snapshot, '5h')?.usedPercent).toBe(100);
  });

  it('reports a fresh plan as 0% rather than as no reading', () => {
    // A zero here is a real measurement, unlike the Codex family where a bare
    // zero means "not metered". The window is named by the header, so its
    // presence is the signal.
    const [snapshot] = parseAnthropicRateLimitHeaders(
      'anthropic-oauth',
      headers({ [`${PREFIX}-5h-utilization`]: '0', [`${PREFIX}-5h-reset`]: '1700001800' }),
    );
    expect(windowOf(snapshot, '5h')?.usedPercent).toBe(0);
  });

  it('omits a reset it cannot trust', () => {
    const [snapshot] = parseAnthropicRateLimitHeaders(
      'anthropic-oauth',
      headers({ [`${PREFIX}-5h-utilization`]: '0.5', [`${PREFIX}-5h-reset`]: '0' }),
    );
    expect(windowOf(snapshot, '5h')?.resetsAt).toBeUndefined();
  });

  it('returns nothing when the response carries no quota channel', () => {
    expect(parseAnthropicRateLimitHeaders('anthropic', headers({}))).toEqual([]);
    expect(parseAnthropicRateLimitHeaders('anthropic', undefined)).toEqual([]);
  });

  it('ignores the per-minute throughput buckets', () => {
    // These are the API-key tier's per-minute allowance: they refill every
    // minute and a burst that takes one to 95% is normal. Letting them into
    // the plan store would hand `worstProviderQuotaWindow()` a 95% window and
    // paint "your subscription is nearly gone" over ordinary traffic.
    const snapshots = parseAnthropicRateLimitHeaders(
      'anthropic',
      headers({
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-requests-remaining': '50',
        'anthropic-ratelimit-tokens-limit': '80000',
        'anthropic-ratelimit-tokens-remaining': '4000',
        'anthropic-ratelimit-input-tokens-remaining': '2000',
        'anthropic-ratelimit-output-tokens-remaining': '2000',
        'retry-after': '30',
      }),
    );
    expect(snapshots).toEqual([]);
  });

  describe('reached window', () => {
    it('does not call an idle plan exhausted just because a claim names it', () => {
      // `-representative-claim` names the binding window whether or not
      // anything is exhausted. Trusting it alone turns the chip red at 0%.
      const [snapshot] = parseAnthropicRateLimitHeaders(
        'anthropic-oauth',
        headers({
          [`${PREFIX}-5h-utilization`]: '0.01',
          [`${PREFIX}-5h-status`]: 'allowed',
          [`${PREFIX}-status`]: 'allowed',
          [`${PREFIX}-representative-claim`]: '5h',
        }),
      );
      expect(snapshot?.reachedWindowId).toBeUndefined();
    });

    it('names the claimed window once a status says it is cut off', () => {
      const [snapshot] = parseAnthropicRateLimitHeaders(
        'anthropic-oauth',
        headers({
          [`${PREFIX}-5h-utilization`]: '1',
          [`${PREFIX}-5h-status`]: 'rejected',
          [`${PREFIX}-7d-utilization`]: '0.5',
          [`${PREFIX}-7d-status`]: 'allowed',
          [`${PREFIX}-status`]: 'rejected',
          [`${PREFIX}-representative-claim`]: '5h',
        }),
      );
      expect(snapshot?.reachedWindowId).toBe('5h');
      // The id has to resolve against the snapshot's own windows, or the
      // surfaces that look the window up get nothing to render.
      expect(snapshot && reachedQuotaWindow(snapshot)?.usedPercent).toBe(100);
    });

    it('falls back to the exhausted window when the claim is unrecognized', () => {
      const [snapshot] = parseAnthropicRateLimitHeaders(
        'anthropic-oauth',
        headers({
          [`${PREFIX}-5h-utilization`]: '0.3',
          [`${PREFIX}-5h-status`]: 'allowed',
          [`${PREFIX}-7d-utilization`]: '1',
          [`${PREFIX}-7d-status`]: 'exceeded',
          [`${PREFIX}-representative-claim`]: 'some_future_window',
        }),
      );
      expect(snapshot?.reachedWindowId).toBe('7d');
    });

    it('treats a warning status as still allowed', () => {
      const [snapshot] = parseAnthropicRateLimitHeaders(
        'anthropic-oauth',
        headers({
          [`${PREFIX}-5h-utilization`]: '0.85',
          [`${PREFIX}-5h-status`]: 'allowed_warning',
          [`${PREFIX}-status`]: 'allowed_warning',
          [`${PREFIX}-representative-claim`]: '5h',
        }),
      );
      expect(snapshot?.reachedWindowId).toBeUndefined();
    });

    it('reports an exhausted account even with no per-window utilization', () => {
      // A 429 can arrive with the statuses filled in and the utilization
      // headers dropped. "Cut off, window unknown" still has to survive the
      // trip, or the reading reads as "no data" exactly when it matters.
      const [snapshot] = parseAnthropicRateLimitHeaders(
        'anthropic-oauth',
        headers({
          [`${PREFIX}-status`]: 'rejected',
          [`${PREFIX}-7d-status`]: 'rejected',
        }),
      );
      expect(snapshot?.windows).toEqual([]);
      expect(snapshot?.reachedWindowId).toBe('7d');
    });
  });

  it('feeds the shared worst-window selector', () => {
    const [snapshot] = parseAnthropicRateLimitHeaders(
      'anthropic-oauth',
      headers({
        [`${PREFIX}-5h-utilization`]: '0.93',
        [`${PREFIX}-5h-reset`]: '1700001800',
        [`${PREFIX}-7d-utilization`]: '0.20',
      }),
    );
    const worst = worstProviderQuotaWindow(snapshot ? [snapshot] : []);
    expect(worst?.window.id).toBe('5h');
    expect(worst?.window.usedPercent).toBeCloseTo(93);
  });
});

// ── Transport wiring ────────────────────────────────────────────────────────

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":5,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

function streamingFetch(responseHeaders: Record<string, string>): typeof fetch {
  const enc = new TextEncoder();
  return (async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(enc.encode(SSE));
          c.close();
        },
      }),
      { status: 200, headers: responseHeaders },
    )) as never as typeof fetch;
}

const req: Request = {
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 64,
};

describe('Anthropic transports report quota', () => {
  const quotaHeaders = {
    [PREFIX + '-5h-utilization']: '0.55',
    [PREFIX + '-5h-reset']: '1700001800',
    [PREFIX + '-7d-utilization']: '0.12',
  };

  it('records a plan-window reading when the response carries one', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-key',
      fetchImpl: streamingFetch(quotaHeaders),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    const [snapshot] = getProviderQuota('anthropic');
    expect(windowOf(snapshot, '5h')?.usedPercent).toBeCloseTo(55);
    expect(windowOf(snapshot, '7d')?.usedPercent).toBeCloseTo(12);
  });

  it('records under a custom provider id', async () => {
    const provider = new AnthropicProvider({
      id: 'claude-work',
      apiKey: 'sk-ant-key',
      fetchImpl: streamingFetch(quotaHeaders),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    expect(getProviderQuota('claude-work')).toHaveLength(1);
    expect(getProviderQuota('anthropic')).toEqual([]);
  });

  it('records nothing for an API-key account that reports no plan window', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-key',
      fetchImpl: streamingFetch({ 'anthropic-ratelimit-requests-remaining': '10' }),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    expect(getProviderQuota('anthropic')).toEqual([]);
  });

  it('reads the plan window when an API key is on a metered gateway', async () => {
    // The API-key transport serves Anthropic-compatible proxies too, and some
    // of those are subscription-backed; the family is read wherever it arrives.
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-key',
      fetchImpl: streamingFetch(quotaHeaders),
    });
    await provider.complete(req, { signal: new AbortController().signal });
    expect(windowOf(getProviderQuota('anthropic')[0], '5h')?.usedPercent).toBeCloseTo(55);
  });
});
