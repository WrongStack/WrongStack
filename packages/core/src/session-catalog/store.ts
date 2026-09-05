import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadDatabaseSync } from '../coordination/sqlite-mailbox-schema.js';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import type { SessionSummary } from '../types/session.js';
import type {
  CatalogSessionRecord,
  MaintenanceLease,
  ResumeReservation,
  SessionCatalogHealth,
  SessionCatalogListArgs,
  SessionLeaseCredential,
} from './protocol.js';
import { SESSION_CATALOG_MAX_AGENTS } from './protocol.js';
import type { SessionAgentRecord } from './session-agents.js';
import type { SessionRegistryEntry } from './session-registry-types.js';
import { getSessionAgentsList } from './store-agents.js';
import {
  executeActivateReservation,
  executeClaimNew,
  executeHeartbeat,
  executeMarkClosing,
  executePublishAgents,
  executeReconnectLease,
  executeReleaseLease,
  executeRenewReservation,
  executeReserveResume,
  queryLiveLeases,
  reapExpiredCatalogEntries,
} from './store-leases.js';
import {
  computeCatalogHealth,
  executeAcquireMaintenance,
  executeDeleteSession,
  listCatalogRecords,
  renameSessionSummary,
  resolveSessionId,
} from './store-maintenance.js';
import { rebuildCatalogIndex, walkSessionFiles } from './store-rebuild.js';
import {
  boundPresenceValue,
  type CatalogRow,
  configureCatalogDatabase,
  initializeCatalogSchema,
} from './store-schema.js';
import { executeUpsertSummary, resolveContainedPath, toCatalogRecord } from './store-summary.js';

export class SessionCatalogStore {
  readonly databasePath: string;
  readonly sessionsDir: string;
  private db: DatabaseSync;
  private readonly scrubber = new DefaultSecretScrubber();

  constructor(readonly projectDir: string) {
    this.sessionsDir = path.join(projectDir, 'sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    this.databasePath = path.join(this.sessionsDir, 'catalog.sqlite');
    const Database = loadDatabaseSync();
    this.db = new Database(this.databasePath);
    try {
      this.configureDatabase();
      this.initialize();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(
          message,
        )
      ) {
        this.db.close();
        throw error;
      }
      this.db.close();
      const quarantine = `${this.databasePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.databasePath, quarantine);
      } catch {
        /* preserve original error if recovery cannot proceed */
      }
      for (const suffix of ['-wal', '-shm']) {
        try {
          fs.renameSync(`${this.databasePath}${suffix}`, `${quarantine}${suffix}`);
        } catch {
          /* optional sidecar */
        }
      }
      this.db = new Database(this.databasePath);
      this.configureDatabase();
      this.initialize();
    }
    this.reapExpired();
    const rowCount = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count,
    );
    if (
      rowCount === 0 &&
      (walkSessionFiles(this.sessionsDir, '.jsonl').some(
        (file) => !file.endsWith('_index.jsonl') && !file.endsWith('.replay.jsonl'),
      ) ||
        walkSessionFiles(this.sessionsDir, '.jsonl.gz').length > 0)
    ) {
      this.rebuildCatalog();
    }
  }

  private configureDatabase(): void {
    configureCatalogDatabase(this.db);
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    initializeCatalogSchema(this.db);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite can end a transaction when a write (including COMMIT) fails.
        // Preserve that original disk/database error instead of masking it with
        // a follow-up rollback failure.
      }
      throw error;
    }
  }

  private bumpGeneration(): number {
    this.db
      .prepare("UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'")
      .run();
    return this.generation();
  }

  generation(): number {
    const row = this.db.prepare("SELECT value FROM catalog_meta WHERE key='generation'").get() as {
      value: string;
    };
    return Number(row.value) || 0;
  }

  private reapExpired(now = Date.now()): void {
    reapExpiredCatalogEntries(this.db, now);
  }

  claimNew(
    entry: SessionRegistryEntry,
    ownerInstanceId: string,
    leaseMs?: number,
  ): SessionLeaseCredential {
    return this.transaction(() =>
      executeClaimNew(this.db, entry, ownerInstanceId, () => this.bumpGeneration(), leaseMs),
    );
  }

  reconnectLease(credential: SessionLeaseCredential): SessionLeaseCredential {
    return this.transaction(() => executeReconnectLease(this.db, credential));
  }

  reserveResume(
    targetSessionId: string,
    requesterInstanceId: string,
    currentSessionId?: string,
    reservationMs?: number,
  ): ResumeReservation {
    return this.transaction(() =>
      executeReserveResume(
        this.db,
        targetSessionId,
        requesterInstanceId,
        (id) =>
          fs.existsSync(this.containedPath(`${id}.jsonl`)) ||
          fs.existsSync(this.containedPath(`${id}.jsonl.gz`)),
        () => this.bumpGeneration(),
        currentSessionId,
        reservationMs,
      ),
    );
  }

  activateReservation(
    reservation: ResumeReservation,
    entry: SessionRegistryEntry,
    leaseMs?: number,
  ): SessionLeaseCredential {
    return this.transaction(() =>
      executeActivateReservation(this.db, reservation, entry, () => this.bumpGeneration(), leaseMs),
    );
  }

  /**
   * Extend a live reservation the requester still owns.
   *
   * Deliberately does NOT call `reapExpired()` first: reaping would delete an
   * already-expired row and turn the accurate "expired" answer into the
   * indistinguishable "not owned by this requester". The caller needs to know
   * which of the two happened.
   */
  renewReservation(
    reservationId: string,
    requesterInstanceId: string,
    reservationMs?: number,
  ): ResumeReservation {
    return this.transaction(() =>
      executeRenewReservation(this.db, reservationId, requesterInstanceId, reservationMs),
    );
  }

  cancelReservation(reservationId: string, requesterInstanceId: string): void {
    this.db
      .prepare('DELETE FROM resume_reservations WHERE reservation_id=? AND requester_instance_id=?')
      .run(reservationId, requesterInstanceId);
  }

  heartbeat(
    credential: SessionLeaseCredential,
    status?: SessionRegistryEntry['status'],
  ): SessionLeaseCredential {
    return this.transaction(() => executeHeartbeat(this.db, credential, status));
  }

  publishAgents(
    credential: SessionLeaseCredential,
    revision: number,
    agents: SessionRegistryEntry['agents'],
  ): { accepted: boolean; revision: number } {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new TypeError('Invalid presence revision');
    if (!Array.isArray(agents) || agents.length > SESSION_CATALOG_MAX_AGENTS)
      throw new TypeError(`Agent snapshot exceeds ${SESSION_CATALOG_MAX_AGENTS} agents`);
    const boundedAgents = boundPresenceValue(
      this.scrubber.scrubObject(agents),
      0,
    ) as SessionRegistryEntry['agents'];
    const encoded = JSON.stringify(boundedAgents);
    if (encoded.length > 1024 * 1024) throw new TypeError('Agent snapshot exceeds 1 MiB');
    return this.transaction(() =>
      executePublishAgents(this.db, credential, revision, boundedAgents, () =>
        this.bumpGeneration(),
      ),
    );
  }

  markClosing(credential: SessionLeaseCredential): void {
    executeMarkClosing(this.db, credential, () => this.bumpGeneration());
  }

  release(credential: SessionLeaseCredential): void {
    this.transaction(() => executeReleaseLease(this.db, credential, () => this.bumpGeneration()));
  }

  listLive(): SessionRegistryEntry[] {
    return queryLiveLeases(this.db);
  }

  getLive(sessionId: string): SessionRegistryEntry | null {
    return this.listLive().find((entry) => entry.sessionId === sessionId) ?? null;
  }

  private containedPath(relative: string): string {
    return resolveContainedPath(this.sessionsDir, relative);
  }

  upsertSummary(
    summary: SessionSummary,
    transcriptRelativePath = `${summary.id}.jsonl`,
    summaryRelativePath = `${summary.id}.summary.json`,
    storage?: {
      storageState?: 'hot' | 'cold' | undefined;
      codec?: 'gzip' | undefined;
      uncompressedSize?: number | undefined;
      compressedSize?: number | undefined;
      contentSha256?: string | undefined;
      archivedAt?: string | null | undefined;
    },
  ): CatalogSessionRecord {
    return this.transaction(() =>
      executeUpsertSummary(
        this.db,
        this.sessionsDir,
        this.scrubber,
        summary,
        transcriptRelativePath,
        summaryRelativePath,
        storage,
        () => this.bumpGeneration(),
      ),
    );
  }

  private catalogRecord(row: CatalogRow): CatalogSessionRecord {
    return toCatalogRecord(row);
  }

  listCatalog(criteria: SessionCatalogListArgs = {}): CatalogSessionRecord[] {
    return listCatalogRecords(this.db, criteria, (row) => this.catalogRecord(row));
  }

  getSummary(sessionId: string): CatalogSessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE session_id=?')
      .get(sessionId) as unknown as CatalogRow | undefined;
    return row ? this.catalogRecord(row) : null;
  }

  /**
   * The agent roster of one session, derived from its journal.
   *
   * Cached in `session_agents`, keyed to the transcript's size and mtime: the
   * journal is the authority, so the cache is a memo of a pure function over
   * it rather than a second place agents get recorded. When the file has grown
   * (the usual case — a live session) the rows are re-derived from scratch, so
   * a partial read can never leave a half-updated roster behind.
   *
   * Returns `[]` for a session with no transcript on disk. A caller cannot
   * distinguish that from "a real session that spawned nothing", and should
   * not need to: both mean there is no agent to show.
   */
  listSessionAgents(sessionId: string): SessionAgentRecord[] {
    return getSessionAgentsList(
      this.db,
      this.sessionsDir,
      sessionId,
      (id) => this.getSummary(id)?.transcriptRelativePath,
      <T>(run: () => T) => this.transaction(run),
    );
  }

  resolveId(query: string): string {
    return resolveSessionId(this.db, query, (id) => Boolean(this.getSummary(id)));
  }

  async rename(sessionId: string, name: string): Promise<CatalogSessionRecord> {
    const current = this.getSummary(this.resolveId(sessionId));
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    return renameSessionSummary(
      current,
      name,
      this.scrubber,
      (rel) => this.containedPath(rel),
      (summary, transcriptRel, summaryRel) =>
        this.upsertSummary(summary, transcriptRel, summaryRel),
    );
  }

  acquireMaintenance(
    sessionId: string,
    operation: MaintenanceLease['operation'],
    holderId: string,
    leaseMs?: number,
    holderPid?: number,
  ): MaintenanceLease {
    return this.transaction(() =>
      executeAcquireMaintenance(this.db, sessionId, operation, holderId, leaseMs, holderPid),
    );
  }

  releaseMaintenance(lease: MaintenanceLease): void {
    this.db
      .prepare('DELETE FROM maintenance_leases WHERE session_id=? AND lease_id=? AND holder_id=?')
      .run(lease.sessionId, lease.leaseId, lease.holderId);
  }

  delete(sessionId: string, lease: MaintenanceLease): void {
    const record = this.getSummary(sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);
    executeDeleteSession(
      this.db,
      this.sessionsDir,
      sessionId,
      lease,
      record,
      (rel) => this.containedPath(rel),
      <T>(run: () => T) => this.transaction(run),
      () => this.bumpGeneration(),
    );
  }

  prune(maxAgeDays: number, holderId: string): number {
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new TypeError('Invalid prune age');
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const candidates = this.db
      .prepare('SELECT session_id FROM sessions WHERE transcript_mtime_ms<?')
      .all(cutoff) as unknown as Array<{ session_id: string }>;
    let deleted = 0;
    for (const { session_id: id } of candidates) {
      try {
        const lease = this.acquireMaintenance(id, 'delete', holderId);
        this.delete(id, lease);
        deleted++;
      } catch (error) {
        if ((error as Error).name !== 'SessionOwnershipConflictError') throw error;
      }
    }
    return deleted;
  }

  rebuildCatalog(): { indexed: number; damaged: number } {
    return rebuildCatalogIndex(
      this.db,
      this.sessionsDir,
      (rel) => this.containedPath(rel),
      <T>(run: () => T) => this.transaction(run),
      () => this.bumpGeneration(),
    );
  }

  health(
    base: Omit<
      SessionCatalogHealth,
      | 'catalogRows'
      | 'damagedRows'
      | 'liveLeases'
      | 'reservations'
      | 'maintenanceLeases'
      | 'generation'
      | 'lastReconciliation'
    >,
  ): SessionCatalogHealth {
    return computeCatalogHealth(this.db, this.generation(), base);
  }
}
