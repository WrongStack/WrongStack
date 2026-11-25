import { describe, expect, it } from 'vitest';
import { hqHostHealthProblems } from '../src/host-health-verdict.js';
import type { HqHostHealth } from '../src/protocol.js';

describe('hqHostHealthProblems non-finite telemetry guard (F1990)', () => {
  it('does not raise false-positive disk or memory alerts on non-finite totals', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    const reportedAt = '2026-01-01T00:00:30Z';
    const nonFinite = hqHostHealthProblems(
      {
        reportedAt,
        diskTotalBytes: Number.POSITIVE_INFINITY,
        diskFreeBytes: 50 * 1024 ** 3,
        memTotalBytes: Number.POSITIVE_INFINITY,
        memAvailableBytes: 8 * 1024 ** 3,
      } as unknown as HqHostHealth & { reportedAt: string },
      now,
    );
    expect(nonFinite).toEqual([]);
  });
});
