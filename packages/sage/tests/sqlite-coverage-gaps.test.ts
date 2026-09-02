import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStatementCache } from '../src/sqlite-store-statement-cache.js';
import { SqliteMutationQueue } from '../src/sqlite-store-mutation-queue.js';
import { SqliteSageStore } from '../src/sqlite-store.js';

const require = createRequire(import.meta.url);
const DatabaseSync = require('node:sqlite').DatabaseSync as typeof DatabaseSyncType;

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
      CREATE TABLE candidates (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
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
      CREATE TABLE edges (
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (source, target, edge_type)
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

    // v4 migration should succeed (legacy_scope already exists)
    const store = new SqliteSageStore({ projectRoot: directory });
    store.close();
  });
});
