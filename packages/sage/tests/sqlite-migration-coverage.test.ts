import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';
import type { Sage } from '../src/types.js';

const require = createRequire(import.meta.url);
const DatabaseSync = require('node:sqlite').DatabaseSync as typeof DatabaseSyncType;

let directory: string;
let stores: SqliteSageStore[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sage-migration-'));
  stores = [];
});

afterEach(async () => {
  for (const store of stores) store.close();
  await fs.rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function store(): SqliteSageStore {
  const value = new SqliteSageStore({ projectRoot: directory });
  stores.push(value);
  return value;
}

function memory(id: string, overrides: Partial<Sage> = {}): Sage {
  return {
    id,
    revision: 1,
    status: 'active',
    kind: 'fact',
    scope: 'project',
    text: `memory ${id}`,
    importance: 0.8,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function memoryRecord(value: Sage): object {
  return { recordType: 'memory', schemaVersion: 1, op: 'update', memory: value };
}

async function writeJsonl(relative: string, rows: Array<object | string>): Promise<void> {
  const file = path.join(directory, '.wrongstack', 'memories', relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`,
  );
}

describe('SQLite migration completion coverage', () => {
  it('upgrades a populated v1 database and backfills canonical memory text', async () => {
    const root = path.join(directory, '.wrongstack', 'memories');
    await fs.mkdir(root, { recursive: true });
    const db = new DatabaseSync(path.join(root, 'sage.db'));
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', 1);
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
        tags TEXT
      );
    `);
    const seeded = memory('v1', {
      text: '  Canonical   V1 ',
      anchors: [{ type: 'file', path: 'src/v1.ts' }],
    });
    db.prepare(
      `INSERT INTO memories
        (id, data, status, kind, scope, importance, confidence, freshness,
         updated_at, created_at, audience, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seeded.id,
      JSON.stringify(seeded),
      seeded.status,
      seeded.kind,
      seeded.scope,
      seeded.importance,
      seeded.confidence,
      seeded.freshness,
      seeded.updatedAt,
      seeded.createdAt,
      null,
      '[]',
    );
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        text, tags, audience, content='memories', content_rowid='rowid'
      );
      INSERT INTO memories_fts(rowid, text, tags, audience)
      SELECT rowid, json_extract(data, '$.text'), tags, audience FROM memories;
    `);
    db.close();

    const value = store();
    await value.initialize();
    const migrated = (value as unknown as { db: DatabaseSyncType }).db;
    expect(
      (
        migrated.prepare('SELECT canonical_text AS value FROM memories WHERE id = ?').get('v1') as {
          value: string;
        }
      ).value,
    ).toBe('canonical v1');
    expect(
      (
        migrated.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
          value: number;
        }
      ).value,
    ).toBe(5);
  });

  it('recovers a partially upgraded v1 database that already has canonical_text', async () => {
    const root = path.join(directory, '.wrongstack', 'memories');
    await fs.mkdir(root, { recursive: true });
    const db = new DatabaseSync(path.join(root, 'sage.db'));
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', 1);
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
    `);
    db.close();

    const value = store();
    await expect(value.initialize()).resolves.toBeUndefined();
    const migrated = (value as unknown as { db: DatabaseSyncType }).db;
    expect(
      (
        migrated.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
          value: number;
        }
      ).value,
    ).toBe(5);
  });

  it('recovers populated versionless databases that already have canonical_text', async () => {
    const root = path.join(directory, '.wrongstack', 'memories');
    await fs.mkdir(root, { recursive: true });
    const db = new DatabaseSync(path.join(root, 'sage.db'));
    db.exec(`
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
    `);
    const value = memory('versionless');
    db.prepare(
      `INSERT INTO memories
       (id, data, status, kind, scope, importance, confidence, freshness,
        updated_at, created_at, audience, tags, canonical_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.id,
      JSON.stringify(value),
      value.status,
      value.kind,
      value.scope,
      value.importance,
      value.confidence,
      value.freshness,
      value.updatedAt,
      value.createdAt,
      null,
      '[]',
      'versionless',
    );
    // A real pre-marker database already had its external-content FTS row.
    // Populate it so later migration UPDATE triggers do not delete a missing
    // shadow-table entry (which SQLite correctly reports as malformed).
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        text, tags, audience, content='memories', content_rowid='rowid'
      );
      INSERT INTO memories_fts(rowid, text, tags, audience)
      SELECT rowid, json_extract(data, '$.text'), tags, audience FROM memories;
    `);
    db.close();

    const recovered = store();
    await expect(recovered.initialize()).resolves.toBeUndefined();
    expect(await recovered.getSage('versionless')).toMatchObject({ text: 'memory versionless' });
    const recoveredDb = (recovered as unknown as { db: DatabaseSyncType }).db;
    expect(
      (
        recoveredDb.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
          value: number;
        }
      ).value,
    ).toBe(5);
  });

  it('recovers corrupt JSONL lines and applies revision, candidate, edge, and audit rules', async () => {
    const older = memory('revisioned', { revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    const newer = memory('revisioned', {
      revision: 2,
      text: 'newest revision',
      updatedAt: '2026-01-02T00:00:00.000Z',
      anchors: [{ type: 'file', path: 'src/new.ts' }],
    });
    await writeJsonl('memories.jsonl', [memoryRecord(newer), memoryRecord(older), {}, '{torn', '']);
    await writeJsonl('candidates.jsonl', [
      {
        id: 'candidate',
        status: 'pending',
        text: 'candidate text',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      { invalid: true },
      '{torn',
    ]);
    await writeJsonl('graph/edges.jsonl', [
      {
        id: 'edge-live',
        from: 'mem:revisioned',
        to: 'file:src/new.ts',
        relation: 'related_to',
        weight: 0.8,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'edge-deleted',
        from: 'mem:revisioned',
        to: 'file:gone.ts',
        relation: 'related_to',
        weight: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        deletedAt: '2026-01-02T00:00:00.000Z',
      },
      { invalid: true },
    ]);
    await writeJsonl('audit.jsonl', [
      { event: 'legacy.event', at: '2026-01-01T00:00:00.000Z', traceId: 'trace' },
      { event: 1, at: 'bad' },
    ]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const value = store();
    await value.initialize();

    expect(await value.getSage('revisioned')).toMatchObject({
      revision: 2,
      text: 'newest revision',
    });
    expect(await value.listCandidates()).toHaveLength(1);
    expect((await value.getStats()).edges).toBeGreaterThan(0);
    expect((await value.readAudit(20)).map((row) => row.event)).toContain('legacy.event');
    expect(console.warn).toHaveBeenCalled();
  });

  it('keeps newer SQLite rows while importing older JSONL candidates and memories', async () => {
    const first = store();
    const existingMemory = await first.rememberSage({ text: 'SQLite current' });
    const existingCandidate = await first.createCandidate({ text: 'SQLite candidate' });
    first.close();

    await writeJsonl('memories.jsonl', [
      memoryRecord({
        ...existingMemory,
        revision: existingMemory.revision,
        text: 'older JSONL memory',
        updatedAt: '2000-01-01T00:00:00.000Z',
      }),
    ]);
    await writeJsonl('candidates.jsonl', [
      {
        ...existingCandidate,
        text: 'older JSONL candidate',
        updatedAt: '2000-01-01T00:00:00.000Z',
      },
    ]);

    const second = store();
    await second.initialize();
    expect(await second.getSage(existingMemory.id)).toMatchObject({ text: 'SQLite current' });
    expect((await second.listCandidates())[0]).toMatchObject({ text: 'SQLite candidate' });
  });

  it('replaces an older SQLite candidate with a newer JSONL candidate', async () => {
    const first = store();
    const existing = await first.createCandidate({ text: 'candidate before migration' });
    first.close();
    await writeJsonl('candidates.jsonl', [
      {
        ...existing,
        text: 'candidate after migration',
        updatedAt: '2099-01-01T00:00:00.000Z',
      },
    ]);

    const second = store();
    await second.initialize();
    expect((await second.listCandidates())[0]).toMatchObject({
      text: 'candidate after migration',
    });
  });

  it('commits early when a peer claims JSONL migration during the read phase', async () => {
    const value = store();
    await value.initialize();
    await writeJsonl('memories.jsonl', [memoryRecord(memory('peer-memory'))]);
    const state = value as unknown as {
      stmt: (sql: string) => { get: (...args: unknown[]) => unknown };
      migrateFromJsonl: () => Promise<void>;
    };
    const originalStmt = state.stmt.bind(value);
    let migrationChecks = 0;
    state.stmt = ((sql: string) => {
      if (sql === 'SELECT value FROM schema_meta WHERE key = ?') {
        return {
          get: () => (migrationChecks++ === 0 ? undefined : { value: 1 }),
        };
      }
      return originalStmt(sql);
    }) as never;

    await expect(state.migrateFromJsonl()).resolves.toBeUndefined();
    expect(await value.getSage('peer-memory')).toBeNull();
  });

  it('rolls back JSONL migration when a persisted row cannot be written', async () => {
    const value = store();
    await value.initialize();
    await writeJsonl('memories.jsonl', [memoryRecord(memory('rollback-memory'))]);
    const state = value as unknown as {
      migrateFromJsonl: () => Promise<void>;
      upsertMemory: (memory: Sage) => void;
    };
    state.upsertMemory = () => {
      throw new Error('write failed');
    };

    await expect(state.migrateFromJsonl()).rejects.toThrow('write failed');
    expect(await value.getSage('rollback-memory')).toBeNull();
  });

  it('upgrades a v4 database and backfills owner_session_id from JSON data', async () => {
    const root = path.join(directory, '.wrongstack', 'memories');
    await fs.mkdir(root, { recursive: true });
    const db = new DatabaseSync(path.join(root, 'sage.db'));
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', 4);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        legacy_scope TEXT,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        freshness REAL NOT NULL,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        audience TEXT,
        tags TEXT,
        canonical_text TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        text, tags, audience, content='memories', content_rowid='rowid'
      );
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, tags, audience)
        VALUES (new.rowid, json_extract(new.data, '$.text'), COALESCE(new.tags, ''), COALESCE(new.audience, ''));
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, tags, audience)
        VALUES('delete', old.rowid, json_extract(old.data, '$.text'), COALESCE(old.tags, ''), COALESCE(old.audience, ''));
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, tags, audience)
        VALUES('delete', old.rowid, json_extract(old.data, '$.text'), COALESCE(old.tags, ''), COALESCE(old.audience, ''));
        INSERT INTO memories_fts(rowid, text, tags, audience)
        VALUES (new.rowid, json_extract(new.data, '$.text'), COALESCE(new.tags, ''), COALESCE(new.audience, ''));
      END;
    `);

    // Insert a session-scoped memory that carries ownerSessionId in JSON
    const sessionOwned: Sage = {
      id: 'v5-session-owned',
      revision: 1,
      scope: 'session',
      kind: 'fact',
      status: 'active',
      text: 'Session-scoped memory with owner',
      importance: 0.5,
      confidence: 0.8,
      freshness: 1,
      tags: [],
      anchors: [],
      sources: [{ type: 'user' }],
      ownerSessionId: 'session-xyz-789',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    db.prepare(
      `INSERT INTO memories (id, data, status, kind, scope, legacy_scope, importance, confidence, freshness, updated_at, created_at, audience, tags, canonical_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionOwned.id,
      JSON.stringify(sessionOwned),
      sessionOwned.status,
      sessionOwned.kind,
      sessionOwned.scope,
      null,
      sessionOwned.importance,
      sessionOwned.confidence,
      sessionOwned.freshness,
      sessionOwned.updatedAt,
      sessionOwned.createdAt,
      null,
      '[]',
      'session-scoped memory with owner',
    );

    // Insert a project-scoped memory (no ownerSessionId)
    const projectMem: Sage = {
      id: 'v5-project',
      revision: 1,
      scope: 'project',
      kind: 'fact',
      status: 'active',
      text: 'Project memory without owner',
      importance: 0.7,
      confidence: 0.9,
      freshness: 1,
      tags: [],
      anchors: [],
      sources: [{ type: 'user' }],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    db.prepare(
      `INSERT INTO memories (id, data, status, kind, scope, legacy_scope, importance, confidence, freshness, updated_at, created_at, audience, tags, canonical_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectMem.id,
      JSON.stringify(projectMem),
      projectMem.status,
      projectMem.kind,
      projectMem.scope,
      'project-memory',
      projectMem.importance,
      projectMem.confidence,
      projectMem.freshness,
      projectMem.updatedAt,
      projectMem.createdAt,
      null,
      '[]',
      'project memory without owner',
    );

    db.close();

    const value = store();
    await value.initialize();
    const migrated = (value as unknown as { db: DatabaseSyncType }).db;

    // owner_session_id column exists and was backfilled from JSON
    const sessionRow = migrated
      .prepare('SELECT owner_session_id FROM memories WHERE id = ?')
      .get('v5-session-owned') as { owner_session_id: string | null };
    expect(sessionRow.owner_session_id).toBe('session-xyz-789');

    // Project memory has NULL owner_session_id (no owner in JSON)
    const projectRow = migrated
      .prepare('SELECT owner_session_id FROM memories WHERE id = ?')
      .get('v5-project') as { owner_session_id: string | null };
    expect(projectRow.owner_session_id).toBeNull();

    // idx_owner_session index was created
    const idx = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_owner_session'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_owner_session');

    // Schema version is 5
    const version = migrated
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: number };
    expect(version.value).toBe(5);

    migrated.close();
  });
});
