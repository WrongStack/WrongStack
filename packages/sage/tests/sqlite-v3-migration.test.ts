import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

// Lazy-loader for node:sqlite — matches the pattern in sage, techstack, and the
// codebase-index rather than a top-level value import that would fire Node's
// ExperimentalWarning at module evaluation time (the vitest setup suppresses it
// anyway, but keeping all SQLite loads behind a lazy gate is the project convention).
// DatabaseSync comes from a `type` import — stripped at compile time, no warning.
const _require = createRequire(import.meta.url);
function loadDatabaseSync(): typeof DatabaseSync {
  return _require('node:sqlite').DatabaseSync as typeof DatabaseSync;
}

describe('SqliteSageStore v3 migration', () => {
  let tempDir: string;
  let store: SqliteSageStore | undefined;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sqlite-v3-'));
  });

  afterEach(async () => {
    store?.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('opens a v2 database before creating indexes that require v3 columns', async () => {
    const memoryDir = path.join(tempDir, '.wrongstack', 'memories');
    const dbPath = path.join(memoryDir, 'sage.db');
    await fs.promises.mkdir(memoryDir, { recursive: true });

    const DatabaseSync = loadDatabaseSync();
    const v2 = new DatabaseSync(dbPath);
    v2.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT INTO schema_meta (key, value) VALUES ('version', 2);

      CREATE TABLE candidates (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO candidates (id, data, status, created_at, updated_at) VALUES
        ('valid', '{"text":"  Candidate   Text "}', 'pending', '2026', '2026'),
        ('missing-text', '{}', 'pending', '2026', '2026'),
        ('broken', '{broken', 'pending', '2026', '2026');
    `);
    v2.close();

    store = new SqliteSageStore({ projectRoot: tempDir });
    await expect(store.initialize()).resolves.toBeUndefined();

    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    const candidateColumns = migrated.prepare('PRAGMA table_info(candidates)').all() as Array<{
      name: string;
    }>;
    const candidateIndexes = migrated.prepare('PRAGMA index_list(candidates)').all() as Array<{
      name: string;
    }>;
    const version = migrated
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: number };
    migrated.close();

    expect(candidateColumns.map((column) => column.name)).toContain('canonical_text');
    expect(candidateIndexes.map((index) => index.name)).toContain(
      'idx_candidates_status_canonical',
    );
    expect(version.value).toBe(5);
  });

  it('opens a v3 database containing a malformed active memory row', async () => {
    const memoryDir = path.join(tempDir, '.wrongstack', 'memories');
    const dbPath = path.join(memoryDir, 'sage.db');
    await fs.promises.mkdir(memoryDir, { recursive: true });

    const DatabaseSync = loadDatabaseSync();
    const v3 = new DatabaseSync(dbPath);
    v3.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
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
        canonical_text TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO memories (
        id, data, status, kind, scope, importance, confidence, freshness,
        updated_at, created_at, canonical_text
      ) VALUES (
        'broken-active', '{broken', 'active', 'fact', 'project', 0.8, 0.9, 1,
        '2026', '2026', ''
      );
    `);
    v3.close();

    store = new SqliteSageStore({ projectRoot: tempDir });
    await expect(store.initialize()).resolves.toBeUndefined();

    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    const version = migrated
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: number };
    const broken = migrated
      .prepare("SELECT legacy_scope FROM memories WHERE id = 'broken-active'")
      .get() as { legacy_scope: string | null };
    const updateTrigger = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'memories_au'")
      .get() as { name: string } | undefined;
    migrated.close();

    expect(updateTrigger?.name).toBe('memories_au');
    expect(version.value).toBe(5);
    expect(broken.legacy_scope).toBeNull();
  });

  it('rolls back a v3 migration when a dependent index cannot be created', async () => {
    const memoryDir = path.join(tempDir, '.wrongstack', 'memories');
    const dbPath = path.join(memoryDir, 'sage.db');
    await fs.promises.mkdir(memoryDir, { recursive: true });

    const DatabaseSync = loadDatabaseSync();
    const v2 = new DatabaseSync(dbPath);
    v2.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT INTO schema_meta (key, value) VALUES ('version', 2);
      CREATE TABLE candidates (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE idx_candidates_status_canonical (value TEXT);
    `);
    v2.close();

    store = new SqliteSageStore({ projectRoot: tempDir });
    await expect(store.initialize()).rejects.toThrow(/already a table/i);

    const rolledBack = new DatabaseSync(dbPath, { readOnly: true });
    const columns = rolledBack.prepare('PRAGMA table_info(candidates)').all() as Array<{
      name: string;
    }>;
    const version = rolledBack
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: number };
    rolledBack.close();
    expect(columns.map((column) => column.name)).not.toContain('canonical_text');
    expect(version.value).toBe(2);
  });
});
