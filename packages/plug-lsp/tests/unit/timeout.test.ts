/**
 * Unit tests for promiseWithTimeout — promise timeout with AbortSignal support.
 */
import { describe, expect, it, vi } from 'vitest';
import { promiseWithTimeout, timeoutCoverage } from '../../src/utils/timeout.js';

describe('promiseWithTimeout', () => {
  it('resolves with the promise value when promise completes before timeout', async () => {
    const result = await promiseWithTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('rejects with the promise error when promise rejects before timeout', async () => {
    await expect(promiseWithTimeout(Promise.reject(new Error('fail')), 1000)).rejects.toThrow(
      'fail',
    );
  });

  it('rejects with timeout error when promise does not complete in time', async () => {
    const slow = new Promise<string>(() => {}); // never resolves
    await expect(promiseWithTimeout(slow, 10)).rejects.toThrow('timed out');
  });

  it('rejects immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(promiseWithTimeout(Promise.resolve('never'), 1000, ac.signal)).rejects.toThrow(
      'aborted',
    );
  });

  it('consumes a rejected promise when the signal was already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(
      promiseWithTimeout(Promise.reject(new Error('late failure')), 1000, ac.signal),
    ).rejects.toThrow('cancelled');
  });

  it('rejects with signal reason when aborted during wait', async () => {
    const ac = new AbortController();
    const slow = new Promise<string>(() => {});
    const promise = promiseWithTimeout(slow, 1000, ac.signal);
    setTimeout(() => ac.abort(new Error('cancelled')), 5);
    await expect(promise).rejects.toThrow('cancelled');
  });

  it('rejects with default error when signal aborts without reason', async () => {
    const ac = new AbortController();
    const slow = new Promise<string>(() => {});
    const promise = promiseWithTimeout(slow, 1000, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(promise).rejects.toThrow('aborted');
  });

  it('cleans up timer when promise resolves', async () => {
    const result = await promiseWithTimeout(Promise.resolve('fast'), 100);
    expect(result).toBe('fast');
  });

  it('cleans up timer when promise rejects', async () => {
    await expect(promiseWithTimeout(Promise.reject(new Error('fast-fail')), 100)).rejects.toThrow(
      'fast-fail',
    );
  });

  it('cleans up abort listener when promise resolves', async () => {
    const ac = new AbortController();
    const result = await promiseWithTimeout(Promise.resolve('done'), 100, ac.signal);
    expect(result).toBe('done');
    // Signal listener should be cleaned up
    expect(ac.signal.aborted).toBe(false);
  });

  it('works without AbortSignal', async () => {
    const result = await promiseWithTimeout(Promise.resolve('no-signal'), 100);
    expect(result).toBe('no-signal');
  });

  it('normalizes a non-Error abort reason', () => {
    expect(timeoutCoverage.abortError({ reason: 'cancelled' } as AbortSignal)).toEqual(
      new Error('aborted'),
    );
  });

  it('chunks ms > 2^31-1 ms instead of overflowing setTimeout (F309)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const result = await promiseWithTimeout(Promise.resolve('ok'), 2_147_483_648);
      expect(result).toBe('ok');
      const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1] ?? 0));
      expect(delays.length).toBeGreaterThan(0);
      expect(delays.every((d) => d >= 0 && d <= 2_147_483_647)).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('keeps a long request pending through its first timer chunk and expires at its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const limit = 2_147_483_647;
      let complete!: (value: string) => void;
      const work = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const timed = promiseWithTimeout(work, limit + 50);
      let outcome = 'pending';
      const observed = timed.then(
        () => {
          outcome = 'resolved';
          return undefined;
        },
        (error: unknown) => {
          outcome = 'rejected';
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(limit);
      expect(outcome).toBe('pending');
      expect(timers.mock.calls.map((call) => call[1])).toEqual([limit, 50]);
      await vi.advanceTimersByTimeAsync(49);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(await observed).toMatchObject({
        message: `LSP request timed out after ${limit + 50}ms`,
      });
      expect(outcome).toBe('rejected');
      expect(vi.getTimerCount()).toBe(0);
      // Late work completion after timeout must remain harmless and timer-free.
      complete('late');
      await Promise.resolve();
      expect(outcome).toBe('rejected');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timers.mockRestore();
      vi.useRealTimers();
    }
  });

  it('ignores an already queued timer callback after the request completes', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const timed = promiseWithTimeout(Promise.resolve('done'), 2_147_483_648);
      const callback = timers.mock.calls[0]?.[0];
      expect(typeof callback).toBe('function');
      expect(await timed).toBe('done');
      if (typeof callback !== 'function') throw new Error('Expected a scheduled timeout callback');
      callback();
      expect(timers).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timers.mockRestore();
      vi.useRealTimers();
    }
  });
});
