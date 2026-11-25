import { describe, expect, it } from 'vitest';
import { reportOpenRouterQuota } from '../src/openrouter-quota.js';

describe('reportOpenRouterQuota timeout sanitization', () => {
  it('handles negative, zero, and non-finite timeoutMs without throwing', async () => {
    const mockFetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await reportOpenRouterQuota('openrouter', {
        apiKey: 'k',
        timeoutMs,
        fetchImpl: mockFetch,
      });
      expect(result).toEqual([]);
    }
  });
});
