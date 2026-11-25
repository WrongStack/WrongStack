import { describe, expect, it } from 'vitest';
import { sleepWithAbort } from '../src/llm-client.js';

describe('sleepWithAbort non-finite and overflow delays (F1862)', () => {
  it('normalizes NaN, negative, Infinity, and overflow delays before calling setTimeout', async () => {
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
      for (const bad of [Number.NaN, -100, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
        await sleepWithAbort(bad, new AbortController());
      }
      await sleepWithAbort(5_000_000_000, new AbortController());
      await sleepWithAbort(42.9, new AbortController());

      expect(seenDelays).toEqual([0, 0, 0, 0, 2_147_483_647, 42]);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});
