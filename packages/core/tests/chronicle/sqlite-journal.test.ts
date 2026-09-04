/**
 * Phase 1 of `chronicle-sqlite-journal-v1`.
 *
 * The load-bearing property is not "events round-trip" — it is that the chain
 * stays tamper-evident. Three failures have to be distinguishable: a hole in
 * `sequence`, a broken `previousHash` link, and an in-place payload edit that
 * left both intact. A store that only checked the links would call the third
 * one healthy.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENESIS_HASH } from '../../src/chronicle/event-hash.js';
import {
  CHRONICLE_SQLITE_FILE,
  ChronicleSqliteJournal,
  ChronicleStorageQuotaError,
} from '../../src/chronicle/sqlite-journal.js';
import {
  decodeChroniclePayload,
  encodeChroniclePayload,
  type StoredChroniclePayload,
} from '../../src/chronicle/payload-codec.js';
import { ensureChronicleSchema } from '../../src/chronicle/sqlite-journal-schema.js';
import type { ChronicleEventInput } from '../../src/chronicle/types.js';

let dir: string;
let journal: ChronicleSqliteJournal;

function input(overrides: Partial<ChronicleEventInput> = {}): ChronicleEventInput {
  return {
    eventType: 'tool.completed',
    scope: { installationId: 'inst', machineId: 'mach', sessionId: 'sess-1' },
    correlation: { traceId: 'trace-1', spanId: 'span-1' },
    outcome: 'success',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-sqlite-'));
  journal = new ChronicleSqliteJournal({ directory: dir });
});

afterEach(async () => {
  journal.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ChronicleSqliteJournal', () => {
  it('migrates a v2 journal to the indexed prompt-manifest projection', () => {
    const legacy = new DatabaseSync(':memory:');
    try {
      legacy.exec(`
        CREATE TABLE events (
          day TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
          hash TEXT NOT NULL, previous_hash TEXT NOT NULL, occurred_at TEXT NOT NULL,
          event_type TEXT NOT NULL, outcome TEXT, project_id TEXT, session_id TEXT,
          agent_id TEXT, task_id TEXT, trace_id TEXT, logical_request_id TEXT,
          resource_kind TEXT, resource_id TEXT, resource_path TEXT, duration_ns TEXT,
          payload TEXT NOT NULL, PRIMARY KEY (day, sequence)
        );
        PRAGMA user_version = 2;
      `);

      ensureChronicleSchema(legacy);

      const columns = legacy.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain('prompt_manifest_id');
      expect(
        (legacy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(3);
    } finally {
      legacy.close();
    }
  });

  it('anchors the first event at genesis and chains subsequent ones', async () => {
    const first = await journal.append(input());
    const second = await journal.append(input({ eventType: 'tool.started' }));

    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.hash);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2, lastSequence: 2 });
  });

  it('writes a batch as one transaction with a dense sequence', async () => {
    const events = await journal.appendBatch([input(), input(), input()]);

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events[1]?.previousHash).toBe(events[0]?.hash);
    expect(events[2]?.previousHash).toBe(events[1]?.hash);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('rebuilds the chain anchor from the database after a reopen', async () => {
    await journal.appendBatch([input(), input()]);
    journal.close();

    journal = new ChronicleSqliteJournal({ directory: dir });
    const third = await journal.append(input());

    expect(third.sequence).toBe(3);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('starts a fresh chain each day, mirroring the JSONL partition families', async () => {
    // `ChronicleJournal` anchors every `<day>.events.jsonl` family at genesis
    // independently, so `sequence` restarts daily. The SQLite store has to
    // reproduce that rather than impose one global chain, or imported history
    // would need re-hashing — which would destroy its tamper evidence.
    const monday = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2026-03-02T10:00:00.000Z'),
    });
    await monday.appendBatch([input(), input()]);
    monday.close();

    const tuesday = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2026-03-03T10:00:00.000Z'),
    });
    const first = await tuesday.append(input());
    tuesday.close();

    expect(first.sequence).toBe(1);
    expect(first.previousHash).toBe(GENESIS_HASH);

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('detects an in-place payload edit that leaves the links intact', async () => {
    await journal.appendBatch([input(), input(), input()]);

    // Rewrite one event's body without touching `hash`, `previous_hash` or
    // `sequence` — the shape of a tampered audit record.
    const db = openRaw(dir);
    const row = db.prepare('SELECT payload FROM events WHERE sequence = 2').get() as {
      payload: StoredChroniclePayload;
    };
    const tampered = {
      ...(JSON.parse(decodeChroniclePayload(row.payload)) as Record<string, unknown>),
      outcome: 'failure',
    };
    // Re-encoded, not written as plain text: a tamper that also downgraded the
    // storage format would be caught for the wrong reason.
    db.prepare('UPDATE events SET payload = ? WHERE sequence = 2').run(
      encodeChroniclePayload(JSON.stringify(tampered)),
    );
    db.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });

    expect(await journal.verify()).toMatchObject({ ok: false, reason: 'entry hash mismatch' });
  });

  it('detects a hole punched in the middle of the chain', async () => {
    await journal.appendBatch([input(), input(), input()]);

    const db = openRaw(dir);
    db.prepare('DELETE FROM events WHERE sequence = 2').run();
    db.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });

    const result = await journal.verify();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/sequence gap/u);
  });

  it('keeps the surviving events verifiable after a retention purge', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    const past = new ChronicleSqliteJournal({ directory: dir, now: () => old });
    await past.appendBatch([input(), input()]);
    past.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });
    const kept = await journal.append(input());

    const result = await journal.purge({ retentionDays: 30 });
    expect(result.deletedCount).toBe(2);

    // Purging removes whole day-chains, so the surviving day is untouched and
    // still starts at its own sequence 1 — there is no truncated prefix to
    // anchor and therefore no gap to report.
    expect(kept.sequence).toBe(1);
    const verified = await journal.verify();
    expect(verified).toMatchObject({ ok: true, entries: 1, lastSequence: 1 });
  });

  it('reports purge candidates without deleting in dry-run mode', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z');
    const past = new ChronicleSqliteJournal({ directory: dir, now: () => old });
    await past.appendBatch([input(), input()]);
    past.close();

    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir });

    expect(await journal.purge({ retentionDays: 30, dryRun: true })).toMatchObject({
      deletedCount: 2,
    });
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });
  });

  it('enforces configured retention no more than once per interval', async () => {
    const retentionNow = new Date('2026-02-01T00:00:00.000Z');
    const oldJournal = new ChronicleSqliteJournal({
      directory: dir,
      now: () => new Date('2025-12-01T00:00:00.000Z'),
    });
    await oldJournal.append(input({ correlation: { traceId: 'old', spanId: 'old' } }));
    oldJournal.close();

    journal.close();
    journal = new ChronicleSqliteJournal({
      directory: dir,
      retentionDays: 30,
      retentionCheckIntervalMs: 60 * 60 * 1_000,
      maxEvents: 2,
      now: () => retentionNow,
    });
    const purge = vi.spyOn(journal, 'purge');

    await journal.append(input({ correlation: { traceId: 'recent-1', spanId: 'recent-1' } }));
    await journal.append(input({ correlation: { traceId: 'recent-2', spanId: 'recent-2' } }));

    expect(purge).toHaveBeenCalledTimes(1);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });

    retentionNow.setTime(retentionNow.getTime() + 60 * 60 * 1_000);
    await journal.append(input({ correlation: { traceId: 'recent-3', spanId: 'recent-3' } }));
    expect(purge).toHaveBeenCalledTimes(2);
    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });
  });

  it('does not reject ingestion when best-effort retention fails', async () => {
    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir, retentionDays: 30 });
    vi.spyOn(journal, 'purge').mockRejectedValueOnce(new Error('maintenance failed'));

    await expect(journal.append(input())).resolves.toMatchObject({ sequence: 1 });
  });

  it('rejects invalid event ceilings', () => {
    journal.close();

    expect(
      () =>
        new ChronicleSqliteJournal({
          directory: dir,
          maxEvents: 0,
        }),
    ).toThrowError('maxEvents must be a positive integer');
    journal = new ChronicleSqliteJournal({ directory: dir });
  });

  it('caps retained events while preserving the newest verifiable chain', async () => {
    journal.close();
    journal = new ChronicleSqliteJournal({
      directory: dir,
      maxEvents: 3,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await journal.appendBatch([input(), input(), input(), input(), input()]);

    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
    const db = new DatabaseSync(path.join(dir, CHRONICLE_SQLITE_FILE));
    const rows = db.prepare('SELECT sequence FROM events ORDER BY day, sequence').all() as Array<{
      sequence: number;
    }>;
    db.close();
    expect(rows.map((row) => row.sequence)).toEqual([3, 4, 5]);
  });

  it('enforces the event ceiling when reopening an oversized database', async () => {
    await journal.appendBatch([input(), input(), input(), input()]);
    journal.close();
    journal = new ChronicleSqliteJournal({ directory: dir, maxEvents: 2 });

    expect(await journal.verify()).toMatchObject({ ok: true, entries: 2 });
  });

  it('keeps the event ceiling counter synchronized after a public purge', async () => {
    journal.close();
    // Written under a past clock so the retention window can actually reach
    // them — `purge` cuts off at `now - retentionDays`, never into the future.
    const old = new Date('2026-01-01T00:00:00.000Z');
    const past = new ChronicleSqliteJournal({ directory: dir, maxEvents: 3, now: () => old });
    await past.appendBatch([input(), input(), input()]);
    past.close();

    journal = new ChronicleSqliteJournal({ directory: dir, maxEvents: 3 });
    await journal.purge({ retentionDays: 30, dryRun: false });
    await journal.appendBatch([input(), input(), input()]);

    expect(await journal.verify()).toMatchObject({ ok: true, entries: 3 });
  });

  it('rejects invalid byte-retention policy configuration', () => {
    expect(
      () =>
        new ChronicleSqliteJournal({
          directory: path.join(dir, 'invalid-bytes'),
          maxBytes: 1024,
        }),
    ).toThrow(/maxBytes/);
    expect(
      () =>
        new ChronicleSqliteJournal({
          directory: path.join(dir, 'invalid-retention'),
          retentionDays: 1,
          retentionCheckIntervalMs: 0,
        }),
    ).toThrow(/retentionCheckIntervalMs/);
  });

  it('rolls back atomically with a typed error when the byte quota is exhausted', async () => {
    journal.close();
    journal = new ChronicleSqliteJournal({
      directory: dir,
      maxBytes: 17 * 1024 * 1024,
    });

    const payload = 'x'.repeat(64 * 1024);
    let rejected = false;
    for (let index = 0; index < 512; index += 1) {
      const before = await journal.verify();
      try {
        await journal.append(input({ attributes: { payload, index } }));
      } catch (error) {
        expect(error).toBeInstanceOf(ChronicleStorageQuotaError);
        expect(await journal.verify()).toEqual(before);
        rejected = true;
        break;
      }
    }

    expect(rejected).toBe(true);
  });

  /**
   * Regression: the quota used to measure the main database with `statSync`.
   *
   * SQLite parks freed pages on the freelist instead of returning them, so a
   * journal that once grew large keeps that file size forever. Measuring the
   * file therefore wedged ingestion permanently — a 3.9 GB file whose live
   * data was 243 MB failed a 512 MB quota on EVERY append, and the only
   * escape (`chronicle compact`) refuses to run while the daemon is up. The
   * quota must track live pages, which shrink when rows are deleted.
   */
  it('admits writes after deletions free pages, even though the file never shrinks', async () => {
    journal.close();
    const quotaDir = path.join(dir, 'freelist');
    await fs.mkdir(quotaDir, { recursive: true });
    // Incompressible: the payload codec squeezes a repeated character by two
    // orders of magnitude, and this test needs a file that genuinely outgrows
    // the quota it is about to be given.
    const payload = randomBytes(48 * 1024).toString('base64');

    // Pre-create the database so it is NOT in incremental-vacuum mode: that
    // pragma is only settable while a database is empty, and a small existing
    // one is deliberately left alone rather than paying a full VACUUM. This is
    // therefore a *legacy* journal, and the freelist behaviour this test exists
    // for is exactly what such a journal still does.
    const legacy = openRaw(quotaDir);
    ensureChronicleSchema(legacy);
    legacy.close();

    // Fill an unbounded journal well past the quota we are about to impose.
    const seed = new ChronicleSqliteJournal({ directory: quotaDir });
    for (let index = 0; index < 400; index += 1) {
      await seed.append(input({ attributes: { payload, index } }));
    }
    const dbPath = path.join(quotaDir, CHRONICLE_SQLITE_FILE);
    const grownBytes = (await fs.stat(dbPath)).size;

    // Delete almost everything. Rows go; the file keeps its high-water mark.
    const raw = openRaw(quotaDir);
    raw.exec('DELETE FROM events WHERE sequence > 5');
    raw.close();
    seed.close();

    const afterDeleteBytes = (await fs.stat(dbPath)).size;
    expect(afterDeleteBytes).toBeGreaterThanOrEqual(grownBytes);

    // A quota below the FILE size but above the LIVE size must still accept
    // writes. The old file-size check rejected every one of them.
    const quotaBytes = 17 * 1024 * 1024;
    expect(afterDeleteBytes).toBeGreaterThan(quotaBytes);

    journal = new ChronicleSqliteJournal({ directory: quotaDir, maxBytes: quotaBytes });
    await expect(
      journal.append(input({ attributes: { note: 'after-free' } })),
    ).resolves.toBeDefined();
  });

  /**
   * The other half of the same story: a journal created by this code returns
   * its freed pages instead of parking them forever.
   *
   * Measured on a live install before this landed: a 220 MB `metrics.db` whose
   * live data was 18 MB, and a 307 MB journal sitting at its `maxEvents`
   * ceiling that had evicted rows on nearly every append without the file ever
   * dropping. Retention that cannot shrink a file is retention in name only.
   */
  it('returns freed pages to the filesystem after a purge', async () => {
    journal.close();
    const shrinkDir = path.join(dir, 'shrink');
    await fs.mkdir(shrinkDir, { recursive: true });
    const payload = randomBytes(24 * 1024).toString('base64');
    const clock = { now: new Date('2026-01-20T00:00:00.000Z') };

    const seed = new ChronicleSqliteJournal({ directory: shrinkDir, now: () => clock.now });
    for (let index = 0; index < 200; index += 1) {
      await seed.append(input({ attributes: { payload, index } }));
    }
    // Close before measuring: in WAL mode the pages are still in the sidecar
    // until a checkpoint, so the main file would read as one page either way.
    seed.close();
    const dbPath = path.join(shrinkDir, CHRONICLE_SQLITE_FILE);
    const grownBytes = (await fs.stat(dbPath)).size;
    expect(grownBytes).toBeGreaterThan(4 * 1024 * 1024);

    // Age past the window so every row written above is purge-eligible.
    clock.now = new Date('2026-03-01T00:00:00.000Z');
    journal = new ChronicleSqliteJournal({ directory: shrinkDir, now: () => clock.now });
    const result = await journal.purge({ retentionDays: 7 });
    expect(result.deletedCount).toBe(200);
    // Payload bytes, not file bytes: the operator needs a number that says
    // something was actually shed. The old implementation returned a hardcoded
    // zero, so `chronicle prune` reported "Purged N entries (0 B)" forever.
    expect(result.deletedBytes).toBeGreaterThan(0);

    journal.close();
    expect((await fs.stat(dbPath)).size).toBeLessThan(grownBytes);
    journal = new ChronicleSqliteJournal({ directory: shrinkDir });
  });

  /**
   * Regression: `maxBytes` used to be split 50/50 between the main database
   * and rollback-journal headroom. At the shipped 512 MB quota that left the
   * main database 248 MB, which `maxEvents: 100_000` filled to 98.2% — the two
   * bounds collided and ingestion wedged. The reserve is now capped, so the
   * main database gets the share it needs while the aggregate ceiling is
   * unchanged.
   */
  it('gives the main database the bulk of a large quota', async () => {
    journal.close();
    const budgetDir = path.join(dir, 'budget');
    await fs.mkdir(budgetDir, { recursive: true });
    journal = new ChronicleSqliteJournal({
      directory: budgetDir,
      maxBytes: 512 * 1024 * 1024,
    });

    const raw = openRaw(budgetDir);
    const pageSize = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    raw.close();

    const maxPages = (journal as unknown as { db: DatabaseSync }).db
      .prepare('PRAGMA max_page_count')
      .get() as { max_page_count: number };

    // 512 MB - 16 MB fixed overhead - 32 MB capped WAL reserve = 464 MB.
    expect(maxPages.max_page_count * pageSize).toBe(464 * 1024 * 1024);
  });

  /**
   * The quota used to force DELETE mode so the rollback journal could be
   * budgeted, which made every append create, fsync and unlink a sidecar file.
   * WAL plus a bounded `journal_size_limit` gives the quota the same thing it
   * needed — a sidecar whose size is capped independently of the database — for
   * a fraction of the per-transaction cost.
   */
  it('runs in WAL mode with a bounded sidecar even under a byte quota', async () => {
    journal.close();
    const walDir = path.join(dir, 'wal-quota');
    await fs.mkdir(walDir, { recursive: true });
    journal = new ChronicleSqliteJournal({
      directory: walDir,
      maxBytes: 512 * 1024 * 1024,
    });
    await journal.append(input());

    const db = (journal as unknown as { db: DatabaseSync }).db;
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    );
    // NORMAL (1) is the default. In WAL mode it still survives a process crash
    // — the WAL is written before the commit returns — and only an OS crash or
    // power loss can cost the last commits. This is the highest-volume writer
    // in the runtime, so the per-commit fsync FULL adds was the largest single
    // source of disk I/O here; deployments that need power-loss durability for
    // the audit trail opt back in via `durability: 'full'` (asserted below).
    expect((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(1);
    const limit = (db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number })
      .journal_size_limit;
    expect(limit).toBe(16 * 1024 * 1024);
  });

  it('opts back into FULL durability when asked', async () => {
    const fullDir = path.join(dir, 'wal-full');
    await fs.mkdir(fullDir, { recursive: true });
    // Close the journal beforeEach opened at `dir` before replacing the shared
    // handle: on Windows an open SQLite connection holds its -shm file, and
    // afterEach's recursive rm of `dir` then fails with EBUSY.
    journal.close();
    journal = new ChronicleSqliteJournal({ directory: fullDir, durability: 'full' });
    await journal.append(input());

    const db = (journal as unknown as { db: DatabaseSync }).db;
    expect((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2);
  });

  /**
   * Eviction is the steady state of a journal at its ceiling, so running it on
   * every append meant paying a prefix delete plus an index update per secondary
   * index forever. The slack lets the table drift above `maxEvents` and cut back
   * in one pass — but only proportionally, so small ceilings keep the exact bound
   * they document.
   */
  it('amortises eviction for large ceilings and keeps small ones exact', async () => {
    journal.close();
    const exactDir = path.join(dir, 'trim-exact');
    await fs.mkdir(exactDir, { recursive: true });
    journal = new ChronicleSqliteJournal({ directory: exactDir, maxEvents: 3 });
    for (let i = 0; i < 8; i++) await journal.append(input());
    // 3 * 0.02 floors to 0: no slack, so the bound holds exactly.
    expect((await journal.readAll()).length).toBe(3);
    journal.close();

    const slackDir = path.join(dir, 'trim-slack');
    await fs.mkdir(slackDir, { recursive: true });
    journal = new ChronicleSqliteJournal({ directory: slackDir, maxEvents: 100 });
    for (let i = 0; i < 101; i++) await journal.append(input());
    // 100 * 0.02 = 2 slack, so 101 rows are still under the eviction trigger.
    expect((await journal.readAll()).length).toBe(101);
    for (let i = 0; i < 2; i++) await journal.append(input());
    // 103 > 100 + 2 trips it, and the cut lands on the ceiling itself.
    expect((await journal.readAll()).length).toBe(100);
    await expect(journal.verify()).resolves.toMatchObject({ ok: true });
  });

  it('projects only values that remain recoverable from the payload', async () => {
    await journal.append(
      input({
        scope: {
          installationId: 'inst',
          machineId: 'mach',
          sessionId: 'sess-9',
          agentId: 'agent-3',
        },
        resource: { kind: 'file', id: 'f1', path: 'src/a.ts' },
      }),
    );

    const db = openRaw(dir);
    const row = db
      .prepare('SELECT session_id, agent_id, resource_path, payload FROM events WHERE sequence = 1')
      .get() as {
      session_id: string;
      agent_id: string;
      resource_path: string;
      payload: StoredChroniclePayload;
    };
    db.close();

    const event = JSON.parse(decodeChroniclePayload(row.payload)) as {
      scope: { sessionId: string; agentId: string };
      resource: { path: string };
    };
    expect(row.session_id).toBe(event.scope.sessionId);
    expect(row.agent_id).toBe(event.scope.agentId);
    expect(row.resource_path).toBe(event.resource.path);
  });

  it('tracks the legacy import marker across reopens', async () => {
    expect(journal.hasImportedLegacyJournal()).toBe(false);
    journal.markLegacyJournalImported();
    journal.close();

    journal = new ChronicleSqliteJournal({ directory: dir });
    expect(journal.hasImportedLegacyJournal()).toBe(true);
  });
});

/** Direct handle used only to simulate tampering the journal API forbids. */
function openRaw(directory: string): DatabaseSync {
  return new DatabaseSync(path.join(directory, CHRONICLE_SQLITE_FILE));
}
