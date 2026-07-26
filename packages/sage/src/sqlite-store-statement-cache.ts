import type { DatabaseSync } from 'node:sqlite';

type PreparedStatement = ReturnType<DatabaseSync['prepare']>;

/**
 * Small LRU wrapper for DatabaseSync prepared statements.
 *
 * DatabaseSync.prepare() recompiles SQL every call; SAGE hot paths reuse a
 * fixed set of statements thousands of times, while generated queries can
 * still vary enough to require a hard cap.
 */
export class SqliteStatementCache {
  private readonly cache = new Map<string, PreparedStatement>();

  constructor(private readonly maxEntries: number) {}

  get(db: DatabaseSync, sql: string): PreparedStatement {
    let prepared = this.cache.get(sql);
    if (prepared !== undefined) {
      this.cache.delete(sql);
      this.cache.set(sql, prepared);
      return prepared;
    }
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    prepared = db.prepare(sql);
    this.cache.set(sql, prepared);
    return prepared;
  }

  clear(): void {
    this.cache.clear();
  }
}
