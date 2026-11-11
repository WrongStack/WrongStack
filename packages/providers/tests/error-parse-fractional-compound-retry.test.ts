import { describe, expect, it } from 'vitest';
import {
  parseProviderHttpError,
  providerErrorFromStreamPayload,
  retryAfterMsFromBody,
} from '../src/error-parse.js';

const cases: [string, number | undefined][] = [
  ['Please retry in 1.5h30m', 7_200_000],
  ['Please try again in 0.5m30s', 60_000],
  ['Please retry after 2.25m15s', 150_000],
  ['Please retry in 1.5h30m0.5s', 7_200_500],
  ['Please retry in 1.5h30m.', 7_200_000],
  ['Please retry in 23.5h30m', 86_400_000],
  ['Please retry in 24.5h30m', undefined],
  ['Please retry in 1h30m', 5_400_000],
  ['Please retry in 1.5 hours.', 5_400_000],
  ['Please retry in 1.5 seconds.', 1_500],
  ['Please retry in 1 second.', 1_000],
];

describe('fractional compound provider retry hints', () => {
  it.each(cases)('preserves the full duration in HTTP errors: %s', (message, expected) => {
    const error = parseProviderHttpError('openai', 429, JSON.stringify({ error: { message } }));
    expect(error.body?.retryAfterMs).toBe(expected);
  });

  it.each(cases)('preserves the full duration in stream errors: %s', (message, expected) => {
    const error = providerErrorFromStreamPayload('openai', {
      error: { type: 'rate_limit_error', message },
    });
    expect(error.body?.retryAfterMs).toBe(expected);
  });

  it('extracts a hint from raw text when no parsed message is available', () => {
    expect(retryAfterMsFromBody({ raw: 'Please retry in 1.5h30m' })).toBe(7_200_000);
  });

  it('keeps explicit HTTP Retry-After precedence over body prose', () => {
    const error = parseProviderHttpError(
      'openai',
      429,
      JSON.stringify({ error: { message: 'Please retry in 1.5h30m' } }),
      new Headers({ 'retry-after': '60' }),
    );
    expect(error.body?.retryAfterMs).toBe(60_000);
  });
});
