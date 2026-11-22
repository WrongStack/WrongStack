import type { DatabaseSync } from 'node:sqlite';

import {
  checkpointWal as runCheckpointWal,
  compactIfNeeded as runCompactIfNeeded,
  optimizeFtsIfNeeded as runOptimizeFtsIfNeeded,
  recordFtsChurn as runRecordFtsChurn,
} from './writer-maintenance.js';

export interface IndexStoreMaintenanceHost {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  ftsAvailable: boolean;
  getMetadata: (key: string) => string | undefined;
  setMetadata: (key: string, value: string) => void;
  runWithRetry: <T>(fn: () => T) => T;
  db: DatabaseSync;
}
export function optimizeFtsIfNeeded(
  host: IndexStoreMaintenanceHost,
  options: { minChurnRatio?: number; minChurnRows?: number } = {},
): boolean {
  return runOptimizeFtsIfNeeded(
    (sql) => host.stmt(sql),
    host.ftsAvailable,
    (key) => host.getMetadata(key),
    (key, value) => host.setMetadata(key, value),
    (fn) => host.runWithRetry(fn),
    options,
  );
}

export function recordFtsChurn(host: IndexStoreMaintenanceHost, rows: number): void {
  runRecordFtsChurn(
    host.ftsAvailable,
    (key) => host.getMetadata(key),
    (key, value) => host.setMetadata(key, value),
    rows,
  );
}

export function checkpointWal(host: IndexStoreMaintenanceHost): boolean {
  return runCheckpointWal(host.db);
}

export function compactIfNeeded(
  host: IndexStoreMaintenanceHost,
  options: { minBytes?: number; minFreeRatio?: number } = {},
): boolean {
  return runCompactIfNeeded(
    host.db,
    (sql) => host.stmt(sql),
    (fn) => host.runWithRetry(fn),
    options,
  );
}
