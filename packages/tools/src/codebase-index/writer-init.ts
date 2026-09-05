import type { DatabaseSync } from 'node:sqlite';
import { buildIndexableText } from './bm25.js';
import { LANG_FAMILY_ENTRIES } from './languages.js';
import { SCHEMA_VERSION } from './schema.js';
import { vectorEmbeddingEnabled } from './vector-search.js';
import { bulkInsertFtsWithStatement } from './writer-bulk-insert.js';
import {
  CORE_TABLES_SQL,
  FILE_INDEX_SQL,
  LANG_FAMILY_TABLE_SQL,
  LANG_FAMILY_WILDCARD,
  METADATA_TABLE_SQL,
  REFS_INDEX_SQL,
  REFS_TABLE_SQL,
  SYMBOL_INDEX_SQL,
  SYMBOL_VECTORS_TABLE_SQL,
  SYMBOLS_FTS_SQL,
} from './writer-schema.js';

export const SYMBOLS_TEXT_DROPPED_KEY = 'symbols_text_dropped';
export const NEXT_SYMBOL_ID_KEY = 'next_symbol_id';

export function seedLangFamilies(stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>): void {
  const insert = stmt('INSERT OR REPLACE INTO lang_family(lang, family) VALUES (?, ?)');
  for (const [lang, family] of LANG_FAMILY_ENTRIES) insert.run(lang, family);
  insert.run('', LANG_FAMILY_WILDCARD);
}

export function repairMissingColumns(db: DatabaseSync): void {
  const expected: ReadonlyArray<{ table: string; columns: ReadonlyArray<[string, string]> }> = [
    {
      table: 'files',
      columns: [
        ['package', "TEXT NOT NULL DEFAULT ''"],
        ['content_hash', "TEXT NOT NULL DEFAULT ''"],
      ],
    },
    {
      table: 'refs',
      columns: [
        ['lang', "TEXT NOT NULL DEFAULT ''"],
        ['module', 'TEXT'],
        ['to_file', 'TEXT'],
      ],
    },
  ];

  for (const { table, columns } of expected) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
    }>;
    const present = new Set<string>();
    for (const row of rows) {
      if (typeof row.name === 'string') present.add(row.name);
    }
    if (present.size === 0) continue;
    for (const [name, type] of columns) {
      if (present.has(name)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

export function dropDeprecatedSymbolsColumns(
  db: DatabaseSync,
  getMetadata: (key: string) => string | undefined,
  setMetadata: (key: string, value: string) => void,
): void {
  if (getMetadata(SYMBOLS_TEXT_DROPPED_KEY) !== undefined) return;
  const present = new Set(
    (db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name?: unknown }>).flatMap((row) =>
      typeof row.name === 'string' ? [row.name] : [],
    ),
  );
  if (present.size === 0) return;
  if (!present.has('text')) {
    setMetadata(SYMBOLS_TEXT_DROPPED_KEY, '1');
    return;
  }
  try {
    db.exec('ALTER TABLE symbols DROP COLUMN text');
    setMetadata(SYMBOLS_TEXT_DROPPED_KEY, '1');
  } catch {
    // Best-effort: deferred to next open
  }
}

export function initIndexSchema(
  db: DatabaseSync,
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  getMetadata: (key: string) => string | undefined,
  setMetadata: (key: string, value: string) => void,
  maxSqlVars: number,
  invalidateBm25: () => void,
): { ftsAvailable: boolean; vectorsAvailable: boolean } {
  db.exec(METADATA_TABLE_SQL);

  const storedRows = stmt('SELECT value FROM metadata WHERE key = ?').all('version') as {
    value: string;
  }[];
  const storedVersion = storedRows.length ? Number(storedRows[0]?.value) : null;
  if (storedVersion !== null && storedVersion !== SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS refs;
      DROP TABLE IF EXISTS symbol_vectors;
    `);
    db.exec('DROP TABLE IF EXISTS symbols_fts');
    stmt('UPDATE metadata SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'version');
  } else if (storedVersion === null) {
    stmt('INSERT INTO metadata(key, value) VALUES (?, ?)').run('version', String(SCHEMA_VERSION));
  }

  db.exec(CORE_TABLES_SQL);
  db.exec(REFS_TABLE_SQL);
  repairMissingColumns(db);
  dropDeprecatedSymbolsColumns(db, getMetadata, setMetadata);
  for (const sql of FILE_INDEX_SQL) db.exec(sql);
  for (const sql of SYMBOL_INDEX_SQL) db.exec(sql);
  for (const sql of REFS_INDEX_SQL) db.exec(sql);
  db.exec(LANG_FAMILY_TABLE_SQL);
  seedLangFamilies(stmt);

  let ftsAvailable = false;
  try {
    const ftsSchema = stmt(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='symbols_fts'",
    ).get() as { sql?: string } | undefined;
    if (ftsSchema?.sql?.includes('unicode61')) {
      db.exec('DROP TABLE IF EXISTS symbols_fts');
    }
    db.exec(SYMBOLS_FTS_SQL);
    ftsAvailable = true;
    const symbolCount = Number(
      (stmt('SELECT COUNT(*) AS n FROM symbols').get() as { n?: number } | undefined)?.n ?? 0,
    );
    const ftsCount = Number(
      (stmt('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n?: number } | undefined)?.n ?? 0,
    );
    if (symbolCount !== ftsCount) {
      db.exec('DELETE FROM symbols_fts');
      if (
        vectorEmbeddingEnabled() &&
        (stmt("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_vectors'").get() as
          | { '1'?: number }
          | undefined) !== undefined
      ) {
        db.exec('DELETE FROM symbol_vectors');
      }
      const rows = stmt(
        'SELECT id, name, signature, doc_comment FROM symbols ORDER BY id',
      ).all() as Array<{ id: number; name: string; signature: string; doc_comment: string }>;
      bulkInsertFtsWithStatement(
        stmt,
        maxSqlVars,
        ftsAvailable,
        rows.map((row) => ({
          id: row.id,
          text: buildIndexableText(row.name, row.signature, row.doc_comment),
        })),
      );
      invalidateBm25();
    }
  } catch {
    ftsAvailable = false;
  }

  let vectorsAvailable = false;
  try {
    if (vectorEmbeddingEnabled()) {
      db.exec(SYMBOL_VECTORS_TABLE_SQL);
      vectorsAvailable = true;
    } else {
      db.exec('DROP TABLE IF EXISTS symbol_vectors');
      vectorsAvailable = false;
    }
  } catch {
    vectorsAvailable = false;
  }

  ensureNextSymbolIdSeeded(stmt);
  return { ftsAvailable, vectorsAvailable };
}

export function ensureNextSymbolIdSeeded(
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
): void {
  const existing = stmt('SELECT value FROM metadata WHERE key = ?').get(NEXT_SYMBOL_ID_KEY) as
    | { value?: string }
    | undefined;
  if (existing?.value !== undefined) return;
  const maxRows = stmt('SELECT MAX(id) AS m FROM symbols').all() as {
    m: number | null;
  }[];
  const next = (maxRows[0]?.m ?? 0) + 1;
  stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(
    NEXT_SYMBOL_ID_KEY,
    String(next),
  );
}

export function allocateSymbolIds(
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  count: number,
  getMaxSymbolId: () => number,
): number {
  if (count <= 0) return getMaxSymbolId() + 1;
  ensureNextSymbolIdSeeded(stmt);
  const row = stmt('SELECT value FROM metadata WHERE key = ?').get(NEXT_SYMBOL_ID_KEY) as
    | { value?: string }
    | undefined;
  const start = Math.max(1, Number(row?.value ?? 1) || 1);
  stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(
    NEXT_SYMBOL_ID_KEY,
    String(start + count),
  );
  return start;
}
