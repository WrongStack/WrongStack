import { describe, expect, it } from 'vitest';
import { reportKimiCodeQuota } from '../src/kimi-code-quota.js';

describe('reportKimiCodeQuota timeout sanitization', () => {
  it('handles negative, zero, and non-finite timeoutMs without throwing', async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await reportKimiCodeQuota('kimi', {
        apiKey: 'k',
        timeoutMs,
        fetchImpl: mockFetch,
      });
      expect(Array.isArray(result)).toBe(true);
    }
  });
});
