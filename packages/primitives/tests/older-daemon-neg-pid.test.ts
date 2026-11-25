import { describe, expect, it } from 'vitest';
import { forceStopDaemon, retireOlderDaemon } from '../src/older-daemon.js';

describe('older-daemon pid validation', () => {
  it('rejects negative, zero, and non-integer pids before calling process.kill', () => {
    const killed: number[] = [];
    const origKill = process.kill;
    process.kill = ((pid: number) => {
      killed.push(pid);
      return true;
    }) as typeof process.kill;

    try {
      expect(
        retireOlderDaemon(null, () => '', { pid: -1, runtimeVersion: '0.1.0' }, 'd').pid,
      ).toBeUndefined();
      expect(
        retireOlderDaemon(null, () => '', { pid: 1.5, runtimeVersion: '0.1.0' }, 'd').pid,
      ).toBeUndefined();
      expect(forceStopDaemon(-1)).toBe(false);
      expect(forceStopDaemon(0)).toBe(false);
      expect(forceStopDaemon(Number.NaN)).toBe(false);
      expect(killed).toEqual([]);
    } finally {
      process.kill = origKill;
    }
  });
});
