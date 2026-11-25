import { describe, expect, it } from 'vitest';
import { createTokenBucket } from '../src/rate-limiter.js';

describe('createTokenBucket non-finite timeout handling', () => {
  it('does not busy-spin setTimeout when timeoutMs is NaN', async () => {
    const bucket = createTokenBucket({ tokensPerSecond: 0.5, burst: 1 });
    await bucket.waitForToken(100);

    let setTimeoutCalls = 0;
    const origSetTimeout = globalThis.setTimeout;
    const ac = new AbortController();
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      setTimeoutCalls += 1;
      return origSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout;

    try {
      const abortTimer = origSetTimeout(() => ac.abort(), 40);
      await bucket.waitForToken(Number.NaN, ac.signal).catch(() => undefined);
      clearTimeout(abortTimer);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }

    expect(setTimeoutCalls).toBeLessThanOrEqual(2);
  });
});
