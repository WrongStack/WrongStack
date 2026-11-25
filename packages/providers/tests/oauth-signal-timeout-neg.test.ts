import { describe, expect, it } from 'vitest';
import { oauthSignal } from '../src/oauth/http.js';

describe('oauthSignal timeout sanitization', () => {
  it('falls back to default timeout for negative, zero, and non-finite values', () => {
    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(oauthSignal(undefined, timeoutMs)).toBeInstanceOf(AbortSignal);
    }
  });
});
