import { describe, expect, it } from 'vitest';
import { reportOpenCodeQuota } from '../src/opencode-quota.js';

describe('reportOpenCodeQuota timeout sanitization', () => {
  it('handles negative, zero, and non-finite timeoutMs without throwing', async () => {
    const mockFetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await reportOpenCodeQuota('opencode', {
        apiKey: 'k',
        timeoutMs,
        fetchImpl: mockFetch,
      });
      expect(result).toEqual([]);
    }
  });
});
