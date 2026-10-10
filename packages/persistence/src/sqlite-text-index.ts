import type { DatabaseSync } from 'node:sqlite';

export interface SqliteTextIndex {
  table: string;
  key: string;
  source: string;
  field: string;
  column: string;
  revision?: string;
}

function identifiers(index: SqliteTextIndex): void {
  for (const value of [index.table, index.key, index.source, index.field, index.column]) {
    if (!/^[a-z_][a-z_0-9]*$/i.test(value)) throw new Error('Invalid SQLite text index identifier');
  }
}

/** Additive migration; older writers invalidate the cache through the same trigger. */
export function initializeSqliteTextIndex(db: DatabaseSync, index: SqliteTextIndex): void {
  identifiers(index);
  const { table, key, source, field, column } = index;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ws_text_index_revisions (name TEXT PRIMARY KEY, revision TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_${table}_${column}_pending
      ON ${table}(${key}) WHERE ${column} IS NULL;
    CREATE TRIGGER IF NOT EXISTS ${table}_${column}_invalidate
      AFTER UPDATE OF ${source} ON ${table}
      WHEN (CASE WHEN json_valid(OLD.${source}) THEN json_extract(OLD.${source}, '$.${field}') END)
        IS NOT (CASE WHEN json_valid(NEW.${source}) THEN json_extract(NEW.${source}, '$.${field}') END)
      BEGIN UPDATE ${table} SET ${column}=NULL WHERE ${key}=NEW.${key}; END;
  `);
}

/** Refresh and read in one snapshot, preserving a caller's outer transaction. */
export function withSqliteTextIndex<T>(
  stmt: DatabaseSync['prepare'],
  index: SqliteTextIndex,
  fold: (value: unknown) => string,
  read: () => T,
): T {
  identifiers(index);
  const { table, key, source, field, column } = index;
  const savepoint = 'ws_text_index';
  stmt(`SAVEPOINT ${savepoint}`).run();
  try {
    if (index.revision) {
      const name = `${table}.${column}`;
      const current = stmt('SELECT revision FROM ws_text_index_revisions WHERE name=?').get(name) as
        | { revision: string }
        | undefined;
      if (current?.revision !== index.revision) {
        stmt(`UPDATE ${table} SET ${column}=NULL`).run();
        stmt(
          'INSERT INTO ws_text_index_revisions(name,revision) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision',
        ).run(name, index.revision);
      }
    }
    const pending = stmt(
      `SELECT ${key} AS key, CASE WHEN json_valid(${source})
       THEN json_extract(${source}, '$.${field}') END AS text
       FROM ${table} WHERE ${column} IS NULL`,
    ).all() as Array<{ key: string; text: unknown }>;
    if (pending.length > 0) {
      const update = stmt(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`);
      for (const row of pending) update.run(fold(row.text), row.key);
    }
    const result = read();
    stmt(`RELEASE ${savepoint}`).run();
    return result;
  } catch (error) {
    stmt(`ROLLBACK TO ${savepoint}`).run();
    stmt(`RELEASE ${savepoint}`).run();
    throw error;
  }
}
