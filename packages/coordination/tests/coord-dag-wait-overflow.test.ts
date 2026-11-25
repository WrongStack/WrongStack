import { describe, expect, it } from 'vitest';
import { waitForDagProgress } from '../src/autonomous-coordinator-dag-helpers.js';

describe('waitForDagProgress 32-bit timeout cap (F2291)', () => {
  it('caps oversized timeoutMs instead of overflowing setTimeout to 1ms', async () => {
    let listener: (() => void) | undefined;
    let done = false;
    const dag = {
      isDone: () => false,
      stats: () => ({
        pending: 1,
        ready: 0,
        running: 0,
        done: done ? 1 : 0,
        failed: 0,
        skipped: 0,
      }),
      onEvent: (fn: () => void) => {
        listener = fn;
        return () => {};
      },
    };
    const start = Date.now();
    setTimeout(() => {
      done = true;
      listener?.();
    }, 60);
    await waitForDagProgress(dag as never, 1e15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
