import { describe, expect, it } from 'vitest';
import { hqHostHealthProblems, hqHostHealthThresholds } from '../src/host-health-verdict.js';

describe('hqHostHealthThresholds non-finite guards (F1846)', () => {
  it('falls back to defaults on NaN/negative/Infinity while still honoring explicit 0', () => {
    const now = Date.now();
    const critical = {
      reportedAt: new Date(now).toISOString(),
      diskTotalBytes: 100 * 1024 ** 3,
      diskFreeBytes: 1 * 1024 ** 3,
      memTotalBytes: 16 * 1024 ** 3,
      memAvailableBytes: 256 * 1024 ** 2,
      cpuCount: 8,
      loadAvg1m: 1,
      uptimeSec: 1000,
    } as unknown as Parameters<typeof hqHostHealthProblems>[0];

    const sanitized = hqHostHealthThresholds({
      hostDiskFreePct: Number.NaN,
      hostDiskFreeGiB: -2,
      hostMemAvailablePct: Number.POSITIVE_INFINITY,
    });
    expect(sanitized).toEqual({ diskFreePct: 5, diskFreeGiB: 2, memAvailablePct: 5 });
    expect(hqHostHealthProblems(critical, now, sanitized)).toEqual(['disk', 'memory']);

    const off = hqHostHealthThresholds({
      hostDiskFreePct: 0,
      hostDiskFreeGiB: 0,
      hostMemAvailablePct: 0,
    });
    expect(hqHostHealthProblems(critical, now, off)).toEqual([]);
  });
});
