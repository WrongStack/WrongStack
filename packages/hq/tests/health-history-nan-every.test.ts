import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HqHealthHistory } from '../src/persistence/health-history.js';
import type { HqSnapshot } from '../src/protocol.js';

describe('HqHealthHistory non-finite overview step and health fields (F1850)', () => {
  it('treats non-finite or non-positive everyMs as no thinning and sanitizes NaN health fields', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-health-nan-'));
    try {
      const history = new HqHealthHistory({ dataDir: tmpDir });
      const base = Date.parse('2026-11-25T10:00:00.000Z');
      for (let i = 0; i < 4; i++) {
        const at = base + i * 20 * 60_000;
        history.observe(
          {
            type: 'hq.snapshot',
            generatedAt: new Date(at).toISOString(),
            totals: { machines: 1, projects: 0, activeAgents: 0, totalCostUsd: 0 },
            machines: [
              {
                machineId: 'm1',
                hostname: 'host-a',
                connectedAt: new Date(base).toISOString(),
                lastActivityAt: new Date(at).toISOString(),
                projects: 0,
                activeAgents: 0,
                totalCostUsd: 0,
                health: {
                  reportedAt: new Date(at).toISOString(),
                  memTotalBytes: i === 0 ? Number.NaN : 1000,
                  memAvailableBytes: i === 0 ? Number.NaN : 400,
                  cpuCount: i === 0 ? Number.NaN : 4,
                  loadAvg1: i === 0 ? Number.NaN : 1.5,
                },
              },
            ],
            projects: [],
          } as unknown as HqSnapshot,
          at,
        );
      }
      await history.drain();

      for (const badEvery of [Number.NaN, -100, Number.POSITIVE_INFINITY, 0]) {
        const res = history.overview(base, badEvery);
        expect(res).toHaveLength(1);
        expect(res[0]?.points).toHaveLength(4);
      }

      const thinned = history.overview(base, 40 * 60_000);
      expect(thinned[0]?.points).toHaveLength(3);
      expect(Number.isFinite(thinned[0]?.points[0]?.memUsedPct)).toBe(true);
      expect(Number.isFinite(thinned[0]?.points[0]?.cpuCount)).toBe(true);
      expect(thinned[0]?.points[0]?.load1).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
