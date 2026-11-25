import { describe, expect, it } from 'vitest';
import { warmConnection } from '../src/connection-warmup.js';

describe('warmConnection (F2198)', () => {
  it('sanitizes non-finite now so throttling is not permanently bypassed', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const url = `https://f2198-test-${Date.now()}.example.com/v1`;
    await warmConnection(url, fakeFetch, Number.NaN);
    await warmConnection(url, fakeFetch, Date.now());
    expect(calls).toBe(1);
  });
});
