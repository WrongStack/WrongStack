import { describe, expect, it } from 'vitest';
import { DefaultRetryPolicy, MODEL_RETRIES } from '../../src/execution/retry-policy.js';
import { ProviderError } from '../../src/types/provider.js';

describe('DefaultRetryPolicy', () => {
  const p = new DefaultRetryPolicy();
  // Every recoverable kind gets the SAME budget, so "how long until another
  // model is tried?" no longer depends on which error came back. 429 used to
  // get 5 — each retry honouring a Retry-After of up to 60s — before the
  // cross-model fallback engine, which runs only after retries are exhausted,
  // was reached at all.
  it('429 retries MODEL_RETRIES times, like every other recoverable kind', () => {
    const err = new ProviderError('rate limited', 429, true, 'anthropic');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, MODEL_RETRIES - 1)).toBe(true);
    expect(p.shouldRetry(err, MODEL_RETRIES)).toBe(false);
  });

  it('gives every recoverable kind the same budget', () => {
    for (const [message, status] of [
      ['rate limited', 429],
      ['overloaded', 529],
      ['server', 503],
    ] as const) {
      expect(p.maxAttempts(new ProviderError(message, status, true, 'x'))).toBe(MODEL_RETRIES);
    }
  });

  it('never replays a depleted quota against the same model', () => {
    // quota_exhausted IS fallback-worthy: skipping the in-place retries hands
    // the error straight to the chain instead of delaying the hop.
    const err = new ProviderError('credit balance too low', 402, false, 'x');
    expect(err.kind).toBe('quota_exhausted');
    expect(p.maxAttempts(err)).toBe(0);
    expect(p.shouldRetry(err, 0)).toBe(false);
  });
  it('5xx retries up to 3', () => {
    const err = new ProviderError('server', 503, true, 'x');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, 2)).toBe(true);
    expect(p.shouldRetry(err, 3)).toBe(false);
  });
  it('4xx does not retry', () => {
    const err = new ProviderError('auth', 401, false, 'x');
    expect(p.shouldRetry(err, 0)).toBe(false);
  });
  it('network errors retry up to 2', () => {
    const err = new Error('ECONNRESET');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, 2)).toBe(false);
  });
  it('delayMs respects 30s cap with jitter', () => {
    for (let i = 0; i < 10; i++) {
      const d = p.delayMs(10);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it('529 retries up to 3 attempts', () => {
    const err = new ProviderError('overloaded', 529, true, 'x');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, 2)).toBe(true);
    expect(p.shouldRetry(err, 3)).toBe(false);
  });

  it('non-retryable ProviderError exits immediately', () => {
    const err = new ProviderError('bad', 503, false, 'x');
    expect(p.shouldRetry(err, 0)).toBe(false);
  });

  it('generic Error does not retry', () => {
    expect(p.shouldRetry(new Error('mystery'), 0)).toBe(false);
  });

  it('maxAttempts returns expected counts', () => {
    expect(p.maxAttempts(new ProviderError('', 429, true, 'x'))).toBe(MODEL_RETRIES);
    expect(p.maxAttempts(new ProviderError('', 529, true, 'x'))).toBe(MODEL_RETRIES);
    expect(p.maxAttempts(new ProviderError('', 503, true, 'x'))).toBe(MODEL_RETRIES);
    expect(p.maxAttempts(new ProviderError('', 400, true, 'x'))).toBe(0);
    expect(p.maxAttempts(new Error('x'))).toBe(2);
  });

  it('delayMs grows with attempt index on average', () => {
    let sum0 = 0;
    let sum3 = 0;
    for (let i = 0; i < 30; i++) {
      sum0 += p.delayMs(0);
      sum3 += p.delayMs(3);
    }
    expect(sum3).toBeGreaterThan(sum0);
  });

  // Regression: § 1.1 PR-B2-from-the-report — switched from
  // Math.random() to crypto.randomInt(). Verify the jitter is still
  // distributed across the expected [0, 1000) integer range. 10k
  // samples → roughly uniform across the 1000 possible values.
  it('delayMs jitter is uniformly distributed across [0, 1000)', () => {
    const buckets = new Array<number>(10).fill(0); // 10 buckets of width 100
    const samples = 10_000;
    for (let i = 0; i < samples; i++) {
      // attempt=0 → exp=1000, jitter is the entire [0, 1000) range
      const d = p.delayMs(0);
      const jitter = d - 1000; // strip the base exponential
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(1000);
      const bucket = Math.floor(jitter / 100);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    // Each of the 10 buckets should hold ~1000 samples (within ±10%).
    // We allow ±15% to keep the test stable across CI noise.
    for (const count of buckets) {
      expect(count).toBeGreaterThan((samples / 10) * 0.85);
      expect(count).toBeLessThan((samples / 10) * 1.15);
    }
  });

  // Regression: jitter should never exceed 1000 — the upper bound of
  // the [0, base) range. crypto.randomInt(min, max) is half-open so
  // the inclusive upper bound is `base - 1` (i.e. 999).
  it('delayMs jitter never exceeds 1000 - 1 (crypto.randomInt half-open)', () => {
    for (let i = 0; i < 1000; i++) {
      const d = p.delayMs(0);
      expect(d - 1000).toBeLessThan(1000);
    }
  });

  // -------------------------------------------------------------------------
  // § 1.2: Retry-After hint honour
  // -------------------------------------------------------------------------

  it('honours Retry-After in seconds when present', () => {
    // Server told us "Retry-After: 5" — come back in 5 seconds.
    const err = new ProviderError('rate limited', 429, true, 'anthropic', {
      body: { retryAfterMs: 5_000 },
    });
    expect(p.delayMs(0, err)).toBe(5_000);
    expect(p.delayMs(2, err)).toBe(5_000); // attempt index ignored
  });

  it('honours Retry-After from a sub-second value', () => {
    // 250ms server hint. No jitter applied — server was explicit.
    const err = new ProviderError('throttled', 429, true, 'openai', {
      body: { retryAfterMs: 250 },
    });
    expect(p.delayMs(0, err)).toBe(250);
  });

  it('clamps Retry-After to MAX_RETRY_AFTER_MS (60s)', () => {
    // Server asks for 5 minutes — we cap to 60s.
    const err = new ProviderError('rate limited', 429, true, 'x', {
      body: { retryAfterMs: 5 * 60_000 },
    });
    expect(p.delayMs(0, err)).toBe(60_000);
  });

  it('falls through to exponential schedule when retryAfterMs is missing', () => {
    // No retryAfterMs → use the default exponential+jitter path.
    const err = new ProviderError('rate limited', 429, true, 'x');
    // attempt=0 → exp=1000, jitter in [0, 1000)
    for (let i = 0; i < 50; i++) {
      const d = p.delayMs(0, err);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThan(2000);
    }
  });

  it('falls through when retryAfterMs is malformed (zero / negative / NaN)', () => {
    for (const bad of [
      0,
      -1,
      -1000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const err = new ProviderError('rate limited', 429, true, 'x', {
        body: { retryAfterMs: bad },
      });
      // attempt=0 → exp=1000, jitter in [0, 1000)
      const d = p.delayMs(0, err);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThan(2000);
    }
  });

  it('falls through to exponential schedule when error is a plain Error', () => {
    // Generic Error (not ProviderError) — never has retryAfterMs; the
    // policy must not crash and must use the default schedule.
    const err = new Error('ECONNRESET');
    const d = p.delayMs(0, err);
    expect(d).toBeGreaterThanOrEqual(1000);
    expect(d).toBeLessThan(2000);
  });

  it('falls through when err is omitted entirely', () => {
    // The optional-second-arg form must keep back-compat. No err →
    // exponential+jitter as before.
    const d = p.delayMs(2);
    expect(d).toBeGreaterThanOrEqual(4000); // 1000 * 2^2
    expect(d).toBeLessThan(5000);
  });
});
