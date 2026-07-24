import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenBucket } from '../../src/rate-limiter.js';

describe('createTokenBucket.isFull', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fresh bucket starts full', () => {
    const bucket = createTokenBucket({ tokensPerSecond: 1, burst: 4 });
    expect(bucket.isFull()).toBe(true);
  });

  it('uses defaults and exposes the current fill level', () => {
    const bucket = createTokenBucket();
    expect(bucket.fill()).toBe(4);
  });

  it('is not full once a token is consumed', async () => {
    vi.useFakeTimers();
    const bucket = createTokenBucket({ tokensPerSecond: 1, burst: 4 });
    await bucket.waitForToken(0); // consume one token immediately
    expect(bucket.isFull()).toBe(false);
  });

  it('reports full again only after refilling to capacity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const bucket = createTokenBucket({ tokensPerSecond: 1, burst: 4 });
    // Drain all four tokens.
    for (let i = 0; i < 4; i++) await bucket.waitForToken(0);
    expect(bucket.isFull()).toBe(false);

    // Refill 3 of 4 tokens (3s at 1 token/s): still not full.
    vi.setSystemTime(3_000);
    expect(bucket.isFull()).toBe(false);

    // One more second tops it off to burst.
    vi.setSystemTime(4_000);
    expect(bucket.isFull()).toBe(true);
  });

  it('waits for a refill when no deadline is supplied', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const bucket = createTokenBucket({ tokensPerSecond: 1, burst: 1 });
    await bucket.waitForToken();
    const pending = bucket.waitForToken();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    expect(bucket.fill()).toBe(0);
  });

  it('returns at the deadline and caps individual sleeps at five seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const bucket = createTokenBucket({ tokensPerSecond: 0.01, burst: 1 });
    await bucket.waitForToken(0);
    const pending = bucket.waitForToken(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
  });
});
