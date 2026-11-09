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

  it('falls back to safe defaults for NaN, zero tokensPerSecond, or negative burst (F137)', () => {
    const nanBucket = createTokenBucket({ tokensPerSecond: Number.NaN, burst: Number.NaN });
    expect(nanBucket.fill()).toBe(4);
    expect(nanBucket.isFull()).toBe(true);

    const zeroRateBucket = createTokenBucket({ tokensPerSecond: 0, burst: -1 });
    expect(zeroRateBucket.fill()).toBe(4);
    expect(zeroRateBucket.isFull()).toBe(true);
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
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const bucket = createTokenBucket({ tokensPerSecond: 0.01, burst: 1 });
      await bucket.waitForToken(0);
      const pending = bucket.waitForToken(10_000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('throws immediately on pre-aborted signal before consuming available tokens and guards sleep against pre-aborted signals', async () => {
    const bucket = createTokenBucket({ tokensPerSecond: 1, burst: 2 });
    const ac = new AbortController();
    ac.abort();
    await expect(bucket.waitForToken(1000, ac.signal)).rejects.toThrow();
    expect(bucket.fill()).toBe(2);

    // Also exercise sleep()'s own signal.aborted guard when signal becomes aborted right after throwIfAborted
    const emptyBucket = createTokenBucket({ tokensPerSecond: 1, burst: 0 });
    const lateAbortSignal = {
      aborted: true,
      throwIfAborted: () => {
        /* no-op on first check so execution reaches sleep(delay, signal) */
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    await expect(emptyBucket.waitForToken(1000, lateAbortSignal)).rejects.toThrow(/aborted/i);
    expect(lateAbortSignal.addEventListener).not.toHaveBeenCalled();
  });

  it('enforces 1ms minimum sleep floor and ignores backward clock jumps in refill()', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const bucket = createTokenBucket({ tokensPerSecond: 1, burst: 4 });
    await bucket.waitForToken(0);
    expect(bucket.fill()).toBe(3);

    // Backward clock jump (elapsed < 0) must not reduce tokens
    vi.setSystemTime(5_000);
    expect(bucket.fill()).toBe(3);

    // When untilToken <= 0 (e.g. negative tokensPerSecond configuration), delay is floored at 1ms
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const negRateBucket = createTokenBucket({ tokensPerSecond: -1, burst: 0 });
      const p = negRateBucket.waitForToken(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1);
      await vi.advanceTimersByTimeAsync(5);
      await p;
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
