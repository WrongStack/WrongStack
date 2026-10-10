import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';
import { SqliteMutationQueue } from '../src/sqlite-store-mutation-queue.js';
import { SqliteStatementCache } from '../src/sqlite-store-statement-cache.js';

const DatabaseSync = loadRuntimeDatabaseSync();

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sage-cov-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('SqliteStatementCache LRU eviction', () => {
  it('evicts the oldest entry when at capacity', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    const cache = new SqliteStatementCache(2);
    cache.get(db, 'SELECT 1');
    cache.get(db, 'SELECT 2');
    cache.get(db, 'SELECT 3'); // evicts 'SELECT 1'
    // Re-request 'SELECT 1' — must re-prepare
    const originalPrepare = db.prepare;
    let prepareCount = 0;
    db.prepare = ((sql: string) => {
      prepareCount++;
      return originalPrepare.call(db, sql);
    }) as typeof originalPrepare;
    cache.get(db, 'SELECT 1');
    expect(prepareCount).toBe(1);
    db.close();
  });

  it('promotes recently accessed entries (LRU update on hit)', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    const cache = new SqliteStatementCache(2);
    cache.get(db, 'SELECT 1');
    cache.get(db, 'SELECT 2');
    cache.get(db, 'SELECT 1'); // promotes 'SELECT 1'
    cache.get(db, 'SELECT 3'); // evicts 'SELECT 2'
    // 'SELECT 1' should still be cached
    const originalPrepare = db.prepare;
    let prepareCount = 0;
    db.prepare = ((sql: string) => {
      prepareCount++;
      return originalPrepare.call(db, sql);
    }) as typeof originalPrepare;
    cache.get(db, 'SELECT 1');
    expect(prepareCount).toBe(0);
    db.close();
  });

  it('clear() removes all cached entries', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    const cache = new SqliteStatementCache(5);
    cache.get(db, 'SELECT 1');
    cache.get(db, 'SELECT 2');
    cache.clear();
    const originalPrepare = db.prepare;
    let prepareCount = 0;
    db.prepare = ((sql: string) => {
      prepareCount++;
      return originalPrepare.call(db, sql);
    }) as typeof originalPrepare;
    cache.get(db, 'SELECT 1');
    expect(prepareCount).toBe(1);
    db.close();
  });
});

describe('SqliteMutationQueue error recovery', () => {
  it('recovers from a rejected runLocked chain', async () => {
    const dbPath = path.join(directory, 'mq-test.db');
    const lockPath = path.join(directory, 'mq-test.lock');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t (v INTEGER)');
    const queue = new SqliteMutationQueue();

    // First runLocked that rejects
    await queue
      .runLocked({
        db,
        lockPath,
        work: () => {
          throw new Error('boom');
        },
      })
      .catch(() => {});

    // Second runLocked should still work
    const result = await queue.runLocked({ db, lockPath, work: () => 'ok' });
    expect(result).toBe('ok');

    await queue.drain();
    db.close();
  });

  it('runLocked propagates success through normal chain', async () => {
    const dbPath = path.join(directory, 'mq-test2.db');
    const lockPath = path.join(directory, 'mq-test2.lock');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE t (v INTEGER)');
    const queue = new SqliteMutationQueue();

    const result = await queue.runLocked({
      db,
      lockPath,
      work: () => {
        db.prepare('INSERT INTO t VALUES (?)').run(42);
        return 'inserted';
      },
    });
    expect(result).toBe('inserted');

    await queue.drain();
    db.close();
  });
});

describe('Migration error path (ROLLBACK + throw)', () => {
  it('migrates v3→v4 when legacy_scope column already exists', async () => {
    const root = path.join(directory, '.wrongstack', 'memories');
    await fs.mkdir(root, { recursive: true });
    const dbPath = path.join(root, 'sage.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', 3);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        freshness REAL NOT NULL,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        audience TEXT,
        tags TEXT,
        canonical_text TEXT NOT NULL DEFAULT '',
        legacy_scope TEXT
      );
      -- Same reason as edges below: the fixture pre-creates this table, so the
      -- real DDL never applies and the index on (status, created_at) needs the
      -- column to be here.
      CREATE TABLE candidates (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        canonical_text TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE injection_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        trace_id TEXT,
        memory_id TEXT NOT NULL,
        score REAL NOT NULL,
        rank INTEGER NOT NULL,
        reason TEXT
      );
      -- Must match the real edges shape (from_node/to_node/relation), not an
      -- invented one: CREATE TABLE IF NOT EXISTS is a no-op against an existing
      -- table, so a fixture with source/target columns survives untouched and
      -- the following CREATE INDEX ON edges(from_node) dies with
      -- "no such column". The old fixture had exactly that shape and nobody
      -- noticed, because the test never ran the migration it is named for.
      CREATE TABLE edges (
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_node, to_node, relation)
      );
      CREATE TABLE anchor_map (
        anchor_key TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        PRIMARY KEY (anchor_key, memory_id)
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        text, tags, audience, content='memories', content_rowid='rowid'
      );
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_status_canonical ON candidates(status, canonical_text);
    `);
    db.close();

    // v4 migration should succeed (legacy_scope already exists). This comment
    // WAS the whole assertion — nothing checked it, so a migration that threw
    // and rolled back, or that never advanced the version, passed identically.
    const store = new SqliteSageStore({ projectRoot: directory });
    // `initialize()` is what opens the database and runs the migration chain —
    // the constructor alone does not. Without this call the test never reached
    // the v3→v4 path it is named for: the version was still 3 at the end, and
    // because nothing was asserted, that went unnoticed.
    await store.initialize();
    store.close();

    const after = new DatabaseSync(dbPath);
    const version = after.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: number }
      | undefined;
    after.close();

    // The point of the "column already exists" case: the ADD COLUMN is skipped
    // rather than fatal, so the version still moves past 3.
    expect(version?.value).toBeGreaterThan(3);
  });
});
