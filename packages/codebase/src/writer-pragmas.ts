import type { DatabaseSync } from 'node:sqlite';
import { sqliteCachePragmas } from '@wrongstack/core/utils';

export function applyIndexStorePragmas(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 15000');
    db.exec('PRAGMA temp_store = MEMORY');
    const cache = sqliteCachePragmas();
    db.exec(`PRAGMA cache_size = -${cache.cacheSizeKiB}`);
    db.exec(`PRAGMA mmap_size = ${cache.mmapBytes}`);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_size_limit = 67108864');
    db.exec('PRAGMA wal_autocheckpoint = 1000');
  } catch {
    /* pragmas are best-effort; old SQLite builds without WAL still work */
  }
}
