/**
 * Unit tests for promiseWithTimeout — promise timeout with AbortSignal support.
 */
import { describe, expect, it } from 'vitest';
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
});
