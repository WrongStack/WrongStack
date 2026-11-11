/**
 * Cost and token totals must survive the default `balanced` fold.
 *
 * At `balanced` (the default `chronicle.detail`) the counter sink folds every
 * `token.accounted` / `subagent.token_accounted` into one `metrics.counter`
 * aggregate per window and keeps the cumulative totals under `latest`. The
 * query summary and the metrics `token_cost` projection only recognized the
 * raw event names, so a default-configured project reported $0 and no
 * tokens on the Chronicle dashboard even though the aggregates were on disk.
 */
import { mkdtemp } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { createChronicleCounterSink } from '../src/counter-sink.js';
import type { ChronicleDetailLevel } from '../src/detail-policy.js';
import {
  ChronicleJournal,
  ChronicleMetricsStore,
  ChronicleQueryEngine,
  isChronicleMetricsAvailable,
} from '../src/index.js';
import type { ChronicleEventInput } from '../src/types.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs
      .splice(0)
      // Windows holds SQLite WAL sidecar handles briefly after close().
      .map((dir) => removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 200 })),
  ),
);

const scope = { installationId: 'i', machineId: 'm', projectId: 'p', sessionId: 's1' };

function accounted(
  total: number,
  output: number,
  overrides: Partial<ChronicleEventInput> = {},
): ChronicleEventInput {
  return {
    eventType: 'token.accounted',
    outcome: 'unknown',
    scope,
    correlation: { traceId: 't', spanId: 'sp' },
    runtime: { providerId: 'anthropic', modelId: 'claude-x' },
    attributes: {
      usage: { input: 1_000, output, cacheRead: 40, cacheWrite: 0 },
      deltaUsage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: { input: total / 2, output: total / 2, total },
    },
    ...overrides,
  };
}

async function record(
  level: ChronicleDetailLevel,
  inputs: readonly ChronicleEventInput[],
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `chronicle-fold-cost-${level}-`));
  dirs.push(dir);
  const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-11-10.events.jsonl') });
  const sink = createChronicleCounterSink({ inner: journal, level });
  for (const input of inputs) await sink.append(input);
  // dispose() drains the open window, exactly as wireChronicleSession does.
  await sink.dispose();
  await journal.flush();
  return dir;
}

async function querySummary(dir: string) {
  return (await (await ChronicleQueryEngine.fromDirectory(dir)).query({})).summary;
}

describe('token cost under the balanced fold', () => {
  it('matches the unfolded (full) cost: latest cumulative snapshot wins', async () => {
    const inputs = [accounted(0.01, 100), accounted(0.03, 300)];
    const full = await querySummary(await record('full', inputs));
    const folded = await record('balanced', inputs);
    const events = (await (await ChronicleQueryEngine.fromDirectory(folded)).query({})).events;
    expect(events.map((event) => event.eventType)).toEqual(['metrics.counter']);
    expect(full.estimatedCostUsd).toBeCloseTo(0.03, 10);
    expect((await querySummary(folded)).estimatedCostUsd).toBeCloseTo(0.03, 10);
  });

  it('keeps leader and subagent spend in separate scopes and sums them', async () => {
    const dir = await record('balanced', [
      accounted(0.02, 200),
      accounted(0.05, 500, {
        eventType: 'subagent.token_accounted',
        scope: { ...scope, agentId: 'worker-1' },
      }),
    ]);
    expect((await querySummary(dir)).estimatedCostUsd).toBeCloseTo(0.07, 10);
  });

  it('ignores counters that are not token snapshots', async () => {
    const dir = await record('balanced', [
      {
        eventType: 'permission.evaluated',
        outcome: 'success',
        scope,
        correlation: { traceId: 't', spanId: 'sp' },
        attributes: {
          toolName: 'grep',
          policyDecision: 'auto',
          effectiveDecision: 'auto',
          // A numeric field an unrelated counter could plausibly carry.
          cost: { total: 9 },
        },
      },
    ]);
    expect((await querySummary(dir)).estimatedCostUsd).toBe(0);
  });

  it.skipIf(!isChronicleMetricsAvailable())(
    'feeds the metrics token_cost projection behind the dashboard default view',
    async () => {
      const dir = await record('balanced', [
        accounted(0.01, 100),
        accounted(0.03, 300),
        accounted(0.05, 500, {
          eventType: 'subagent.token_accounted',
          scope: { ...scope, agentId: 'worker-1' },
        }),
      ]);
      const store = ChronicleMetricsStore.open(dir);
      try {
        await store.refresh();
        expect(store.defaultSummary().estimatedCostUsd).toBeCloseTo(0.08, 10);
        expect(store.summary().estimatedCostUsd).toBeCloseTo(0.08, 10);
        const rows = (
          store as unknown as {
            db: { prepare(sql: string): { all(): unknown[] } };
          }
        ).db
          .prepare('SELECT output_tokens, cache_read_tokens FROM token_cost ORDER BY output_tokens')
          .all();
        expect(rows).toEqual([
          { output_tokens: 300, cache_read_tokens: 40 },
          { output_tokens: 500, cache_read_tokens: 40 },
        ]);
      } finally {
        store.close();
      }
    },
  );
});
