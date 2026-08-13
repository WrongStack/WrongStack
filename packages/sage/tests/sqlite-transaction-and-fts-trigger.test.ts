/**
 * Regression tests for two SQLite storage invariants that were previously
 * unenforced:
 *
 *  1. `runImmediateTransaction` must decide to COMMIT *after* `work()` has run
 *     — an abort raised during the work window has to roll back, and work that
 *     returns a thenable must be rejected rather than committed empty.
 *  2. The `memories_au` FTS trigger must re-index only when an indexed value
 *     (text / tags / audience) actually changed. Counter bookkeeping rewrites
 *     `data` on every injected memory every tool turn; without the WHEN guard
 *     each of those paid a full FTS delete+insert.
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteMutationQueue } from '../src/sqlite-store-mutation-queue.js';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let activeStores: SqliteSageStore[] = [];

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sqlite-tx-'));
  activeStores = [];
});

afterEach(async () => {
  for (const store of activeStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await new Promise((r) => setTimeout(r, 10));
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function trackStore(store: SqliteSageStore): SqliteSageStore {
  activeStores.push(store);
  return store;
}

describe('runImmediateTransaction commit boundary', () => {
  function scratchDb(): DatabaseSync {
    const db = new DatabaseSync(path.join(tempDir, 'scratch.db'));
    db.exec('CREATE TABLE t (v INTEGER)');
    return db;
  }

  it('rolls back when the signal aborts during work() instead of committing', async () => {
    const db = scratchDb();
    const queue = new SqliteMutationQueue();
    const ac = new AbortController();

    // Aborting from inside work() is the only way to move the signal during
    // the BEGIN..COMMIT window on a synchronous connection — and it is exactly
    // the window the pre-commit check exists to cover.
    await expect(
      queue.runLocked({
        db,
        lockPath: path.join(tempDir, 'scratch.lock'),
        work: () => {
          db.exec('INSERT INTO t (v) VALUES (1)');
          ac.abort();
          return 'unreachable-result';
        },
        signal: ac.signal,
      }),
    ).rejects.toThrow(/abort/i);

    const row = db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number };
    expect(row.n).toBe(0);
    db.close();
  });

  it('commits normally when the signal never aborts', async () => {
    const db = scratchDb();
    const queue = new SqliteMutationQueue();
    const ac = new AbortController();

    const result = await queue.runLocked({
      db,
      lockPath: path.join(tempDir, 'scratch.lock'),
      work: () => {
        db.exec('INSERT INTO t (v) VALUES (7)');
        return 'ok';
      },
      signal: ac.signal,
    });

    expect(result).toBe('ok');
    const row = db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number };
    expect(row.n).toBe(1);
    db.close();
  });

  it('rejects async work instead of committing a half-finished transaction', async () => {
    const db = scratchDb();
    const queue = new SqliteMutationQueue();

    await expect(
      queue.runLocked({
        db,
        lockPath: path.join(tempDir, 'scratch.lock'),
        work: () => Promise.resolve('late'),
      }),
    ).rejects.toThrow(/synchronous/i);

    // The rejection must leave no open transaction behind.
    expect(() => db.exec('BEGIN IMMEDIATE')).not.toThrow();
    db.exec('ROLLBACK');
    db.close();
  });
});

describe('memories_au FTS trigger guard', () => {
  /**
   * fts5 appends a segment to its `_data` shadow table on every
   * delete+insert pair, so the row count there is a direct observation of
   * whether the trigger fired.
   */
  function ftsSegmentCount(dbPath: string): number {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM memories_fts_data').get() as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  }

  it('does not re-index when a counter update leaves text/tags/audience unchanged', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const memory = await store.rememberSage({
      text: 'The retry budget for the mailbox bridge is three attempts',
      kind: 'fact',
    });
    const dbPath = path.join(tempDir, '.wrongstack', 'memories', 'sage.db');
    const before = ftsSegmentCount(dbPath);

    // recordInjection/recordUse json_set() counters into `data` — the column
    // the trigger reads text out of, but not the extracted value itself.
    for (let i = 0; i < 10; i++) {
      await store.recordInjection([memory.id], 'test_trigger');
      await store.recordUse([memory.id], 'test_source');
    }

    expect(ftsSegmentCount(dbPath)).toBe(before);

    // The counters still landed, and the memory is still searchable.
    const reloaded = await store.getSage(memory.id);
    expect(reloaded?.injectionCount).toBe(10);
    expect(reloaded?.useCount).toBe(10);
    const hits = await store.searchSage('mailbox bridge');
    expect(hits.map((h) => h.id)).toContain(memory.id);
  });

  it('still re-indexes when the memory text actually changes', async () => {
    const store = trackStore(new SqliteSageStore({ projectRoot: tempDir }));
    await store.initialize();
    const memory = await store.rememberSage({
      text: 'Original wording about kanban boundaries',
      kind: 'fact',
    });

    await store.updateSage(memory.id, { text: 'Rewritten wording about chronicle retention' });

    // Old terms must no longer match, new terms must.
    const stale = await store.searchSage('kanban boundaries');
    expect(stale.map((h) => h.id)).not.toContain(memory.id);
    const fresh = await store.searchSage('chronicle retention');
    expect(fresh.map((h) => h.id)).toContain(memory.id);
  });
});
