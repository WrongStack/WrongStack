import { afterEach, describe, expect, it } from 'vitest';
import { checkConnectivity, resetConnectivityCache } from '../../src/utils/connectivity.js';

describe('checkConnectivity reset race and timeout bounds', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    resetConnectivityCache();
  });

  it('does not let an in-flight probe repopulate cache after resetConnectivityCache()', async () => {
    resetConnectivityCache();
    let release!: () => void;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error('offline');
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const first = checkConnectivity({ probeUrl: 'https://example.test/race', ttlMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    resetConnectivityCache();
    release();
    expect(await first).toBe(false);

    expect(await checkConnectivity({ probeUrl: 'https://example.test/race', ttlMs: 60_000 })).toBe(
      true,
    );
    expect(calls).toBe(2);
  });
});
