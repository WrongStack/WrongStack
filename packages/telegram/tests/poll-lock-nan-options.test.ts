import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PollLock } from '../src/poll-lock.js';

describe('PollLock non-finite interval options', () => {
  it('falls back to safe defaults when heartbeatMs or staleMs is NaN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-polllock-nan-'));
    try {
      let intervalCalls = 0;
      let passedDelay: number | undefined;
      const origSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((
        fn: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        passedDelay = delay;
        return origSetInterval(
          () => {
            intervalCalls += 1;
            fn();
          },
          delay,
          ...args,
        );
      }) as typeof setInterval;

      const lock = new PollLock(join(dir, 'poll.lock'), {
        heartbeatMs: Number.NaN,
        staleMs: Number.NaN,
      });
      try {
        expect(lock.tryAcquire()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 35));
      } finally {
        lock.release();
        globalThis.setInterval = origSetInterval;
      }

      expect(Number.isFinite(passedDelay)).toBe(true);
      expect(passedDelay).toBe(15_000);
      expect(intervalCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
