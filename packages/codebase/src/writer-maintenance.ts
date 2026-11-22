import type { DatabaseSync } from 'node:sqlite';

export const FTS_CHURN_KEY = 'fts_churn_since_maintain';

export function optimizeStore(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA optimize');
  } catch {
    /* optional */
  }
}

export function recordFtsChurn(
  ftsAvailable: boolean,
  getMetadata: (key: string) => string | undefined,
  setMetadata: (key: string, value: string) => void,
  rows: number,
): void {
  if (rows <= 0 || !ftsAvailable) return;
  try {
    const current = Number(getMetadata(FTS_CHURN_KEY) ?? '0') || 0;
    setMetadata(FTS_CHURN_KEY, String(current + rows));
  } catch {
    /* tracking must never fail the owning write */
  }
}

export function optimizeFtsIfNeeded(
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  ftsAvailable: boolean,
  getMetadata: (key: string) => string | undefined,
  setMetadata: (key: string, value: string) => void,
  runWithRetry: <T>(fn: () => T) => T,
  options: { minChurnRatio?: number; minChurnRows?: number } = {},
): boolean {
  if (!ftsAvailable) return false;
  try {
    const minChurnRatio = options.minChurnRatio ?? 0.1;
    const minChurnRows = options.minChurnRows ?? 5_000;
    const churn = Number(getMetadata(FTS_CHURN_KEY) ?? '0') || 0;
    const liveRows = Number(
      (stmt('SELECT COUNT(*) AS n FROM symbols').get() as { n?: number } | undefined)?.n ?? 0,
    );
    if (churn < Math.max(minChurnRows, liveRows * minChurnRatio)) return false;
    runWithRetry(() => {
      stmt(`INSERT INTO symbols_fts(symbols_fts) VALUES('optimize')`).run();
    });
    setMetadata(FTS_CHURN_KEY, '0');
    return true;
  } catch {
    // Maintenance must never fail its caller (mirrors checkpointWal).
    return false;
  }
}

export function checkpointWal(db: DatabaseSync): boolean {
  try {
    const probe = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as
      | { busy?: number }
      | undefined;
    if (Number(probe?.busy ?? 1) !== 0) return false;
    const done = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy?: number }
      | undefined;
    return Number(done?.busy ?? 1) === 0;
  } catch {
    return false;
  }
}

export function compactIfNeeded(
  db: DatabaseSync,
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>,
  runWithRetry: <T>(fn: () => T) => T,
  options: { minBytes?: number; minFreeRatio?: number } = {},
): boolean {
  const minBytes = options.minBytes ?? 256 * 1024 * 1024;
  const minFreeRatio = options.minFreeRatio ?? 0.35;
  try {
    const pageCount = Number(
      (stmt('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ?? 0,
    );
    const pageSize = Number(
      (stmt('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size ?? 0,
    );
    const freePages = Number(
      (stmt('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)
        ?.freelist_count ?? 0,
    );
    if (
      pageCount <= 0 ||
      pageSize <= 0 ||
      pageCount * pageSize < minBytes ||
      freePages / pageCount < minFreeRatio
    ) {
      return false;
    }
    runWithRetry(() => {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('VACUUM');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    });
    return true;
  } catch {
    return false;
  }
}
