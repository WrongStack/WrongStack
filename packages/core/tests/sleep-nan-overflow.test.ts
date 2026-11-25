import { describe, expect, it } from 'vitest';
import { sleep } from '../src/utils/sleep.js';

describe('sleep timer delay bounds', () => {
  it('clamps NaN, negative, and > 2^31-1 delays before calling setTimeout', async () => {
    const origSetTimeout = globalThis.setTimeout;
    const observed: unknown[] = [];

    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number) => {
      observed.push(delay);
      return origSetTimeout(fn, 0);
    }) as typeof setTimeout;

    try {
      await sleep(10);
      await sleep(Number.NaN);
      await sleep(-5);
      await sleep(3_000_000_000);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    expect(observed).toEqual([10, 0, 0, 2_147_483_647]);
  });
});
