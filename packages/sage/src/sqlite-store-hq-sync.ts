import type { DatabaseSync } from 'node:sqlite';
import { compareHqSageRecords, type HqSageRecord, isHqSageRecord } from '@wrongstack/hq';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import type { Sage } from './types.js';

const SHARED = "('project', 'file', 'symbol')";
// Local access counters must not create a replication storm on every recall.
const content = (row: string) =>
  `CASE WHEN json_valid(${row}.data) THEN json_remove(${row}.data, '$.injectionCount', '$.useCount', '$.lastAccessedAt', '$.lastUsedAt') ELSE NULL END`;

export function initSageHqSync(db: DatabaseSync): void {
  const schema = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'hq_memory_sync_schema'")
    .get() as { value: number } | undefined;
  const migrate = (schema?.value ?? 0) < 2;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
    ${
      migrate
        ? `
      DROP TRIGGER IF EXISTS sage_hq_insert;
      DROP TRIGGER IF EXISTS sage_hq_update;
      DROP TRIGGER IF EXISTS sage_hq_delete;
      INSERT INTO schema_meta (key, value) VALUES ('hq_memory_sync_schema', 2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `
        : ''
    }
    CREATE TABLE IF NOT EXISTS hq_memory_sync (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, change_id TEXT NOT NULL, data TEXT
    );
    CREATE TABLE IF NOT EXISTS hq_memory_sync_clock (
      id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO hq_memory_sync_clock VALUES(1, lower(hex(randomblob(16))), 0);
    CREATE TRIGGER IF NOT EXISTS sage_hq_clock_insert AFTER INSERT ON hq_memory_sync BEGIN
      UPDATE hq_memory_sync_clock SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS sage_hq_clock_update AFTER UPDATE ON hq_memory_sync BEGIN
      UPDATE hq_memory_sync_clock SET revision = revision + 1 WHERE id = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS sage_hq_clock_delete AFTER DELETE ON hq_memory_sync BEGIN
      UPDATE hq_memory_sync_clock SET revision = revision + 1 WHERE id = 1;
    END;
    INSERT OR IGNORE INTO hq_memory_sync
      SELECT id, 1, lower(hex(randomblob(16))), ${content('memories')} FROM memories WHERE scope IN ${SHARED} AND json_valid(data);
    CREATE TRIGGER IF NOT EXISTS sage_hq_insert AFTER INSERT ON memories WHEN new.scope IN ${SHARED} AND json_valid(new.data) BEGIN
      INSERT INTO hq_memory_sync VALUES(new.id, 1, lower(hex(randomblob(16))), ${content('new')})
      ON CONFLICT(id) DO UPDATE SET revision = revision + 1, change_id = excluded.change_id, data = excluded.data;
    END;
    CREATE TRIGGER IF NOT EXISTS sage_hq_update AFTER UPDATE ON memories
      WHEN (new.scope IN ${SHARED} OR old.scope IN ${SHARED}) AND json_valid(new.data) AND ${content('new')} IS NOT ${content('old')} BEGIN
      INSERT INTO hq_memory_sync VALUES(new.id, 1, lower(hex(randomblob(16))), CASE WHEN new.scope IN ${SHARED} THEN ${content('new')} ELSE NULL END)
      ON CONFLICT(id) DO UPDATE SET revision = revision + 1, change_id = excluded.change_id, data = excluded.data;
    END;
    CREATE TRIGGER IF NOT EXISTS sage_hq_delete AFTER DELETE ON memories WHEN old.scope IN ${SHARED} BEGIN
      INSERT INTO hq_memory_sync VALUES(old.id, 1, lower(hex(randomblob(16))), NULL)
      ON CONFLICT(id) DO UPDATE SET revision = revision + 1, change_id = excluded.change_id, data = NULL;
    END;
  `);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* Preserve the migration error. */
    }
    throw error;
  }
}

export function sageHqSyncVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT epoch, revision FROM hq_memory_sync_clock WHERE id = 1').get() as {
    epoch: string;
    revision: number;
  };
  return `${row.epoch}:${row.revision}`;
}

type Row = { id: string; revision: number; change_id: string; data: string | null };
function record(row: Row): HqSageRecord {
  return {
    id: row.id,
    revision: row.revision,
    changeId: row.change_id,
    memory: row.data === null ? null : JSON.parse(row.data),
  };
}

export function listSageHqSync(db: DatabaseSync, after: string): HqSageRecord[] {
  if (typeof after !== 'string') throw new Error('Invalid SAGE sync cursor');
  const page: HqSageRecord[] = [];
  let bytes = 0;
  for (const value of db
    .prepare('SELECT * FROM hq_memory_sync WHERE id > ? ORDER BY id LIMIT 100')
    .iterate(after)) {
    const row = value as Row;
    const size = Buffer.byteLength(row.data ?? '') + 512;
    if (page.length && bytes + size > 512 * 1024) break;
    page.push(record(row));
    bytes += size;
  }
  return page;
}

/** Called inside the owner's mutation transaction; imports never re-version/echo. */
export function applySageHqSync(
  host: {
    db: DatabaseSync;
    upsert(memory: Sage): void;
    anchors(memory: Sage): void;
    deleteEdges(node: string): void;
  },
  records: HqSageRecord[],
): string[] {
  if (!Array.isArray(records) || records.length > 100 || !records.every(isHqSageRecord))
    throw new Error('Invalid SAGE sync records');
  const changed: string[] = [];
  for (const r of records) {
    const prior = host.db.prepare('SELECT * FROM hq_memory_sync WHERE id = ?').get(r.id) as
      | Row
      | undefined;
    if (prior && compareHqSageRecords(r, record(prior)) <= 0) continue;
    const existing = host.db.prepare('SELECT scope FROM memories WHERE id = ?').get(r.id) as
      | { scope: string }
      | undefined;
    // A remote id collision cannot overwrite private local memory.
    if (existing && !['project', 'file', 'symbol'].includes(existing.scope)) continue;
    if (r.memory === null) {
      host.db.prepare('DELETE FROM memories WHERE id = ?').run(r.id);
      host.deleteEdges(memoryNodeId(r.id));
    } else {
      const memory = sqliteRowToMemory({ data: JSON.stringify(r.memory) });
      host.upsert(memory);
      if (memory.status === 'deleted') host.deleteEdges(memoryNodeId(r.id));
      else host.anchors(memory);
    }
    host.db
      .prepare(`INSERT INTO hq_memory_sync VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, change_id=excluded.change_id, data=excluded.data`)
      .run(r.id, r.revision, r.changeId, r.memory === null ? null : JSON.stringify(r.memory));
    changed.push(r.id);
  }
  return changed;
}
