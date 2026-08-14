import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_FIXED_OVERHEAD_BYTES = 16 * 1024 * 1024;
export const MIN_SQLITE_PAGE_BUDGET_BYTES = 64 * 1024;
export const MAX_WAL_RESERVE_BYTES = 32 * 1024 * 1024;
export const WAL_AUTOCHECKPOINT_PAGES = 2_000;
export const WAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

export class ChronicleStorageQuotaError extends Error {
  readonly currentBytes: number;
  readonly batchBytes: number;
  readonly maxBytes: number;
  readonly path: string;

  constructor(details: {
    currentBytes: number;
    batchBytes: number;
    maxBytes: number;
    path: string;
  }) {
    super(
      `Chronicle SQLite quota exceeded at ${details.path}: ${details.currentBytes} live bytes + ${details.batchBytes} batch bytes exceeds ${details.maxBytes}; lower chronicle retentionDays/maxEvents to shed data (run chronicle compact to return the freed pages to the filesystem)`,
    );
    this.name = 'ChronicleStorageQuotaError';
    this.currentBytes = details.currentBytes;
    this.batchBytes = details.batchBytes;
    this.maxBytes = details.maxBytes;
    this.path = details.path;
  }
}

export class ChronicleQuotaManager {
  private cachedPageSize: number | undefined;
  private quotaHeadroomBytes = 0;
  private bytesSinceQuotaCheck = Number.POSITIVE_INFINITY;

  constructor(
    private readonly db: DatabaseSync,
    private readonly dbPath: string,
    private readonly maxBytes: number | undefined,
  ) {}

  configure(): void {
    if (this.maxBytes === undefined) {
      this.db.exec('PRAGMA max_page_count = 2147483646');
      return;
    }
    const halfSplit = Math.floor((this.maxBytes - SQLITE_FIXED_OVERHEAD_BYTES) / 2);
    const sidecarReserve = Math.min(MAX_WAL_RESERVE_BYTES, halfSplit);
    const mainBudget = this.maxBytes - SQLITE_FIXED_OVERHEAD_BYTES - sidecarReserve;
    if (mainBudget < MIN_SQLITE_PAGE_BUDGET_BYTES) {
      throw new Error(
        `maxBytes must be at least ${SQLITE_FIXED_OVERHEAD_BYTES + 2 * MIN_SQLITE_PAGE_BUDGET_BYTES}`,
      );
    }
    const maxPages = Math.max(1, Math.floor(mainBudget / this.pageSizeBytes()));
    this.db.exec(`PRAGMA max_page_count = ${maxPages}`);
  }

  pageSizeBytes(): number {
    if (this.cachedPageSize === undefined) {
      this.cachedPageSize = Number(
        (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size,
      );
    }
    return this.cachedPageSize;
  }

  aggregateLiveBytes(): number {
    let total = 0;
    for (const file of [`${this.dbPath}-journal`, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        total += fs.statSync(file).size;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return total + this.mainDatabaseLiveBytes();
  }

  mainDatabaseLiveBytes(): number {
    const pageCount = Number(
      (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
    );
    const freelist = Number(
      (this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
    );
    return Math.max(0, pageCount - freelist) * this.pageSizeBytes();
  }

  invalidateEstimate(): void {
    this.quotaHeadroomBytes = 0;
    this.bytesSinceQuotaCheck = Number.POSITIVE_INFINITY;
  }

  recordAppendedBytes(bytes: number): void {
    this.bytesSinceQuotaCheck += bytes;
  }

  assertWithinByteQuota(batchBytes: number): void {
    if (this.maxBytes === undefined) return;
    if (!this.shouldMeasureQuota(batchBytes)) return;
    const currentBytes = this.aggregateLiveBytes();
    this.recordQuotaHeadroom(currentBytes);
    if (currentBytes + batchBytes <= this.maxBytes) return;
    throw new ChronicleStorageQuotaError({
      currentBytes,
      batchBytes,
      maxBytes: this.maxBytes,
      path: this.dbPath,
    });
  }

  assertActualAllocationWithinQuota(): void {
    if (this.maxBytes === undefined) return;
    if (!this.shouldMeasureQuota()) return;
    const currentBytes = this.aggregateLiveBytes();
    this.recordQuotaHeadroom(currentBytes);
    if (currentBytes <= this.maxBytes) return;
    throw new ChronicleStorageQuotaError({
      currentBytes,
      batchBytes: 0,
      maxBytes: this.maxBytes,
      path: this.dbPath,
    });
  }

  normalizeQuotaError(error: unknown): unknown {
    if (this.maxBytes === undefined || !(error instanceof Error)) return error;
    const sqliteError = error as Error & { code?: string | number; errcode?: number };
    const quotaExhausted =
      sqliteError.code === 'SQLITE_FULL' ||
      sqliteError.code === 13 ||
      sqliteError.errcode === 13 ||
      /database or disk is full/i.test(sqliteError.message);
    if (!quotaExhausted) return error;
    return new ChronicleStorageQuotaError({
      currentBytes: this.aggregateLiveBytes(),
      batchBytes: 0,
      maxBytes: this.maxBytes,
      path: this.dbPath,
    });
  }

  private shouldMeasureQuota(batchBytes = 0): boolean {
    return this.bytesSinceQuotaCheck + batchBytes >= this.quotaHeadroomBytes / 2;
  }

  private recordQuotaHeadroom(currentBytes: number): void {
    this.quotaHeadroomBytes = Math.max(0, (this.maxBytes ?? 0) - currentBytes);
    this.bytesSinceQuotaCheck = 0;
  }
}
