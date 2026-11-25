import { describe, expect, it } from 'vitest';
import { fetchZaiPlanReport } from '../src/zai-account.js';

describe('fetchZaiPlanReport days sanitization', () => {
  it('sanitizes non-finite and non-positive days instead of emitting NaN dates', async () => {
    const urls: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ code: 200, success: true, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    for (const days of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      urls.length = 0;
      await fetchZaiPlanReport({
        apiKey: 'k',
        region: 'zai',
        days,
        now: new Date('2026-10-10T12:00:00Z'),
        fetchImpl: mockFetch,
      });
      expect(urls.some((u) => u.includes('NaN'))).toBe(false);
    }
  });
});
