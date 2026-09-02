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
import { loadDatabaseSync } from '../../src/chronicle/metrics-schema.js';
import {
  ChronicleSqliteJournal,
  LEGACY_JSONL_BOUNDARY_KEY,
} from '../../src/chronicle/sqlite-journal.js';
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

  it('keeps folding quarantined JSONL families after the legacy import ran', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-quarantine-'));
    dirs.push(dir);
    const today = new Date().toISOString().slice(0, 10);
    const quarantinedDay = '2026-08-12';

    // The quarantined family exists only in JSONL (its chain broke at import
    // time, so the import refused it) — it must keep folding even though the
    // migration marker is set.
    await writeFile(
      path.join(dir, `${quarantinedDay}.events.jsonl`),
      `${JSON.stringify(
        input({
          eventType: 'provider.attempt.started',
          runtime: { providerId: 'anthropic', modelId: 'claude' },
          outcome: 'started',
          occurredAt: `${quarantinedDay}T10:00:00.000Z`,
        }),
      )}\n`,
      'utf8',
    );

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());
    journal.markLegacyJournalImported();
    // The boundary map covers only the imported partition file — the
    // quarantined day has no entry and stays JSONL-authoritative.
    journal.recordLegacyJsonlBoundary({ [`${today}.events.jsonl`]: 0 });

    const store = ChronicleMetricsStore.open(dir);
    const result = await store.refresh();
    expect(result.ingestedEvents).toBe(3); // 2 from SQLite + 1 quarantined from JSONL
    expect(store.providerDaily()).toHaveLength(2);
    store.close();
    journal.close();
  });

  it('rebuilds the projection even when sqlite cursors already exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-mixed-'));
    dirs.push(dir);
    const today = new Date().toISOString().slice(0, 10);

    // Pre-migration phase: JSONL folded into the metrics projection.
    await writeFile(
      path.join(dir, `${today}.events.jsonl`),
      attempt()
        .map((event) => `${JSON.stringify({ ...event, occurredAt: `${today}T10:00:00.000Z` })}\n`)
        .join(''),
      'utf8',
    );
    const store = ChronicleMetricsStore.open(dir);
    await store.refresh();
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });

    // Migration + a pre-fix refresh that also folded SQLite (fake sqlite cursor).
    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());
    journal.markLegacyJournalImported();
    const metricsDb = new (loadDatabaseSync())(path.join(dir, 'metrics.db'));
    metricsDb
      .prepare('INSERT INTO ingest_state (file, bytes) VALUES (?, ?)')
      .run(`sqlite:${today}`, 1);
    metricsDb.close();

    // A positive sqlite cursor must NOT suppress the rebuild: the projection
    // already holds the pre-migration JSONL counts, so a plain SQLite fold
    // would double them.
    await store.refresh();
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });
    store.close();
    journal.close();
  });

  it('ingests JSONL appends written after the migration via the jsonl-store fallback', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-fallback-'));
    dirs.push(dir);
    const today = new Date().toISOString().slice(0, 10);

    const migratedEvent = input({
      eventType: 'provider.attempt.started',
      runtime: { providerId: 'openai', modelId: 'model-a' },
      outcome: 'started',
      occurredAt: `${today}T10:00:00.000Z`,
    });
    const migratedLine = `${JSON.stringify(migratedEvent)}\n`;

    // The partition holds the migrated event; the journal holds the same
    // events; the boundary records the partition's size at import time.
    await writeFile(path.join(dir, `${today}.events.jsonl`), migratedLine, 'utf8');
    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());
    journal.markLegacyJournalImported();
    journal.recordLegacyJsonlBoundary({
      [`${today}.events.jsonl`]: Buffer.byteLength(migratedLine, 'utf8'),
    });

    const store = ChronicleMetricsStore.open(dir);
    await store.refresh();
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });

    // The operator switches to the jsonl store: a new event appends beyond the
    // import boundary and must be folded, not skipped forever.
    const appendedEvent = input({
      eventType: 'provider.attempt.started',
      runtime: { providerId: 'openai', modelId: 'model-a' },
      outcome: 'started',
      occurredAt: `${today}T11:00:00.000Z`,
    });
    await writeFile(
      path.join(dir, `${today}.events.jsonl`),
      migratedLine + `${JSON.stringify(appendedEvent)}\n`,
      'utf8',
    );

    const second = await store.refresh();
    expect(second.ingestedEvents).toBe(1);
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 2, completed: 1 });

    store.close();
    journal.close();
  });

  it('folds quarantined families when the boundary row is empty (all families quarantined)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-all-quarantine-'));
    dirs.push(dir);
    const quarantinedDay = '2026-08-12';

    await writeFile(
      path.join(dir, `${quarantinedDay}.events.jsonl`),
      `${JSON.stringify(
        input({
          eventType: 'provider.attempt.started',
          runtime: { providerId: 'anthropic', modelId: 'claude' },
          outcome: 'started',
          occurredAt: `${quarantinedDay}T10:00:00.000Z`,
        }),
      )}\n`,
      'utf8',
    );

    // Migration ran but quarantined every family: the marker is set and the
    // boundary row exists but is EMPTY — the ingester must still fold the
    // JSONL (a boundary row that is absent would mean a pre-boundary migration
    // and skip the partitions entirely).
    const journal = new ChronicleSqliteJournal({ directory: dir });
    journal.markLegacyJournalImported();
    journal.recordLegacyJsonlBoundary({});

    const store = ChronicleMetricsStore.open(dir);
    const result = await store.refresh();
    expect(result.ingestedEvents).toBe(1);
    expect(store.providerDaily()).toHaveLength(1);
    store.close();
    journal.close();
  });

  it('does not rebuild away a jsonl-store fallback append on a fresh post-migration db', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-fresh-marker-'));
    dirs.push(dir);
    const today = new Date().toISOString().slice(0, 10);

    const migratedEvent = input({
      eventType: 'provider.attempt.started',
      runtime: { providerId: 'openai', modelId: 'model-a' },
      outcome: 'started',
      occurredAt: `${today}T10:00:00.000Z`,
    });
    const migratedLine = `${JSON.stringify(migratedEvent)}\n`;
    await writeFile(path.join(dir, `${today}.events.jsonl`), migratedLine, 'utf8');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());
    journal.markLegacyJournalImported();
    journal.recordLegacyJsonlBoundary({
      [`${today}.events.jsonl`]: Buffer.byteLength(migratedLine, 'utf8'),
    });

    const store = ChronicleMetricsStore.open(dir);
    await store.refresh(); // fresh db: SQLite fold + rebuild marker
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });

    const appendedEvent = input({
      eventType: 'provider.attempt.started',
      runtime: { providerId: 'openai', modelId: 'model-a' },
      outcome: 'started',
      occurredAt: `${today}T11:00:00.000Z`,
    });
    await writeFile(
      path.join(dir, `${today}.events.jsonl`),
      migratedLine + `${JSON.stringify(appendedEvent)}\n`,
      'utf8',
    );
    await store.refresh(); // fallback append folded from JSONL
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 2, completed: 1 });

    // Without the marker written after the first post-migration fold, this
    // third refresh would misread the fallback offset as pre-migration
    // progress and rebuild — dropping the appended event via the retained
    // in-memory offset.
    await store.refresh();
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 2, completed: 1 });
    store.close();
    journal.close();
  });

  it('folds a post-migration append to the active rotation of a rotated family', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-rotated-'));
    dirs.push(dir);
    const today = new Date().toISOString().slice(0, 10);

    const started = input({
      eventType: 'provider.attempt.started',
      runtime: { providerId: 'openai', modelId: 'model-a' },
      outcome: 'started',
      occurredAt: `${today}T10:00:00.000Z`,
    });
    const completed = input({
      eventType: 'provider.attempt.completed',
      runtime: { providerId: 'openai', modelId: 'model-a' },
      outcome: 'success',
      durationNs: '2000000000',
      attributes: { inputTokens: 10, outputTokens: 5 },
      occurredAt: `${today}T10:00:01.000Z`,
    });
    const baseLine = `${JSON.stringify(started)}\n`;
    const rotationLine = `${JSON.stringify(completed)}\n`;
    await writeFile(path.join(dir, `${today}.events.jsonl`), baseLine, 'utf8');
    await writeFile(path.join(dir, `${today}.events.00001.jsonl`), rotationLine, 'utf8');

    const journal = new ChronicleSqliteJournal({ directory: dir });
    await journal.appendBatch(attempt());
    journal.markLegacyJournalImported();
    journal.recordLegacyJsonlBoundary({
      [`${today}.events.jsonl`]: Buffer.byteLength(baseLine, 'utf8'),
      [`${today}.events.00001.jsonl`]: Buffer.byteLength(rotationLine, 'utf8'),
    });

    const store = ChronicleMetricsStore.open(dir);
    await store.refresh();
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 1, completed: 1 });

    // A post-migration append lands on the ACTIVE rotation (.00001). A
    // family-wide boundary total would over-skip it until it outgrew both files.
    const appended = input({
      eventType: 'provider.attempt.started',
      runtime: { providerId: 'openai', modelId: 'model-a' },
      outcome: 'started',
      occurredAt: `${today}T11:00:00.000Z`,
    });
    await writeFile(
      path.join(dir, `${today}.events.00001.jsonl`),
      rotationLine + `${JSON.stringify(appended)}\n`,
      'utf8',
    );
    await store.refresh();
    expect(store.providerDaily()[0]).toMatchObject({ attempts: 2, completed: 1 });
    store.close();
    journal.close();
  });

  it('merges per-file boundaries across resume runs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-merge-'));
    dirs.push(dir);
    const journal = new ChronicleSqliteJournal({ directory: dir });
    journal.recordLegacyJsonlBoundary({ 'a.events.jsonl': 10 });
    journal.recordLegacyJsonlBoundary({ 'b.events.jsonl': 20 });

    const db = new (loadDatabaseSync())(path.join(dir, 'chronicle.sqlite'), { readOnly: true });
    try {
      const row = db
        .prepare('SELECT value FROM chronicle_meta WHERE key = ?')
        .get(LEGACY_JSONL_BOUNDARY_KEY) as { value: string };
      expect(JSON.parse(row.value)).toEqual({ 'a.events.jsonl': 10, 'b.events.jsonl': 20 });
    } finally {
      db.close();
    }
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
