import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HqHealthHistory } from '../src/persistence/health-history.js';
import type { HqSnapshot } from '../src/protocol.js';

describe('HqHealthHistory.observe non-finite now guard', () => {
  it('ignores snapshots when now is NaN or Infinity instead of accepting future samples', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f1919-test-'));
    try {
      const history = new HqHealthHistory({ dataDir: dir });
      const futureSnapshot = {
        machines: [
          {
            hostname: 'lab-01',
            machineId: 'm1',
            health: {
              reportedAt: '2099-01-01T00:00:00.000Z',
              memTotalBytes: 16_000_000_000,
              memAvailableBytes: 8_000_000_000,
              cpuCount: 8,
            },
          },
        ],
      } as unknown as HqSnapshot;

      history.observe(futureSnapshot, Number.NaN);
      history.observe(futureSnapshot, Number.POSITIVE_INFINITY);
      expect(history.points('host:lab-01', 0)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
