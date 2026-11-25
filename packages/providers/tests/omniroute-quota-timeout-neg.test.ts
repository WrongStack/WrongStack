import { describe, expect, it } from 'vitest';
import { reportOmniRouteQuota } from '../src/omniroute-quota.js';

describe('reportOmniRouteQuota timeout sanitization', () => {
  it('handles negative, zero, and non-finite timeoutMs without throwing', async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify({}), { status: 500 })) as unknown as typeof fetch;

    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await reportOmniRouteQuota('omni', {
        managementToken: 'oma_test',
        root: 'http://localhost:20128',
        timeoutMs,
        fetchImpl: mockFetch,
      });
      expect(result).toEqual([]);
    }
  });
});
