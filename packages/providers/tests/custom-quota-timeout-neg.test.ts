import { describe, expect, it } from 'vitest';
import { reportCustomQuota } from '../src/custom-quota.js';

describe('reportCustomQuota timeout sanitization', () => {
  it('handles negative, zero, and non-finite timeoutMs without throwing', async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify({ pct: 10 }), { status: 200 })) as unknown as typeof fetch;

    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await reportCustomQuota(
        'p',
        { url: 'https://api.example.com/quota', percent: 'pct' } as Parameters<
          typeof reportCustomQuota
        >[1],
        {
          apiKey: 'k',
          baseUrl: 'https://api.example.com',
          timeoutMs,
          fetchImpl: mockFetch,
        },
      );
      expect(Array.isArray(result)).toBe(true);
    }
  });
});
