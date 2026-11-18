import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChronicleMetricsStore } from '../src/metrics-store.js';
import { type ChronicleDispatchHost, dispatchChronicle } from '../src/project-server-dispatch.js';
import { ChronicleSqliteJournal } from '../src/sqlite-journal.js';
import type { ChronicleEventInput } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function eventInput(overrides: Partial<ChronicleEventInput>): ChronicleEventInput {
  return {
    eventType: 'tool.executed',
    outcome: 'success',
    scope: {
      installationId: 'inst-1',
      machineId: 'mach-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    },
    correlation: {
      traceId: 'trace-1',
      spanId: 'span-1',
    },
    ...overrides,
  };
}

describe('dispatchChronicle query summary window alignment', () => {
  it('computes exact sub-day and non-end-of-day query summaries while keeping the metrics fast path for full-day windows', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-dispatch-subday-'));
    tempDirs.push(dir);

    const journal = new ChronicleSqliteJournal({ directory: dir });
    const engine = journal.queryEngine();
    const metricsStore = ChronicleMetricsStore.open(dir);
    let metricsRefreshes = 0;

    const host: ChronicleDispatchHost = {
      serverHealth: async () => {
        throw new Error('unused');
      },
      appendInputs: async (inputs) => journal.appendBatch(inputs),
      flushJournals: async () => journal.flush(),
      useSqliteStore: () => true,
      store: async () => journal,
      journalForToday: () => {
        throw new Error('unused');
      },
      queryEngine: async () => engine,
      refreshMetrics: async () => {
        metricsRefreshes += 1;
        return metricsStore.refresh();
      },
      metrics: () => metricsStore,
    };

    try {
      await dispatchChronicle(host, 'append', {
        inputs: [
          eventInput({
            eventType: 'tool.failed',
            outcome: 'failure',
            occurredAt: '2026-07-24T08:00:00.000Z',
          }),
          eventInput({
            eventType: 'tool.executed',
            outcome: 'success',
            occurredAt: '2026-07-24T20:00:00.000Z',
          }),
          eventInput({
            eventType: 'tool.executed',
            outcome: 'success',
            occurredAt: '2026-07-25T09:00:00.000Z',
          }),
        ],
      });
      await dispatchChronicle(host, 'flush', {});

      // Rolling sub-day `from` window (e.g. Desktop Chronicle's default 24h filter)
      const subDayFrom = await dispatchChronicle(host, 'query', {
        query: {
          from: '2026-07-24T12:00:00.000Z',
          to: '2026-07-24T23:59:59.999Z',
          order: 'desc',
          limit: 100,
        },
      });
      expect(subDayFrom.total).toBe(1);
      expect(subDayFrom.events).toHaveLength(1);
      expect(subDayFrom.summary.completedTools).toBe(1);
      expect(subDayFrom.summary.failedTools).toBe(0);
      expect(subDayFrom.summary.failures).toBe(0);
      expect(subDayFrom.summary.families.tool).toBe(1);

      // Sub-day `to` window
      const subDayTo = await dispatchChronicle(host, 'query', {
        query: {
          from: '2026-07-24T00:00:00.000Z',
          to: '2026-07-24T12:00:00.000Z',
          order: 'desc',
          limit: 100,
        },
      });
      expect(subDayTo.total).toBe(1);
      expect(subDayTo.summary.completedTools).toBe(0);
      expect(subDayTo.summary.failedTools).toBe(1);
      expect(subDayTo.summary.failures).toBe(1);
      expect(subDayTo.summary.families.tool).toBe(1);

      // Bare YYYY-MM-DD `to` bound excludes `YYYY-MM-DDT...` timestamps in `occurred_at <= to`
      const bareDateTo = await dispatchChronicle(host, 'query', {
        query: { to: '2026-07-24', order: 'desc', limit: 100 },
      });
      expect(bareDateTo.total).toBe(0);
      expect(bareDateTo.summary.completedTools).toBe(0);
      expect(bareDateTo.summary.failedTools).toBe(0);
      expect(bareDateTo.summary.families.tool).toBe(0);

      // Full-UTC-day bounds and unfiltered `{}` still use the metrics fast path
      const refreshesBeforeFastPath = metricsRefreshes;
      const fullDay = await dispatchChronicle(host, 'query', {
        query: {
          from: '2026-07-24T00:00:00.000Z',
          to: '2026-07-24T23:59:59.999Z',
          order: 'desc',
          limit: 100,
        },
      });
      const unfiltered = await dispatchChronicle(host, 'query', {
        query: { order: 'desc', limit: 100 },
      });
      expect(metricsRefreshes).toBe(refreshesBeforeFastPath + 2);
      expect(fullDay.total).toBe(2);
      expect(fullDay.summary.completedTools).toBe(1);
      expect(fullDay.summary.failedTools).toBe(1);
      expect(unfiltered.total).toBe(3);
      expect(unfiltered.summary.completedTools).toBe(2);
      expect(unfiltered.summary.failedTools).toBe(1);
    } finally {
      metricsStore.close();
      journal.close();
    }
  });
});
