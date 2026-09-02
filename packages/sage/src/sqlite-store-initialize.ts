import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensureDir, withFileLock } from '@wrongstack/core/utils';

import type { resolveSagePaths } from './paths.js';
import { sqliteRowToCandidate, sqliteRowToMemory } from './sqlite-store-codec.js';
import { loadDatabaseSync } from './sqlite-store-loader.js';
import { initSchema, SQLITE_SCHEMA_VERSION } from './sqlite-store-schema.js';
import { normalizeTextKey } from './store-helpers.js';
import type { Sage, SageManifest } from './types.js';
import { SAGE_SCHEMA_VERSION } from './types.js';

type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

export async function initializeSqliteSageStore(input: {
  paths: ReturnType<typeof resolveSagePaths>;
  now: () => Date;
  stmt(sql: string): SqliteStatement;
  setDb(db: DatabaseSync): void;
  syncAnchorEdges(memory: Sage): void;
  migrateFromJsonl(): Promise<void>;
}): Promise<void> {
  const { paths, now, stmt, setDb, syncAnchorEdges, migrateFromJsonl } = input;
  await ensureDir(paths.rootDir);
  const dbPath = path.join(paths.rootDir, 'sage.db');
  const DBCtor = loadDatabaseSync();
  const db = new DBCtor(dbPath);
  setDb(db);
  initSchema(db);

  const row = stmt('SELECT value FROM schema_meta WHERE key = ?').get('version') as
    | { value?: number }
    | undefined;
  const currentVersion =
    row?.value ??
    ((stmt('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n > 0
      ? 0
      : SQLITE_SCHEMA_VERSION);
  if (!row) {
    stmt('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(
      'version',
      currentVersion,
    );
  }

  if (currentVersion < 2) migrateSchemaV2({ db, stmt });
  if (currentVersion < 3) migrateSchemaV3({ db, stmt, syncAnchorEdges });
  if (currentVersion < 4) migrateSchemaV4({ db, stmt });
  if (currentVersion < 5) migrateSchemaV5({ db, stmt });

  db.exec('CREATE INDEX IF NOT EXISTS idx_canonical_text ON memories(canonical_text)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_status_scope_canonical ON memories(status, scope, canonical_text)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_legacy_scope ON memories(legacy_scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_owner_session ON memories(owner_session_id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_candidates_status_canonical ON candidates(status, canonical_text)',
  );

  await withFileLock(paths.manifest, async () => {
    if (!fs.existsSync(paths.manifest)) {
      const nowIso = now().toISOString();
      const manifest: SageManifest = {
        schemaVersion: SAGE_SCHEMA_VERSION,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      // Atomic temp+rename+0o600: a crash mid-write would leave the
      // manifest as parse-bad JSON, causing the next init to read it
      // back as invalid and reset the creator timestamp. Writing to a
      // sibling temp file and renaming catches the partial-write case
      // (rename is atomic on POSIX and best-effort atomic on Windows
      // when the target does not exist).
      const tmpPath = `${paths.manifest}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, paths.manifest);
    }
  });

  await migrateFromJsonl();
}

function migrateSchemaV2({
  db,
  stmt,
}: {
  db: DatabaseSync;
  stmt(sql: string): SqliteStatement;
}): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const canonicalTextColumn = stmt(
      "SELECT name FROM pragma_table_info('memories') WHERE name = 'canonical_text'",
    ).get() as { name: string } | undefined;
    if (!canonicalTextColumn) {
      db.exec("ALTER TABLE memories ADD COLUMN canonical_text TEXT NOT NULL DEFAULT ''");
    }
    const backfillRows = stmt(
      "SELECT id, data FROM memories WHERE canonical_text = ''",
    ).all() as Array<{ id: string; data: string }>;
    if (backfillRows.length > 0) {
      const updateCanonical = stmt('UPDATE memories SET canonical_text = ? WHERE id = ?');
      for (const r of backfillRows) {
        const memory = sqliteRowToMemory(r);
        updateCanonical.run(normalizeTextKey(memory.text), r.id);
      }
    }
    stmt('UPDATE schema_meta SET value = ? WHERE key = ?').run(2, 'version');
    db.exec('COMMIT');
  } catch (migrationErr) {
    db.exec('ROLLBACK');
    throw migrationErr;
  }
}

function migrateSchemaV3({
  db,
  stmt,
  syncAnchorEdges,
}: {
  db: DatabaseSync;
  stmt(sql: string): SqliteStatement;
  syncAnchorEdges(memory: Sage): void;
}): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingCols = stmt(
      "SELECT name FROM pragma_table_info('candidates') WHERE name = 'canonical_text'",
    ).get() as { name: string } | undefined;
    if (!existingCols) {
      db.exec("ALTER TABLE candidates ADD COLUMN canonical_text TEXT NOT NULL DEFAULT ''");
    }
    const candidateRows = stmt(
      "SELECT id, data FROM candidates WHERE canonical_text = ''",
    ).all() as Array<{ id: string; data: string }>;
    if (candidateRows.length > 0) {
      const updateCandidate = stmt('UPDATE candidates SET canonical_text = ? WHERE id = ?');
      for (const r of candidateRows) {
        try {
          const candidate = sqliteRowToCandidate(r);
          updateCandidate.run(normalizeTextKey(candidate.text ?? ''), r.id);
        } catch {
          updateCandidate.run('', r.id);
        }
      }
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_candidates_status_canonical ON candidates(status, canonical_text)',
    );

    const memRows = stmt("SELECT data FROM memories WHERE status != 'deleted'").all() as Array<{
      data: string;
    }>;
    for (const row of memRows) {
      try {
        syncAnchorEdges(sqliteRowToMemory(row));
      } catch {
        // Skip corrupt rows; JSON fallback paths can still query them.
      }
    }

    stmt('UPDATE schema_meta SET value = ? WHERE key = ?').run(3, 'version');
    db.exec('COMMIT');
  } catch (migrationErr) {
    db.exec('ROLLBACK');
    throw migrationErr;
  }
}

function migrateSchemaV4({
  db,
  stmt,
}: {
  db: DatabaseSync;
  stmt(sql: string): SqliteStatement;
}): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingLegacyCol = stmt(
      "SELECT name FROM pragma_table_info('memories') WHERE name = 'legacy_scope'",
    ).get() as { name: string } | undefined;
    if (!existingLegacyCol) {
      db.exec('ALTER TABLE memories ADD COLUMN legacy_scope TEXT');
    }
    const backfillRows = stmt(
      'SELECT id, data FROM memories WHERE legacy_scope IS NULL AND json_valid(data)',
    ).all() as Array<{ id: string; data: string }>;
    if (backfillRows.length > 0) {
      const updateLegacy = stmt(
        "UPDATE memories SET legacy_scope = json_extract(data, '$.legacyScope') WHERE id = ?",
      );
      for (const r of backfillRows) updateLegacy.run(r.id);
    }
    db.exec(
      "UPDATE memories SET legacy_scope = CASE scope WHEN 'user' THEN 'user-memory' ELSE 'project-memory' END WHERE legacy_scope IS NULL AND status != 'deleted' AND json_valid(data)",
    );
    stmt('UPDATE schema_meta SET value = ? WHERE key = ?').run(4, 'version');
    db.exec('COMMIT');
  } catch (migrationErr) {
    db.exec('ROLLBACK');
    throw migrationErr;
  }
}

function migrateSchemaV5({
  db,
  stmt,
}: {
  db: DatabaseSync;
  stmt(sql: string): SqliteStatement;
}): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existingCol = stmt(
      "SELECT name FROM pragma_table_info('memories') WHERE name = 'owner_session_id'",
    ).get() as { name: string } | undefined;
    if (!existingCol) {
      db.exec('ALTER TABLE memories ADD COLUMN owner_session_id TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_owner_session ON memories(owner_session_id)');
    // Backfill owner_session_id from JSON data for existing session-scoped records.
    // Records without an owner session remain NULL — P0-1b filtering treats
    // NULL owner_session_id session-scope memories as unowned (excluded from
    // session-filtered retrieval unless includeAllSessions is true).
    // Guard on status != 'deleted' avoids firing the memories_au FTS trigger
    // on tombstoned rows (matches V4 migration's guard).
    db.exec(
      "UPDATE memories SET owner_session_id = json_extract(data, '$.ownerSessionId') WHERE owner_session_id IS NULL AND status != 'deleted' AND json_valid(data) AND json_extract(data, '$.ownerSessionId') IS NOT NULL",
    );
    stmt('UPDATE schema_meta SET value = ? WHERE key = ?').run(5, 'version');
    db.exec('COMMIT');
  } catch (migrationErr) {
    db.exec('ROLLBACK');
    throw migrationErr;
  }
}
