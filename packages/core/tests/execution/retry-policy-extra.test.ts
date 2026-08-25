import { describe, expect, it } from 'vitest';
import {
  DefaultRetryPolicy,
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_MS,
} from '../../src/execution/retry-policy.js';
import { ProviderError } from '../../src/types/provider.js';

describe('DefaultRetryPolicy — extra', () => {
  const p = new DefaultRetryPolicy();

  describe('shouldRetry edge cases', () => {
    it('does not retry for provider errors with retryable=false even with high attempt count', () => {
      const err = new ProviderError('auth error', 401, false, 'test');
      expect(p.shouldRetry(err, 0)).toBe(false);
      expect(p.shouldRetry(err, 99)).toBe(false);
    });

    it('does not retry for completely unknown error shapes', () => {
      expect(p.shouldRetry({ custom: 'error' } as never, 0)).toBe(false);
      expect(p.shouldRetry('string error' as never, 0)).toBe(false);
      expect(p.shouldRetry(42 as never, 0)).toBe(false);
      // null/undefined would throw — they are not Error instances
    });

    it('retries network errors (non-ProviderError with code) up to 2 times', () => {
      const err = new Error('ENOTFOUND') as Error & { code: string };
      err.name = 'Error';
      (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
      expect(p.shouldRetry(err, 0)).toBe(true);
      expect(p.shouldRetry(err, 2)).toBe(false);
    });

    it('does not retry errors with unknown code', () => {
      const err = new Error('unknown') as Error & { code: string };
      (err as NodeJS.ErrnoException).code = 'UNKNOWN_CODE';
      expect(p.shouldRetry(err, 0)).toBe(false);
    });
  });

  describe('maxAttempts returns expected values for all paths', () => {
    it('returns 0 for non-retryable provider errors', () => {
      const err = new ProviderError('bad', 400, false, 'test');
      expect(p.maxAttempts(err)).toBe(0);
    });

    it('returns 2 for network errors (errors with code field)', () => {
      const err = new Error('ENOTFOUND');
      (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
      expect(p.maxAttempts(err)).toBe(2);
    });

    it('returns 2 for non-ProviderError Error (any Error instance)', () => {
      expect(p.maxAttempts(new Error('generic'))).toBe(2);
    });
  });

  describe('delayMs edge cases', () => {
    it('grows exponentially with attempt index (capped at 30s)', () => {
      for (let i = 0; i < 10; i++) {
        const d = p.delayMs(i);
        // Exponential backoff: RETRY_BASE_DELAY_MS * 2^i + jitter, capped
        // at 30_000. The cap bites from i=3 on (4s base → 32s).
        const expectedMin = RETRY_BASE_DELAY_MS * 2 ** i;
        if (expectedMin <= 30_000) {
          expect(d).toBeGreaterThanOrEqual(expectedMin);
          expect(d).toBeLessThanOrEqual(Math.min(30_000, expectedMin + RETRY_JITTER_MS - 1));
        } else {
          // Capped at 30s when exponential exceeds cap
          expect(d).toBe(30_000);
        }
      }
    });

    it('caps jitter at expected value for high attempt counts', () => {
      for (let i = 0; i < 100; i++) {
        const d = p.delayMs(10); // 4000 * 2^10 = 4,096,000 but capped at 30s
        expect(d).toBeLessThanOrEqual(30_000);
        expect(d).toBeGreaterThan(0);
      }
    });

    it('handles negative attempt index gracefully', () => {
      const d = p.delayMs(-1);
      // Should at least produce a reasonable value without crashing
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(30_000);
    });
  });

  describe('Retry-After edge cases', () => {
    it('prefers retryAfterMs over exponential schedule', () => {
      const err = new ProviderError('rate limited', 429, true, 'test', {
        body: { retryAfterMs: 15_000 },
      });
      const d = p.delayMs(5, err);
      expect(d).toBe(15_000); // should be exactly 15s, not exponential
    });

    it('clamps extremely high retryAfterMs values', () => {
      const err = new ProviderError('rate limited', 429, true, 'test', {
        body: { retryAfterMs: 300_000 }, // 5 minutes
      });
      expect(p.delayMs(0, err)).toBe(60_000);
    });

    it('handles retryAfterMs=0 with fallback to exponential', () => {
      const err = new ProviderError('rate limited', 429, true, 'test', {
        body: { retryAfterMs: 0 },
      });
      for (let i = 0; i < 20; i++) {
        const d = p.delayMs(0, err);
        expect(d).toBeGreaterThanOrEqual(1000); // exponential path
      }
    });
  });
});
