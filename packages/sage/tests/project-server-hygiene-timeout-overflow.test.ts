import { describe, expect, it } from 'vitest';
import { createHygieneRunner } from '../src/project-server-hygiene.js';

describe('createHygieneRunner timeout chunking (F286)', () => {
  it('chunks delays exceeding 2^31-1 ms instead of overflowing setTimeout', () => {
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
      const runner = createHygieneRunner({} as never, {
        intervalMs: 3_000_000_000,
        now: () => 10_000,
      });
      runner.schedule();
      runner.dispose();
      expect(recordedDelays.length).toBeGreaterThan(0);
      expect(recordedDelays.every((d) => d >= 0 && d <= 2_147_483_647)).toBe(true);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
    }
  });
});
