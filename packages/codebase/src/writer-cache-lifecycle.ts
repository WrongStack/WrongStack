import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { type Bm25Index, buildBm25Index } from './bm25.js';
import type { IndexStoreMaintenanceHost } from './index-store-maintenance.js';
import * as indexStoreMaintenance from './index-store-maintenance.js';
import { MAX_STATEMENT_CACHE, secondaryIndexNames } from './writer-cache-lifecycle-contracts.js';
import { REFS_INDEX_SQL, SYMBOL_INDEX_SQL } from './writer-schema.js';
export interface WriterCacheLifecycleHost {
  stmtCache: Map<string, StatementSync>;
  db: DatabaseSync;
  dataVersion(): number;
  bm25Cache: Bm25Index | null;
  bm25Dirty: boolean;
  bm25DataVersion: number;
  getAllIndexable(): Array<{ id: number; text: string }>;
  stmt(sql: string): ReturnType<DatabaseSync['prepare']>;
  runWithRetry<T>(fn: () => T): T;
  getMetadata(key: string): string | undefined;
  indexStoreMaintenanceHost(): IndexStoreMaintenanceHost;
}

export function stmt(
  host: WriterCacheLifecycleHost,
  sql: string,
): ReturnType<DatabaseSync['prepare']> {
  const cached = host.stmtCache.get(sql);
  if (cached !== undefined) {
    host.stmtCache.delete(sql);
    host.stmtCache.set(sql, cached);
    return cached;
  }
  const s = host.db.prepare(sql);
  host.stmtCache.set(sql, s);
  if (host.stmtCache.size > MAX_STATEMENT_CACHE) {
    const oldest = host.stmtCache.keys().next();
    if (!oldest.done) host.stmtCache.delete(oldest.value);
  }
  return s;
}

export function getOrBuildBm25(host: WriterCacheLifecycleHost): Bm25Index {
  const version = host.dataVersion();
  if (host.bm25Cache && !host.bm25Dirty && version === host.bm25DataVersion) {
    return host.bm25Cache;
  }
  const docs = host.getAllIndexable();
  host.bm25Cache = buildBm25Index(docs);
  host.bm25Dirty = false;
  host.bm25DataVersion = version;
  return host.bm25Cache;
}

export function dataVersion(host: WriterCacheLifecycleHost): number {
  try {
    const row = host.stmt('PRAGMA data_version').get() as { data_version?: number } | undefined;
    return Number(row?.data_version ?? -1);
  } catch {
    return -1;
  }
}

export function setLastIndexed(host: WriterCacheLifecycleHost, ts: number): void {
  host.runWithRetry(() => {
    host
      .stmt("INSERT OR REPLACE INTO metadata(key, value) VALUES('last_indexed', ?)")
      .run(String(ts));
  });
}

export function setMetadata(host: WriterCacheLifecycleHost, key: string, value: string): void {
  // Every index run re-asserts its data-version markers. Rewriting an equal
  // value still appends WAL frames and moves the database's mtime, which
  // made a run that changed nothing look like a new database to every
  // file-fingerprint cache (the WebUI Code Map's among them).
  if (host.getMetadata(key) === value) return;
  host.runWithRetry(() => {
    host.stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)').run(key, value);
  });
}

export function deferSecondaryIndexes(host: WriterCacheLifecycleHost): void {
  host.runWithRetry(() => {
    for (const name of secondaryIndexNames()) host.db.exec(`DROP INDEX IF EXISTS ${name}`);
  });
}

export function restoreSecondaryIndexes(host: WriterCacheLifecycleHost): void {
  host.runWithRetry(() => {
    for (const sql of [...SYMBOL_INDEX_SQL, ...REFS_INDEX_SQL]) host.db.exec(sql);
  });
}

export function optimizeFtsIfNeeded(
  host: WriterCacheLifecycleHost,
  options: { minChurnRatio?: number; minChurnRows?: number } = {},
): boolean {
  return indexStoreMaintenance.optimizeFtsIfNeeded(host.indexStoreMaintenanceHost(), options);
}

export function recordFtsChurn(host: WriterCacheLifecycleHost, rows: number): void {
  indexStoreMaintenance.recordFtsChurn(host.indexStoreMaintenanceHost(), rows);
}

export function checkpointWal(host: WriterCacheLifecycleHost): boolean {
  return indexStoreMaintenance.checkpointWal(host.indexStoreMaintenanceHost());
}

export function close(host: WriterCacheLifecycleHost): void {
  host.stmtCache.clear();
  host.bm25Dirty = true;
  host.bm25Cache = null;
  try {
    host.db.close();
  } catch {
    /* already closed */
  }
}
