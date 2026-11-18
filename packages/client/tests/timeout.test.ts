import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancellableDelay, scheduleTimeout } from '../src/connection.js';

afterEach(() => vi.useRealTimers());

describe('client chunked timeouts', () => {
  it('fires once only after the entire multi-chunk request timeout', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    scheduleTimeout(2_147_483_652, expired);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a request timeout after the first chunk without a late notification', async () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const timer = scheduleTimeout(2_147_483_652, expired);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    timer.cancel();
    await vi.advanceTimersByTimeAsync(5);
    expect(expired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    'settles a reconnect delay and releases its timer (cancel: %s)',
    async (cancel) => {
      vi.useFakeTimers();
      const settled = vi.fn();
      const delay = cancellableDelay(10, settled);
      if (cancel) delay.cancel();
      else await vi.advanceTimersByTimeAsync(10);
      expect(await delay.promise).toBe(!cancel);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'keeps invalid/zero reconnect delays asynchronous (%s)',
    async (ms) => {
      vi.useFakeTimers();
      const settled = vi.fn();
      const delay = cancellableDelay(ms, settled);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(await delay.promise).toBe(true);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
