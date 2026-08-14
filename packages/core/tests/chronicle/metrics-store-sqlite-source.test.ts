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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('does not double-count JSONL events once the legacy journal was migrated into SQLite', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-migrated-'));
    dirs.push(dir);

    // A leftover legacy partition that the one-shot import already moved into
    // the SQLite journal. It must NOT be folded again — that would double-count
    // every migrated event (2 SQLite events + 1 JSONL event = 3 with the bug).
    await writeFile(
      path.join(dir, '2026-08-13.events.jsonl'),
      `${JSON.stringify(
        input({
          eventType: 'tool.executed',
          outcome: 'success',
          occurredAt: '2026-08-13T10:00:00.000Z',
        }),
      )}\n`,
      'utf8',
    );

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());
    // Simulate the one-shot `importLegacyChronicleJournal` having run.
    journal.markLegacyJournalImported();

    const store = ChronicleMetricsStore.open(dir);
    const first = await store.refresh();
    expect(first.ingestedEvents).toBe(2);

    const second = await store.refresh();
    expect(second.ingestedEvents).toBe(0);

    store.close();
    journal.close();
  });

  it('rebuilds from SQLite when JSONL was aggregated before the legacy import ran', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-upgrade-'));
    dirs.push(dir);
    const today = new Date().toISOString().slice(0, 10);

    // 1. Legacy phase: JSONL partition only — the metrics store aggregates it.
    await writeFile(
      path.join(dir, `${today}.events.jsonl`),
      attempt()
        .map((event) => `${JSON.stringify({ ...event, occurredAt: `${today}T10:00:00.000Z` })}\n`)
        .join(''),
      'utf8',
    );
    const store = ChronicleMetricsStore.open(dir);
    const first = await store.refresh();
    expect(first.ingestedEvents).toBe(2);
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });

    // 2. The one-shot import copies the same events into the SQLite journal
    //    and records the migration marker.
    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());
    journal.markLegacyJournalImported();

    // 3. Next refresh must not replay the migrated history on top of the
    //    existing aggregates (attempts would become 2 without the rebuild).
    await store.refresh();
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });

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
