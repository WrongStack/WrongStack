/**
 * The metrics store must read the SQLite journal, not only the legacy JSONL
 * partitions.
 *
 * `refresh()` was written against the partition files and tracked a byte offset
 * per file. When the journal moved to SQLite those files stopped existing, so
 * `findChroniclePartitions` returned an empty list and every refresh ingested
 * nothing — silently, with no error and no degraded signal. Measured on a live
 * install before this fix: all aggregate tables at zero rows while the journal
 * held 100 000 events, so `wstack chronicle metrics` and the WebUI reliability
 * strip were rendering an empty projection that looked like "no activity".
 */
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChronicleMetricsStore, isChronicleMetricsAvailable } from '../../src/chronicle/index.js';
import { ChronicleSqliteJournal } from '../../src/chronicle/sqlite-journal.js';
import type { ChronicleEventInput } from '../../src/chronicle/types.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  ),
);

const scope = { installationId: 'i', machineId: 'm', projectId: 'p', sessionId: 'sess-1' };
const correlation = { traceId: 't', spanId: 'sp' };
const runtime = { providerId: 'openai', modelId: 'model-a' };

function input(
  partial: Partial<ChronicleEventInput> & Pick<ChronicleEventInput, 'eventType'>,
): ChronicleEventInput {
  return { scope, correlation, ...partial };
}

const attempt = (): ChronicleEventInput[] => [
  input({ eventType: 'provider.attempt.started', runtime, outcome: 'started' }),
  input({
    eventType: 'provider.attempt.completed',
    runtime,
    outcome: 'success',
    durationNs: '2000000000',
    attributes: { inputTokens: 10, outputTokens: 5 },
  }),
];

describe.skipIf(!isChronicleMetricsAvailable())('metrics store over the SQLite journal', () => {
  it('ingests the SQLite journal and does not re-count it on the next refresh', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-sqlite-'));
    dirs.push(dir);

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());

    const store = ChronicleMetricsStore.open(dir);
    const first = await store.refresh();
    expect(first.ingestedEvents).toBe(2);

    const afterFirst = store.providerDaily();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      providerId: 'openai',
      modelId: 'model-a',
      attempts: 1,
      completed: 1,
    });

    // Nothing new appended: a second refresh must be a no-op, not a re-fold.
    // The cursor lives in `ingest_state` under a `sqlite:` key, which
    // `pruneOffsets` deliberately skips — without that skip the cursor is wiped
    // every refresh and the whole journal is counted again.
    const second = await store.refresh();
    expect(second.ingestedEvents).toBe(0);
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });

    // New events fold in on top of the existing aggregate.
    await journal.appendBatch(attempt());
    const third = await store.refresh();
    expect(third.ingestedEvents).toBe(2);
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 2, completed: 2 });

    store.close();
    journal.close();
  });

  it('survives a chronicle directory with no SQLite journal at all', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-empty-'));
    dirs.push(dir);
    const store = ChronicleMetricsStore.open(dir);
    const result = await store.refresh();
    expect(result.ingestedEvents).toBe(0);
    expect(store.providerDaily()).toHaveLength(0);
    store.close();
  });
});
