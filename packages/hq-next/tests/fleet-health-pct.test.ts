import { describe, expect, it } from 'vitest';
import { fleetHealthRows } from '../src/features/machines/fleet-health';
import type { MachineSummary } from '../src/features/machines/model';

describe('fleetHealthRows diskFreePct bounds', () => {
  it('omits non-finite diskFreeBytes and clamps negative/overshoot percentages to 0..100', () => {
    const rows = fleetHealthRows(
      [
        {
          key: 'm1',
          hostname: 'b1',
          online: true,
          health: {
            platform: 'linux',
            arch: 'x64',
            memTotalBytes: 1000,
            memAvailableBytes: 500,
            diskTotalBytes: 1000,
            diskFreeBytes: Number.NaN,
            cpuCount: 4,
            uptimeSec: 100,
            reportedAt: '2026-01-01T00:00:00Z',
          },
        } as unknown as MachineSummary,
        {
          key: 'm2',
          hostname: 'b2',
          online: true,
          health: {
            platform: 'linux',
            arch: 'x64',
            memTotalBytes: 1000,
            memAvailableBytes: 500,
            diskTotalBytes: 1000,
            diskFreeBytes: -50,
            cpuCount: 4,
            uptimeSec: 100,
            reportedAt: '2026-01-01T00:00:00Z',
          },
        } as unknown as MachineSummary,
      ],
      [],
    );
    expect(rows.find((r) => r.key === 'm1')?.diskFreePct).toBeUndefined();
    expect(rows.find((r) => r.key === 'm2')?.diskFreePct).toBe(0);
  });
});
