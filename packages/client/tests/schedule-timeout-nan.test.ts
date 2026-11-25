import { describe, expect, it } from 'vitest';
import { cancellableDelay, scheduleTimeout } from '../src/connection.js';

describe('scheduleTimeout and cancellableDelay edge cases (F1863)', () => {
  it('normalizes non-finite delays to 0 and invokes onSettled at most once', async () => {
    const seenDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      seenDelays.push(delay as number);
      return origSetTimeout(fn, 1, ...args);
    }) as typeof setTimeout;

    try {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50]) {
        const handle = scheduleTimeout(bad, () => {});
        handle.cancel();
      }
      expect(seenDelays).toEqual([0, 0, 0, 0]);

      let settledCount = 0;
      const delay = cancellableDelay(100, () => {
        settledCount += 1;
      });
      delay.cancel();
      delay.cancel();
      expect(await delay.promise).toBe(false);
      expect(settledCount).toBe(1);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});
