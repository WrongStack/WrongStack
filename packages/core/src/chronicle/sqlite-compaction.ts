import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { isPidAlive } from '../utils/pid.js';
import { withSqliteExperimentalWarningSuppressed } from '../utils/sqlite-warning.js';

export interface ChronicleSqliteCompactionOptions {
  dbPath: string;
  endpointMetadataPath?: string;
}

export interface ChronicleSqliteCompactionResult {
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
}

export class ChronicleCompactionBusyError extends Error {
  constructor(pid: number) {
    super(`Chronicle project server is still running (pid ${pid}); stop it before compacting`);
    this.name = 'ChronicleCompactionBusyError';
  }
}

/** Aggregate allocated bytes for the SQLite database and its WAL/SHM sidecars. */
export function chronicleSqliteAllocatedBytes(dbPath: string): number {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, file) => {
    try {
      return total + statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return total;
      throw error;
    }
  }, 0);
}

/**
 * Reclaim free SQLite pages. The caller must keep the Chronicle project server
 * stopped for the entire operation; this function refuses known live servers.
 */
export function compactChronicleSqlite(
  options: ChronicleSqliteCompactionOptions,
): ChronicleSqliteCompactionResult {
  assertProjectServerStopped(options.endpointMetadataPath);
  const beforeBytes = chronicleSqliteAllocatedBytes(options.dbPath);
  if (!existsSync(options.dbPath)) {
    return { beforeBytes, afterBytes: beforeBytes, reclaimedBytes: 0 };
  }

  const Database = withSqliteExperimentalWarningSuppressed(loadRuntimeDatabaseSync);
  const db = new Database(options.dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 1');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  const afterBytes = chronicleSqliteAllocatedBytes(options.dbPath);
  return {
    beforeBytes,
    afterBytes,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
  };
}

function assertProjectServerStopped(endpointMetadataPath: string | undefined): void {
  if (!endpointMetadataPath || !existsSync(endpointMetadataPath)) return;
  try {
    const metadata = JSON.parse(readFileSync(endpointMetadataPath, 'utf8')) as { pid?: unknown };
    if (typeof metadata.pid === 'number' && isPidAlive(metadata.pid)) {
      throw new ChronicleCompactionBusyError(metadata.pid);
    }
  } catch (error) {
    if (error instanceof ChronicleCompactionBusyError) throw error;
    // Stale or malformed metadata does not prove a live writer. SQLite's own
    // exclusive maintenance operations remain the final concurrency guard.
  }
}
