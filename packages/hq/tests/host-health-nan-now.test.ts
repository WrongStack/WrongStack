import { describe, expect, it } from 'vitest';
import { hqHostHealthProblems } from '../src/host-health-verdict.js';

describe('hqHostHealthProblems non-finite now guard', () => {
  it('does not treat stale health samples as fresh when now is NaN or Infinity', () => {
    const staleHealth = {
      reportedAt: '2020-01-01T00:00:00.000Z',
      diskTotalBytes: 100_000_000_000,
      diskFreeBytes: 1_000,
      memTotalBytes: 16_000_000_000,
      memAvailableBytes: 1_000,
    } as never;

    expect(hqHostHealthProblems(staleHealth, Number.NaN)).toEqual([]);
    expect(hqHostHealthProblems(staleHealth, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});
