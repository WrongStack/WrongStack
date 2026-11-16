/**
 * Regression tests for the SQLite mailbox schema migration mechanism.
 *
 * H2: the schema module used to "migrate" by bumping `schema_version` alone.
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table, so a
 * database written by an older build broke on the first write against it, and
 * the v1 → v2 path was neither defined nor tested.
 *
 * These tests build a v1-shaped database file (message-global completion, no
 * receipt table, no `legacy_global_completion` column), open it through the
 * normal store constructor, and assert that the rows survive with the v2
 * receipt/legacy semantics.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { SqliteMailbox } from '../src/sqlite-mailbox.js';
import { SQLITE_MAILBOX_SCHEMA_VERSION } from '../src/sqlite-mailbox-schema.js';

const DatabaseSync = loadRuntimeDatabaseSync();

/** SQLite keeps `-wal`/`-shm` mapped for a moment after close. */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;

let dir: string;
const stores: SqliteMailbox[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-migration-'));
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  await removeProjectFixtureDirectory(dir, RM_OPTIONS);
});

/** One v1 message row. */
interface V1Row {
  id: string;
  to: string;
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
  outcome?: string;
  readBy?: Record<string, string>;
}

const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const READ_AT = '2026-01-01T00:04:00.000Z';
const COMPLETED_AT = '2026-01-01T00:05:00.000Z';

/**
 * Write a v1-shaped database file.
 *
 * The v1 shape is the current schema minus the v2 additions: one
 * message-global `completed` flag, no `message_receipts` table and no
 * `legacy_global_completion` column. The completion metadata (`completedBy`,
 * `completedAt`, `outcome`) lived inside the stored JSON, because the table
 * never had columns for it.
 */
function writeV1Database(databasePath: string, rows: readonly V1Row[]): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE mailbox_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        deleted_at TEXT,
        sender_session_id TEXT,
        reply_to TEXT,
        expires_at TEXT,
        data TEXT NOT NULL
      );
      INSERT INTO mailbox_meta(key, value) VALUES ('schema_version', '1');
    `);
    const insert = db.prepare(`
      INSERT INTO messages(
        id, from_id, to_id, type, priority, timestamp, completed, completed_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const message = {
        id: row.id,
        from: 'leader@session',
        to: row.to,
        type: 'note',
        subject: 'legacy',
        body: 'legacy body',
        priority: 'normal',
        readBy: row.readBy ?? {},
        completed: row.completed,
        timestamp: TIMESTAMP,
        ...(row.completedAt !== undefined ? { completedAt: row.completedAt } : {}),
        ...(row.completedBy !== undefined ? { completedBy: row.completedBy } : {}),
        ...(row.outcome !== undefined ? { outcome: row.outcome } : {}),
      };
      insert.run(
        row.id,
        'leader@session',
        row.to,
        'note',
        'normal',
        TIMESTAMP,
        row.completed ? 1 : 0,
        row.completedAt ?? null,
        JSON.stringify(message),
      );
    }
  } finally {
    db.close();
  }
}

function readSchemaVersion(databasePath: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare('SELECT value FROM mailbox_meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    return Number(row?.value);
  } finally {
    db.close();
  }
}

function readLegacyFlag(databasePath: string, id: string): number {
  const db = new DatabaseSync(databasePath);
  try {
    const row = db.prepare('SELECT legacy_global_completion FROM messages WHERE id = ?').get(id) as
      | { legacy_global_completion: number }
      | undefined;
    return Number(row?.legacy_global_completion ?? 0);
  } finally {
    db.close();
  }
}

function openStore(): SqliteMailbox {
  const store = new SqliteMailbox(dir);
  stores.push(store);
  return store;
}

async function projectionOf(
  store: SqliteMailbox,
  messageId: string,
): Promise<Record<string, unknown> | undefined> {
  const all = await store.query({ limit: 100, includeReceiptState: true });
  return all.find((message) => message.id === messageId) as Record<string, unknown> | undefined;
}

describe('mailbox SQLite schema migration', () => {
  it('migrates a v1 database to the current schema version', async () => {
    const databasePath = path.join(dir, '_mailbox.sqlite');
    writeV1Database(databasePath, [
      {
        id: 'direct-done',
        to: 'worker@session',
        completed: true,
        completedAt: COMPLETED_AT,
        completedBy: 'worker@session',
        outcome: 'done',
        readBy: { 'worker@session': READ_AT },
      },
    ]);

    openStore();

    expect(readSchemaVersion(databasePath)).toBe(SQLITE_MAILBOX_SCHEMA_VERSION);
  });

  it('keeps a v1 direct completion as that actor’s receipt', async () => {
    const databasePath = path.join(dir, '_mailbox.sqlite');
    writeV1Database(databasePath, [
      {
        id: 'direct-done',
        to: 'worker@session',
        completed: true,
        completedAt: COMPLETED_AT,
        completedBy: 'worker@session',
        outcome: 'done',
        readBy: { 'worker@session': READ_AT },
      },
    ]);

    const store = openStore();
    const message = await projectionOf(store, 'direct-done');

    expect(message).toBeDefined();
    // A direct recipient completed message-globally in v1: the completion
    // belongs to that actor, so it becomes that actor's receipt.
    expect(message?.['legacyGlobalCompletion']).toBeUndefined();
    expect(message?.['completed']).toBe(true);
    const state = message?.['recipientState'] as Record<string, Record<string, unknown>>;
    expect(state['worker@session']).toMatchObject({
      actorId: 'worker@session',
      readAt: READ_AT,
      completedAt: COMPLETED_AT,
      completedBy: 'worker@session',
      outcome: 'done',
    });
    expect(readLegacyFlag(databasePath, 'direct-done')).toBe(0);
  });

  it('keeps a v1 fan-out completion global instead of actor-scoped', async () => {
    const databasePath = path.join(dir, '_mailbox.sqlite');
    writeV1Database(databasePath, [
      {
        id: 'broadcast-done',
        to: '*',
        completed: true,
        completedAt: COMPLETED_AT,
        completedBy: 'worker@session',
        outcome: 'done',
        readBy: { 'worker@session': READ_AT },
      },
    ]);

    const store = openStore();
    const message = await projectionOf(store, 'broadcast-done');

    expect(message).toBeDefined();
    // A fan-out recipient completed message-globally in v1: the message
    // stays globally suppressed and NO actor-scoped completion is created.
    expect(message?.['legacyGlobalCompletion']).toBe(true);
    expect(message?.['completed']).toBe(true);
    const state = message?.['recipientState'] as Record<string, Record<string, unknown>>;
    expect(state['worker@session']?.['completedAt']).toBeUndefined();
    expect(state['worker@session']?.['readAt']).toBe(READ_AT);
    expect(readLegacyFlag(databasePath, 'broadcast-done')).toBe(1);
  });

  it('keeps an unfinished v1 message unfinished and readable', async () => {
    const databasePath = path.join(dir, '_mailbox.sqlite');
    writeV1Database(databasePath, [
      {
        id: 'pending',
        to: 'worker@session',
        completed: false,
        readBy: { 'reader@session': READ_AT },
      },
    ]);

    const store = openStore();
    const message = await projectionOf(store, 'pending');

    expect(message).toBeDefined();
    expect(message?.['completed']).toBe(false);
    expect(message?.['legacyGlobalCompletion']).toBeUndefined();
    const state = message?.['recipientState'] as Record<string, Record<string, unknown>>;
    expect(state['reader@session']?.['readAt']).toBe(READ_AT);
    expect(state['reader@session']?.['completedAt']).toBeUndefined();
  });

  it('accepts writes against the migrated database', async () => {
    const databasePath = path.join(dir, '_mailbox.sqlite');
    writeV1Database(databasePath, [
      {
        id: 'direct-done',
        to: 'worker@session',
        completed: true,
        completedAt: COMPLETED_AT,
        completedBy: 'worker@session',
        readBy: { 'worker@session': READ_AT },
      },
    ]);

    const store = openStore();
    const sent = await store.send({
      from: 'leader@session',
      to: 'worker@session',
      type: 'note',
      subject: 'after migration',
      body: 'still writable',
    });
    await store.ack({
      messageId: sent.id,
      readerId: 'worker@session',
      read: true,
      completed: true,
    });

    const migrated = await projectionOf(store, 'direct-done');
    const fresh = await projectionOf(store, sent.id);
    expect(migrated).toBeDefined();
    expect(fresh?.['completed']).toBe(true);
    const state = fresh?.['recipientState'] as Record<string, Record<string, unknown>>;
    expect(state['worker@session']?.['completedAt']).toBeDefined();
  });

  it('strips UTF-8 BOM from legacy mailbox registry files during migration (F482)', async () => {
    await fs.writeFile(
      path.join(dir, '_mailbox.registry.json'),
      `\uFEFF${JSON.stringify({})}`,
      'utf8',
    );
    const store = openStore();
    await expect(store.query({ limit: 10 })).resolves.toEqual([]);
  });
});
