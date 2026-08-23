/**
 * TechStack — SQLite-backed store.
 *
 * Provides persistence for snapshots, jobs, and the delivery outbox
 * using Node 22.5+'s built-in `node:sqlite` module.
 *
 * Store path: ~/.wrongstack/projects/<slug>/techstack/techstack.db
 *
 * @see docs/specs/techstack-sdd.md §3.2, §4.1
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  SageCachePragmas,
  withSqliteExperimentalWarningSuppressed,
  wstackGlobalRoot,
} from '@wrongstack/core/utils';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import type {
  DeliveryOutbox,
  DeliveryStatus,
  Finding,
  Snapshot,
  TechStackJob,
  TechStackJobProgress,
  TechStackJobStatus,
} from '../types.js';
import { applySchema } from './schema.js';

// ── SQLite loader ─────────────────────────────────────────────────────────

let DatabaseSyncCtor: typeof DatabaseSync | undefined;

/** Load SQLite lazily while suppressing only its module-load experimental warning. */
function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  try {
    return withSqliteExperimentalWarningSuppressed(() => {
      DatabaseSyncCtor = loadRuntimeDatabaseSync();
      return DatabaseSyncCtor;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      'TechStack SQLite store needs node:sqlite (Node >= 22.5) or bun:sqlite. ' +
        `This runtime doesn't provide it: ${message}`,
      { cause: error },
    );
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface StoreOptions {
  /** Project slug used for the store directory path. */
  readonly projectSlug: string;
  /** Optional explicit dbPath override (for testing). */
  readonly dbPath?: string;
}

// ── Store class ───────────────────────────────────────────────────────────

export class TechStackStore {
  private db: DatabaseSync;
  private dbPath: string;
  /** Compile-once cache for fixed SQL used on hot job/snapshot paths. */
  private readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(options: StoreOptions) {
    this.dbPath =
      options.dbPath ??
      join(wstackGlobalRoot(), 'projects', options.projectSlug, 'techstack', 'techstack.db');

    // Ensure parent directory exists
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const Database = loadDatabaseSync();
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
    // Sized from the shared perf profile like sage and codebase-index do.
    // These were hardcoded at 32 MiB / 128 MiB, which meant
    // WRONGSTACK_PERF_PROFILE=frugal had no effect on this store at all.
    const cache = SageCachePragmas();
    this.db.exec(`PRAGMA cache_size = -${cache.cacheSizeKiB};`);
    this.db.exec(`PRAGMA mmap_size = ${cache.mmapBytes};`);
    this.db.exec('PRAGMA foreign_keys = ON;');
    applySchema(this.db);
  }

  /** Prepare-once helper: compile `sql` on first use, reuse thereafter. */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let prepared = this.stmtCache.get(sql);
    if (prepared === undefined) {
      prepared = this.db.prepare(sql);
      this.stmtCache.set(sql, prepared);
    }
    return prepared;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Close the database connection. Idempotent. */
  close(): void {
    this.stmtCache.clear();
    try {
      this.db.close();
    } catch {
      // Already closed — idempotent
    }
  }

  /** Get the database path (useful for tests). */
  get path(): string {
    return this.dbPath;
  }

  // ── Snapshots ───────────────────────────────────────────────────────────

  /** Persist a snapshot. */
  saveSnapshot(snapshot: Snapshot): void {
    const stmt = this.stmt(`
      INSERT OR REPLACE INTO snapshots (id, project_id, target_root, fingerprint, created_at, raw_json, adapter_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      snapshot.id,
      snapshot.projectId,
      snapshot.targetRoot,
      snapshot.fingerprint,
      snapshot.createdAt,
      JSON.stringify(snapshot),
      snapshot.adapterVersion,
    );
  }

  /** Get a snapshot by project ID (latest). */
  getSnapshot(projectId: string): Snapshot | undefined {
    const stmt = this.stmt(`
      SELECT raw_json FROM snapshots
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(projectId) as { raw_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.raw_json) as Snapshot;
    } catch {
      return undefined;
    }
  }

  /** Get a snapshot by ID. */
  getSnapshotById(id: string): Snapshot | undefined {
    const stmt = this.stmt(`
      SELECT raw_json FROM snapshots WHERE id = ?
    `);
    const row = stmt.get(id) as { raw_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.raw_json) as Snapshot;
    } catch {
      return undefined;
    }
  }

  /** List all snapshots for a project (newest first). */
  listSnapshots(projectId: string, limit = 20): Snapshot[] {
    const stmt = this.stmt(`
      SELECT raw_json FROM snapshots
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as Array<{ raw_json: string }>;
    return rows
      .map((r) => {
        try {
          return JSON.parse(r.raw_json) as Snapshot;
        } catch {
          return undefined;
        }
      })
      .filter((s): s is Snapshot => s !== undefined);
  }

  /** Delete snapshots older than a given timestamp. */
  deleteSnapshotsBefore(projectId: string, before: string): number {
    const stmt = this.stmt(`
      DELETE FROM snapshots WHERE project_id = ? AND created_at < ?
    `);
    const result = stmt.run(projectId, before);
    return Number(result.changes);
  }

  // ── Jobs ────────────────────────────────────────────────────────────────

  /** Persist a job. */
  saveJob(job: TechStackJob): void {
    const stmt = this.stmt(`
      INSERT OR REPLACE INTO jobs
        (id, project_id, target_root, kind, status, fingerprint, requested_by, session_id, created_at, completed_at, error, progress_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      job.id,
      job.projectId,
      job.targetRoot,
      job.kind,
      job.status,
      job.fingerprint,
      job.requestedBy,
      job.sessionId ?? null,
      job.createdAt,
      job.completedAt ?? null,
      job.error ?? null,
      job.progress ? JSON.stringify(job.progress) : null,
    );
  }

  /** Get a job by ID. */
  getJob(id: string): TechStackJob | undefined {
    const stmt = this.stmt(`
      SELECT * FROM jobs WHERE id = ?
    `);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToJob(row);
  }

  /** Update job status and optional progress. */
  updateJobStatus(id: string, status: TechStackJobStatus, progress?: TechStackJobProgress): void {
    const progressJson = progress ? JSON.stringify(progress) : null;
    const completedAt =
      status === 'completed' || status === 'failed' || status === 'cancelled'
        ? new Date().toISOString()
        : null;

    const stmt = this.stmt(`
      UPDATE jobs
      SET status = ?, progress_json = ?, completed_at = COALESCE(?, completed_at)
      WHERE id = ?
    `);
    stmt.run(status, progressJson, completedAt, id);
  }

  /** List jobs for a project (newest first). */
  listJobs(projectId: string, limit = 50): TechStackJob[] {
    const stmt = this.stmt(`
      SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToJob(r));
  }

  // ── Outbox ──────────────────────────────────────────────────────────────

  /** Create an outbox entry. */
  createOutbox(deliveryId: string, reportId: string, sessionId: string): void {
    const stmt = this.stmt(`
      INSERT OR IGNORE INTO outbox (delivery_id, report_id, session_id, status, attempts)
      VALUES (?, ?, ?, 'pending', 0)
    `);
    stmt.run(deliveryId, reportId, sessionId);
  }

  /** Claim an outbox entry (atomic CAS). */
  claimOutbox(deliveryId: string, sessionId: string): boolean {
    const stmt = this.stmt(`
      UPDATE outbox
      SET status = 'claimed', claimed_at = datetime('now'), attempts = attempts + 1
      WHERE delivery_id = ? AND session_id = ? AND status = 'pending'
    `);
    const result = stmt.run(deliveryId, sessionId);
    return result.changes > 0;
  }

  /** Mark an outbox entry as delivered. */
  deliverOutbox(deliveryId: string): void {
    const stmt = this.stmt(`
      UPDATE outbox SET status = 'delivered', delivered_at = datetime('now')
      WHERE delivery_id = ?
    `);
    stmt.run(deliveryId);
  }

  /** Mark an outbox entry as failed. */
  failOutbox(deliveryId: string): void {
    const stmt = this.stmt(`
      UPDATE outbox SET status = 'failed' WHERE delivery_id = ?
    `);
    stmt.run(deliveryId);
  }

  /** List outbox entries by status. */
  listOutboxByStatus(status: DeliveryStatus): DeliveryOutbox[] {
    const stmt = this.stmt(`
      SELECT * FROM outbox WHERE status = ?
    `);
    const rows = stmt.all(status) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToOutbox(r));
  }

  // ── Research Cache Operations ───────────────────────────────────────────

  /** Get cached research findings by cache key (returns null if missing or expired). */
  getCachedResearch(cacheKey: string): readonly Finding[] | null {
    const stmt = this.stmt(`
      SELECT findings_json, expires_at FROM research_cache
      WHERE cache_key = ?
    `);
    const row = stmt.get(cacheKey) as { findings_json: string; expires_at: string } | undefined;
    if (!row) return null;

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.deleteCachedResearch(cacheKey);
      return null;
    }

    try {
      return JSON.parse(row.findings_json) as readonly Finding[];
    } catch {
      return null;
    }
  }

  /** Store research findings in cache with a TTL (defaults to 7 days). */
  setCachedResearch(
    cacheKey: string,
    findings: readonly Finding[],
    ttlMs: number = 7 * 24 * 60 * 60 * 1000,
  ): void {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const findingsJson = JSON.stringify(findings);
    const stmt = this.stmt(`
      INSERT INTO research_cache (cache_key, findings_json, created_at, expires_at)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        findings_json = excluded.findings_json,
        created_at = datetime('now'),
        expires_at = excluded.expires_at
    `);
    stmt.run(cacheKey, findingsJson, expiresAt);
  }

  /** Delete a specific cached research entry. */
  deleteCachedResearch(cacheKey: string): void {
    const stmt = this.stmt(`
      DELETE FROM research_cache WHERE cache_key = ?
    `);
    stmt.run(cacheKey);
  }

  /** Prune all expired research cache entries. */
  pruneExpiredResearchCache(): void {
    const nowIso = new Date().toISOString();
    const stmt = this.stmt(`
      DELETE FROM research_cache WHERE expires_at <= ?
    `);
    stmt.run(nowIso);
  }

  // ── Row mapping helpers ─────────────────────────────────────────────────

  private rowToJob(row: Record<string, unknown>): TechStackJob {
    let progress: TechStackJobProgress | undefined;
    if (row.progress_json && typeof row.progress_json === 'string') {
      try {
        progress = JSON.parse(row.progress_json) as TechStackJobProgress;
      } catch {
        // ignore
      }
    }

    return {
      id: String(row.id),
      projectId: String(row.project_id),
      targetRoot: String(row.target_root),
      kind: row.kind as TechStackJob['kind'],
      status: row.status as TechStackJobStatus,
      fingerprint: String(row.fingerprint ?? ''),
      requestedBy: String(row.requested_by ?? ''),
      sessionId: row.session_id ? String(row.session_id) : undefined,
      createdAt: String(row.created_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
      error: row.error ? String(row.error) : undefined,
      ...(progress ? { progress } : {}),
    };
  }

  private rowToOutbox(row: Record<string, unknown>): DeliveryOutbox {
    return {
      deliveryId: String(row.delivery_id),
      reportId: String(row.report_id),
      sessionId: String(row.session_id),
      status: row.status as DeliveryStatus,
      attempts: Number(row.attempts),
      claimedAt: row.claimed_at ? String(row.claimed_at) : undefined,
      deliveredAt: row.delivered_at ? String(row.delivered_at) : undefined,
    };
  }
}
