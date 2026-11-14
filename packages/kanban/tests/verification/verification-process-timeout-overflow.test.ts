import { describe, expect, it } from 'vitest';
import { VerificationProcessRunner } from '../../src/verification/verification-process.js';

describe('VerificationProcessRunner timeout chunking (F303)', () => {
  it('chunks timeoutMs > 2^31-1 ms instead of overflowing setTimeout', async () => {
    const origSetTimeout = globalThis.setTimeout;
    const recordedDelays: number[] = [];
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _fn: Parameters<typeof setTimeout>[0],
      delay?: number,
    ) => {
      recordedDelays.push(Number(delay ?? 0));
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const vp = new VerificationProcessRunner(process.cwd());
      const res = await vp.runProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: process.cwd(),
        timeoutMs: 2_147_483_648,
      });
      expect(res.exitCode).toBe(0);
      expect(recordedDelays.length).toBeGreaterThan(0);
      expect(recordedDelays.every((d) => d >= 0 && d <= 2_147_483_647)).toBe(true);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
    }
  });
});
