/**
 * Unit tests for parseResetHintMs — prose reset-time extraction from provider
 * error messages ("try again in 6h12m", "resets at <ISO>") used to hold the
 * provider waiting room until the real limit reset.
 */

import { strictEqual } from 'node:assert';
import { describe, it } from 'vitest';
import { MAX_RESET_HINT_MS, parseResetHintMs } from '../../src/types/provider.js';

describe('parseResetHintMs', () => {
  it('parses OpenAI-style Go durations', () => {
    strictEqual(parseResetHintMs('Rate limit reached. Please try again in 6h12m'), 22_320_000);
    strictEqual(parseResetHintMs('Please try again in 20ms'), 20);
    strictEqual(parseResetHintMs('Please try again in 1.5s'), 1_500);
    strictEqual(parseResetHintMs('Please try again in 6h12m0.5s'), 22_320_500);
  });

  it('parses English relative durations', () => {
    strictEqual(parseResetHintMs('retry after 90 seconds'), 90_000);
    strictEqual(parseResetHintMs('usage cap reached; resets in 2 hours'), 7_200_000);
    strictEqual(parseResetHintMs('available in 1 day'), 86_400_000);
    strictEqual(parseResetHintMs('Please try again in an hour'), 3_600_000);
    strictEqual(parseResetHintMs('Please try again in a minute'), 60_000);
  });

  it.each([
    ['Please retry after 30 seconds. The quota covers 24 hours.', 30_000],
    ['retry after 30s; quota window is 24h', 30_000],
    ['retry after 30s with a 24h quota window', 30_000],
    ['retry after a minute. Quota window is 24 hours.', 60_000],
    ['retry after maintenance lasting 24 hours', undefined],
    ['retry after 0s. Quota window is 24 hours.', undefined],
  ])('keeps unrelated prose out of the reset hint: %s', (message, expected) => {
    strictEqual(parseResetHintMs(message), expected);
  });

  it.each(['1h 30m', '1 hour and 30 minutes', '1 hour, 30 minutes', '1 hour, and 30 minutes'])(
    'preserves compound durations: %s',
    (duration) => {
      strictEqual(parseResetHintMs(`retry after ${duration}`), 5_400_000);
    },
  );

  it('parses absolute ISO timestamps against an injected now', () => {
    const now = Date.parse('2026-07-31T22:00:00Z');
    strictEqual(
      parseResetHintMs('Your usage limit resets at 2026-08-01T00:00:00Z', now),
      2 * 3_600_000,
    );
    strictEqual(parseResetHintMs('quota reset on 2026-08-01 00:00 UTC', now), 2 * 3_600_000);
  });

  it('clamps absurd delays to the 7-day maximum', () => {
    strictEqual(parseResetHintMs('Please try again in 30 days'), MAX_RESET_HINT_MS);
    strictEqual(MAX_RESET_HINT_MS, 7 * 24 * 60 * 60 * 1_000);
  });

  it('returns undefined for missing, past, or garbage hints', () => {
    strictEqual(parseResetHintMs(''), undefined);
    strictEqual(parseResetHintMs('429 too many requests'), undefined);
    strictEqual(parseResetHintMs('rate limit exceeded'), undefined);
    strictEqual(parseResetHintMs('try again in a bit'), undefined);
    strictEqual(parseResetHintMs('try again later'), undefined);
    strictEqual(
      parseResetHintMs('resets at 2020-01-01T00:00:00Z', Date.parse('2026-07-31T22:00:00Z')),
      undefined,
    );
  });
});
