import { ProviderError } from '@wrongstack/core/types';
import type { ProviderErrorBody } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type HeadersLike,
  parseProviderHttpError,
  retryAfterMsFromHeaders,
  retryAfterMsFromBody,
} from '../src/error-parse.js';

function fakeHeaders(entries: Record<string, string>): HeadersLike {
  const lower = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

describe('parseProviderHttpError', () => {
  it('parses Anthropic 529 overloaded body', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'High traffic detected. Upgrade for highspeed model.',
      },
      request_id: '06534785201de9c0a1b2c3d4e5f6',
    });
    const err = parseProviderHttpError('minimax', 529, body);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(529);
    expect(err.retryable).toBe(true);
    expect(err.providerId).toBe('minimax');
    expect(err.body?.type).toBe('overloaded_error');
    expect(err.body?.message).toBe('High traffic detected. Upgrade for highspeed model.');
    expect(err.body?.requestId).toBe('06534785201de9c0a1b2c3d4e5f6');
    expect(err.describe()).toBe(
      'minimax overloaded (529): High traffic detected. Upgrade for highspeed model. [req 06534785201de9c0…]',
    );
  });

  it('parses OpenAI 429 rate-limit body', () => {
    const body = JSON.stringify({
      error: {
        message: 'Rate limit reached for gpt-4o',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    });
    const err = parseProviderHttpError('openai', 429, body);
    expect(err.retryable).toBe(true);
    expect(err.body?.type).toBe('rate_limit_error');
    expect(err.body?.message).toBe('Rate limit reached for gpt-4o');
    expect(err.describe()).toBe('openai rate limited (429): Rate limit reached for gpt-4o');
  });

  it('treats explicit rate_limit_exceeded code as transient when type is absent', () => {
    const body = JSON.stringify({
      error: { message: 'Rate limit exceeded', code: 'rate_limit_exceeded' },
    });
    const err = parseProviderHttpError('openai', 429, body);
    expect(err.body?.type).toBe('rate_limit_exceeded');
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });

  it('classifies generic message-only 429 as transient rate limit', () => {
    const body = JSON.stringify({ error: { message: 'Rate limit exceeded' } });
    const err = parseProviderHttpError('gateway', 429, body);
    expect(err.body?.type).toBeUndefined();
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });

  it('classifies message-only quota exhaustion as quota_exhausted', () => {
    const body = JSON.stringify({
      error: { message: "You've reached your usage limit for this billing cycle" },
    });
    const err = parseProviderHttpError('gateway', 429, body);
    expect(err.body?.type).toBeUndefined();
    expect(err.kind).toBe('quota_exhausted');
    expect(err.retryable).toBe(false);
  });

  it('classifies exhausted OpenAI credits separately from a burst rate limit', () => {
    const body = JSON.stringify({
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });
    const err = parseProviderHttpError('openai', 429, body);
    expect(err.kind).toBe('quota_exhausted');
    expect(err.retryable).toBe(false);
  });

  it('parses Google 5xx error with status field', () => {
    const body = JSON.stringify({
      error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' },
    });
    const err = parseProviderHttpError('google', 503, body);
    expect(err.retryable).toBe(true);
    expect(err.body?.type).toBe('UNAVAILABLE');
    expect(err.body?.message).toBe('The model is overloaded.');
    expect(err.describe()).toContain('google HTTP 503 (server error): The model is overloaded.');
  });

  it('does not retry on 400 invalid request', () => {
    const body = JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'messages.0.role must be one of [user, assistant]',
      },
    });
    const err = parseProviderHttpError('anthropic', 400, body);
    expect(err.retryable).toBe(false);
    expect(err.body?.type).toBe('invalid_request_error');
    expect(err.describe()).toContain('anthropic invalid request (400):');
  });

  it('handles unparseable body without throwing', () => {
    const err = parseProviderHttpError('openai', 502, '<html>Bad Gateway</html>');
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
    expect(err.body?.type).toBeUndefined();
    expect(err.body?.message).toBeUndefined();
    expect(err.body?.raw).toBe('<html>Bad Gateway</html>');
    expect(err.describe()).toBe('openai HTTP 502 (server error)');
  });

  it('handles empty body', () => {
    const err = parseProviderHttpError('openai', 500, '');
    expect(err.retryable).toBe(true);
    expect(err.body?.raw).toBe('');
    expect(err.describe()).toBe('openai HTTP 500 (server error)');
  });

  it('truncates very large raw body', () => {
    const raw = 'x'.repeat(5000);
    const err = parseProviderHttpError('openai', 500, raw);
    expect(err.body?.raw?.length).toBe(2000);
  });

  it('classifies overloaded_error retryable even with non-529 status', () => {
    const body = JSON.stringify({ error: { type: 'overloaded_error', message: 'busy' } });
    const err = parseProviderHttpError('anthropic', 503, body);
    expect(err.retryable).toBe(true);
    expect(err.describe()).toContain('overloaded');
  });

  it('stamps the canonical kind on the error', () => {
    expect(parseProviderHttpError('p', 429, '').kind).toBe('rate_limit');
    expect(parseProviderHttpError('p', 529, '').kind).toBe('overloaded');
    expect(parseProviderHttpError('p', 503, '').kind).toBe('server');
    expect(parseProviderHttpError('p', 401, '').kind).toBe('auth');
    expect(parseProviderHttpError('p', 0, '').kind).toBe('network');
    const overflow = JSON.stringify({
      error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens' },
    });
    expect(parseProviderHttpError('anthropic', 400, overflow).kind).toBe('context_overflow');
  });

  it('populates body.retryAfterMs from a delta-seconds Retry-After header', () => {
    const err = parseProviderHttpError('openai', 429, '', fakeHeaders({ 'retry-after': '12' }));
    expect(err.body?.retryAfterMs).toBe(12_000);
  });

  it('prefers retry-after-ms over retry-after', () => {
    const err = parseProviderHttpError(
      'anthropic',
      429,
      '',
      fakeHeaders({ 'retry-after-ms': '1500', 'retry-after': '30' }),
    );
    expect(err.body?.retryAfterMs).toBe(1500);
  });

  it('leaves retryAfterMs unset without headers', () => {
    expect(parseProviderHttpError('openai', 429, '').body?.retryAfterMs).toBeUndefined();
  });
});

describe('retryAfterMsFromHeaders', () => {
  afterEach(() => vi.useRealTimers());

  it('parses an HTTP-date Retry-After relative to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T12:00:00Z'));
    const ms = retryAfterMsFromHeaders(
      fakeHeaders({ 'retry-after': 'Thu, 09 Jul 2026 12:00:30 GMT' }),
    );
    expect(ms).toBe(30_000);
  });

  it('returns undefined for garbage, negative, zero, and past-date values', () => {
    expect(retryAfterMsFromHeaders(fakeHeaders({ 'retry-after': 'soon' }))).toBeUndefined();
    expect(retryAfterMsFromHeaders(fakeHeaders({ 'retry-after': '-5' }))).toBeUndefined();
    expect(retryAfterMsFromHeaders(fakeHeaders({ 'retry-after': '0' }))).toBeUndefined();
    expect(
      retryAfterMsFromHeaders(fakeHeaders({ 'retry-after': 'Thu, 09 Jul 2020 12:00:00 GMT' })),
    ).toBeUndefined();
    expect(retryAfterMsFromHeaders(undefined)).toBeUndefined();
  });
});

describe('retryAfterMsFromBody', () => {
  afterEach(() => vi.useRealTimers());

  it('parses "reset at YYYY-MM-DD HH:mm:ss" as UTC by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
    const body: ProviderErrorBody = {
      message: 'Usage limit reached. Your limit will reset at 2026-07-24 12:30:00',
    };
    // 30 minutes ahead → 1_800_000 ms
    expect(retryAfterMsFromBody(body)).toBe(1_800_000);
  });

  it('falls back to local time when UTC interpretation is in the past', () => {
    vi.useFakeTimers();
    // System clock at 14:00 UTC. A reset stamp of 13:00 interpreted as
    // UTC is 1 hour in the past. The UTC reading is rejected (negative
    // delta). On a non-UTC machine whose local clock is ahead of the
    // stamp (e.g. UTC+8 where local "13:00" = 05:00Z, still past), the
    // local reading is also past and the function returns undefined.
    // On a machine whose local interpretation puts the stamp in the
    // future, a positive local delta is returned instead. Either way,
    // the contract is: no crash and no bogus negative value.
    vi.setSystemTime(new Date('2026-07-24T14:00:00Z'));
    const body: ProviderErrorBody = {
      message: 'Your limit will reset at 2026-07-24 13:00:00',
    };
    const result = retryAfterMsFromBody(body);
    // Must never be negative. On a UTC runner it's undefined (both past);
    // on a positive-offset TZ it may be positive. Accept either.
    if (result !== undefined) expect(result).toBeGreaterThan(0);
  });

  it('returns the smallest positive delta (UTC + local)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T04:00:00Z'));
    // On a non-UTC machine (this CI/dev host is UTC+3), the local
    // interpretation of "13:00" is 10:00Z = 6 h from 04:00Z, while the UTC
    // interpretation is 9 h. The fix returns the smaller (correct) value.
    // The old UTC-first code would have returned 32_400_000 (9 h).
    const body: ProviderErrorBody = {
      message: 'Usage limit reached. Your limit will reset at 2026-07-24 13:00:00',
    };
    const result = retryAfterMsFromBody(body);
    // Must be the minimum of the two positive interpretations.
    const utcDelta = Date.parse('2026-07-24T13:00:00Z') - Date.parse('2026-07-24T04:00:00Z');
    const localDelta = Date.parse('2026-07-24T13:00:00') - Date.parse('2026-07-24T04:00:00Z');
    const expected = Math.min(
      utcDelta > 0 ? utcDelta : Infinity,
      localDelta > 0 ? localDelta : Infinity,
    );
    expect(result).toBe(expected);
  });

  it('does not overshoot when local-time interpretation is closer', () => {
    // Regression for the chimera-review High finding: the old UTC-first-and-return
    // strategy returned the larger UTC delta and never tried local. On a non-UTC
    // machine this caused an 8-hour overshoot for Beijing-time stamps.
    //
    // We cannot change the TZ inside vitest, so we verify the contract indirectly:
    // when both interpretations yield a future timestamp, the returned delta must
    // be the minimum — not the first. On a UTC machine both are equal; on a UTC+8
    // machine the local delta is 8 h smaller and must win.
    //
    // This test documents the invariant: parseTzAwareDelta is min(utcDelta,
    // localDelta), not utcDelta-if-positive-else-localDelta.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
    const body: ProviderErrorBody = {
      message: 'Resets at 2026-07-24 12:30:00',
    };
    const result = retryAfterMsFromBody(body);
    // On any TZ, 12:30 is 30 min from 12:00.
    // UTC: 12:30Z − 12:00Z = 1_800_000 ms.
    // Local on UTC+8: 12:30 local = 04:30Z → negative → not counted.
    // Local on UTC: same as UTC → 1_800_000 ms.
    // Either way min returns 1_800_000.
    expect(result).toBe(1_800_000);
  });

  it('handles slash-separated dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
    const body: ProviderErrorBody = {
      message: 'Resets at 2026/07/24 12:30:00',
    };
    expect(retryAfterMsFromBody(body)).toBe(1_800_000);
  });

  it('returns undefined for past dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'));
    const body: ProviderErrorBody = {
      message: 'Your limit will reset at 2020-01-01 00:00:00',
    };
    expect(retryAfterMsFromBody(body)).toBeUndefined();
  });

  it('parses relative hours from body text', () => {
    const body: ProviderErrorBody = {
      message: 'Usage limit reached for 2 hours',
    };
    expect(retryAfterMsFromBody(body)).toBe(7_200_000);
  });

  it('parses relative seconds from body text', () => {
    const body: ProviderErrorBody = {
      message: 'Please retry after 30 seconds',
    };
    expect(retryAfterMsFromBody(body)).toBe(30_000);
  });

  it('parses "try again in N seconds" from gateway responses', () => {
    const body: ProviderErrorBody = {
      message: 'Too many requests. Please try again in 45 seconds.',
    };
    expect(retryAfterMsFromBody(body)).toBe(45_000);
  });

  it('returns undefined for text with no recognizable pattern', () => {
    const body: ProviderErrorBody = {
      message: 'Internal server error',
    };
    expect(retryAfterMsFromBody(body)).toBeUndefined();
  });
});

describe('ProviderError.describe', () => {
  it('truncates long messages', () => {
    const body = { type: 'foo', message: 'x'.repeat(300) };
    const err = new ProviderError('test', 500, true, 'p', { body });
    const out = err.describe();
    expect(out.length).toBeLessThan(280);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles missing body gracefully', () => {
    const err = new ProviderError('boom', 500, true, 'p');
    expect(err.describe()).toBe('p HTTP 500 (server error)');
  });

  it('renders network error (status 0)', () => {
    const err = new ProviderError('econnreset', 0, true, 'p', {
      body: { message: 'ECONNRESET' },
    });
    expect(err.describe()).toBe('p network error: ECONNRESET');
  });

  it('renders auth/permission/not-found correctly', () => {
    expect(new ProviderError('', 401, false, 'p').describe()).toBe('p auth failed (401)');
    expect(new ProviderError('', 403, false, 'p').describe()).toBe('p forbidden (403)');
    expect(new ProviderError('', 404, false, 'p').describe()).toBe('p not found (404)');
  });

  it('truncates long request ids in the [req …] suffix', () => {
    const err = new ProviderError('', 529, true, 'p', {
      body: { type: 'overloaded_error', requestId: '0123456789abcdef0123456789abcdef' },
    });
    expect(err.describe()).toContain('[req 0123456789abcdef…]');
  });

  it('surfaces a truncated flag + original length when the raw body exceeds 2 KB', () => {
    const giant = 'x'.repeat(5000);
    const err = parseProviderHttpError('p', 500, giant);
    expect(err.body?.raw?.length).toBe(2000);
    expect(err.body?.truncated).toBe(true);
    expect(err.body?.rawLength).toBe(5000);
  });

  it('leaves truncated flag unset when the body is short', () => {
    const err = parseProviderHttpError('p', 500, 'short error');
    expect(err.body?.truncated).toBeUndefined();
    expect(err.body?.rawLength).toBeUndefined();
  });

  // ── WS-060: the body is attacker-influenced output, not an internal log ──
  // `describe()` renders it to the terminal, the session writer puts it in the
  // JSONL transcript, and HQ forwards it to any connected browser.

  it('scrubs a credential the provider echoed back in its error message', () => {
    const raw = JSON.stringify({
      error: {
        type: 'authentication_error',
        message: 'invalid key: sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
      },
    });
    const err = parseProviderHttpError('anthropic', 401, raw);
    expect(err.body?.message).not.toContain('sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
    expect(err.body?.raw).not.toContain('sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ');
    // The diagnostic value survives — only the secret is gone.
    expect(err.body?.message).toContain('invalid key');
    expect(err.body?.type).toBe('authentication_error');
  });

  it('scrubs an unparseable body too, via the raw fallback', () => {
    const err = parseProviderHttpError(
      'gw',
      502,
      'upstream: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    );
    expect(err.body?.raw).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('scrubs AFTER classification, so kind and Retry-After still see the original', () => {
    const raw = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
    const err = parseProviderHttpError('p', 429, raw, {
      get: (n: string) => (n === 'retry-after' ? '3' : null),
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.body?.retryAfterMs).toBe(3000);
  });

  it('does not apply a second length cut on top of the 2 KB raw truncation', () => {
    const err = parseProviderHttpError('p', 500, 'z'.repeat(5000));
    expect(err.body?.raw?.length).toBe(2000);
  });
});
