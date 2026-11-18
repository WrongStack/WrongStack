import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChronicleMetricsStore } from '../src/metrics-store.js';
import { ChronicleSqliteJournal } from '../src/sqlite-journal.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('ChronicleMetricsStore token cost preservation and distinct provider/model counts (F534)', () => {
  it('preserves recorded scope cost across unpriced or negative snapshots, honors explicit 0 resets, and excludes empty provider/model sentinels', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-f534-'));
    dirs.push(tmp);
    const dir = path.join(tmp, 'chronicle');
    await fs.mkdir(dir, { recursive: true });

    const journal = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2026-11-18T10:00:00.000Z'),
    });
    let metrics: ChronicleMetricsStore | null = null;

    try {
      const baseScope = {
        installationId: 'inst-1',
        machineId: 'mach-1',
        projectId: 'proj-1',
        sessionId: 'sess-1',
        agentId: 'leader',
      };
      const baseCorr = { traceId: 'tr-1', spanId: 'sp-1' };

      await journal.append({
        eventType: 'provider.fallback',
        outcome: 'success',
        occurredAt: '2026-11-18T10:00:01.000Z',
        scope: baseScope,
        correlation: baseCorr,
        runtime: { providerId: 'anthropic' },
      });
      await journal.append({
        eventType: 'provider.attempt.started',
        outcome: 'success',
        occurredAt: '2026-11-18T10:00:02.000Z',
        scope: baseScope,
        correlation: baseCorr,
        runtime: { modelId: 'claude-4' },
      });
      await journal.append({
        eventType: 'token.accounted',
        outcome: 'success',
        occurredAt: '2026-11-18T10:00:03.000Z',
        scope: baseScope,
        correlation: baseCorr,
        attributes: { usage: { input: 500, output: 100 }, cost: { total: 2.5 } },
      });
      await journal.append({
        eventType: 'metrics.counter',
        outcome: 'success',
        occurredAt: '2026-11-18T10:00:04.000Z',
        scope: baseScope,
        correlation: baseCorr,
        attributes: {
          counter: 'token.accounted',
          latest: { 'usage.input': 900, 'usage.output': 200 },
        },
      });
      await journal.append({
        eventType: 'token.accounted',
        outcome: 'success',
        occurredAt: '2026-11-18T10:00:05.000Z',
        scope: baseScope,
        correlation: baseCorr,
        attributes: { usage: { input: 950, output: 220 }, cost: { total: -10 } },
      });

      metrics = ChronicleMetricsStore.open(dir);
      await metrics.refresh();

      const s1 = metrics.defaultSummary();
      const q1 = await journal.queryEngine().query({});
      expect(s1.providers).toBe(1);
      expect(s1.models).toBe(1);
      expect(s1.estimatedCostUsd).toBe(2.5);
      expect(s1.estimatedCostUsd).toBe(q1.summary.estimatedCostUsd);
      expect(metrics.summary().estimatedCostUsd).toBe(2.5);

      await journal.append({
        eventType: 'token.accounted',
        outcome: 'success',
        occurredAt: '2026-11-18T10:00:06.000Z',
        scope: baseScope,
        correlation: baseCorr,
        attributes: { usage: { input: 10, output: 5 }, cost: { total: 0 } },
      });
      await metrics.refresh();

      const s2 = metrics.defaultSummary();
      const q2 = await journal.queryEngine().query({});
      expect(s2.estimatedCostUsd).toBe(0);
      expect(s2.estimatedCostUsd).toBe(q2.summary.estimatedCostUsd);
    } finally {
      metrics?.close();
      journal.close();
    }
  });
});
