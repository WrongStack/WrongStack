/**
 * `metrics.db` is a derived cache with two very different kinds of table, and
 * the whole data diet rests on treating them differently: daily aggregates are
 * cheap and permanent, per-event rows are expensive and temporary.
 *
 * Measured on a live install before this landed: 31k `file_lineage` rows and
 * 32k `logical_request_daily` rows against 48 rows of `provider_daily` covering
 * the same period, none of them ever pruned -- and a 220 MB file holding 18 MB
 * of live data because a schema bump dropped every table without returning a
 * single page.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureMetricsSchema,
  loadDatabaseSync,
  pruneMetricsRowDetail,
} from '../../src/chronicle/metrics-schema.js';
import { ensureIncrementalVacuum } from '../../src/chronicle/sqlite-journal-schema.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-metrics-retention-'));
  dirs.push(dir);
  return dir;
}

function open(dir: string) {
  const Database = loadDatabaseSync();
  const db = new Database(path.join(dir, 'metrics.db'));
  ensureIncrementalVacuum(db);
  db.exec('PRAGMA journal_mode = WAL');
  ensureMetricsSchema(db);
  return db;
}

describe('metrics row-detail retention', () => {
  it('drops aged per-event rows and keeps every daily aggregate', async () => {
    const db = open(await scratch());
    // file_lineage dates rows by occurred_at, not day; ISO-8601 sorts
    // lexicographically, so it still compares against a YYYY-MM-DD cutoff.
    const lineage = db.prepare(
      `INSERT INTO file_lineage (event_id, path_key, path, operation, occurred_at)
       VALUES (?, ?, ?, 'write', ?)`,
    );
    for (const day of ['2026-01-01', '2026-06-01']) {
      lineage.run(`e-${day}`, `src/a-${day}.ts`, `src/a-${day}.ts`, `${day}T00:00:00.000Z`);
      db.prepare('INSERT INTO logical_request_daily (day, logical_request_id) VALUES (?, ?)').run(
        day,
        `lr-${day}`,
      );
      db.prepare('INSERT INTO file_seen_daily (day, path_key) VALUES (?, ?)').run(day, `p-${day}`);
      db.prepare(
        `INSERT INTO provider_daily (day, provider_id, model_id) VALUES (?, 'p', 'm')`,
      ).run(day);
      db.prepare('INSERT INTO family_daily (day, family) VALUES (?, ?)').run(day, 'tool');
    }

    // Newest row is 2026-06-01, so a 60-day window cuts at 2026-04-02 and the
    // January rows fall outside it. Measured from the data, not the clock:
    // a project left alone for months can still answer what changed in it.
    const deleted = pruneMetricsRowDetail(db, 60);
    // One row from each of the two per-event tables.
    expect(deleted).toBe(2);

    const count = (table: string): number =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    expect(count('file_lineage')).toBe(1);
    expect(count('logical_request_daily')).toBe(1);
    // Left alone on purpose: summary() counts DISTINCT path_key over
    // file_seen_daily, so pruning it would change a historical number rather
    // than drop redundancy.
    expect(count('file_seen_daily')).toBe(2);
    // The aggregates are why this store outlives the raw journal at all.
    expect(count('provider_daily')).toBe(2);
    expect(count('family_daily')).toBe(2);
    db.close();
  });

  it('is a no-op when nothing has aged out', async () => {
    const db = open(await scratch());
    db.prepare(
      `INSERT INTO file_lineage (event_id, path_key, path, operation, occurred_at)
       VALUES ('e1', 'a', 'a', 'write', '2026-06-01T00:00:00.000Z')`,
    ).run();
    expect(pruneMetricsRowDetail(db, 3650)).toBe(0);
    expect(
      Number((db.prepare('SELECT COUNT(*) AS n FROM file_lineage').get() as { n: number }).n),
    ).toBe(1);
    db.close();
  });
});

describe('metrics schema reset', () => {
  it('returns the file to the filesystem when a schema bump discards the corpus', async () => {
    const dir = await scratch();
    const dbPath = path.join(dir, 'metrics.db');
    let db = open(dir);

    // Incompressible-ish bulk, enough that the file is measurably large.
    const insert = db.prepare(
      `INSERT INTO file_lineage (event_id, path_key, path, operation, occurred_at)
       VALUES (?, ?, ?, 'write', '2026-06-01T00:00:00.000Z')`,
    );
    db.exec('BEGIN');
    for (let index = 0; index < 20_000; index += 1) {
      const key = `packages/core/src/very/long/path/segment/number/${index}/module-${index}.ts`;
      insert.run(`event-${index}`, key, key);
    }
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    const grownBytes = (await fs.stat(dbPath)).size;
    expect(grownBytes).toBeGreaterThan(1024 * 1024);

    // Simulate the next release bumping SCHEMA_VERSION: ensureMetricsSchema
    // drops every table. Without the VACUUM that follows, those pages sit on
    // the freelist for the life of the file.
    const Database = loadDatabaseSync();
    db = new Database(dbPath);
    db.exec('PRAGMA user_version = 1');
    ensureMetricsSchema(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    expect((await fs.stat(dbPath)).size).toBeLessThan(grownBytes / 2);
  });
});
