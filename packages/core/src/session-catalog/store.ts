import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadDatabaseSync } from '../coordination/sqlite-mailbox-schema.js';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import type { SessionRegistryEntry } from '../session-registry-types.js';
import type { SessionEvent, SessionSummary } from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { isPidAlive } from '../utils/pid.js';
import type {
  CatalogSessionRecord,
  MaintenanceLease,
  ResumeReservation,
  SessionCatalogHealth,
  SessionLeaseCredential,
} from './protocol.js';
import {
  SESSION_CATALOG_DEFAULT_LEASE_MS,
  SESSION_CATALOG_DEFAULT_RESERVATION_MS,
  SESSION_CATALOG_MAX_AGENTS,
} from './protocol.js';

const SCHEMA_VERSION = 1;
const MAX_LEASE_MS = 120_000;
const MAX_RESERVATION_MS = 60_000;
const MAX_MAINTENANCE_MS = 5 * 60_000;
const MAX_PAGE = 1_000;

interface LeaseRow {
  session_id: string;
  lease_id: string;
  lease_secret_hash: string;
  owner_instance_id: string;
  owner_pid: number;
  owner_started_at: string;
  entry_json: string;
  agent_revision: number;
  status: SessionRegistryEntry['status'];
  last_heartbeat_at: number;
  lease_expires_at: number;
}

interface ReservationRow {
  reservation_id: string;
  target_session_id: string;
  requester_instance_id: string;
  current_session_id: string | null;
  expires_at: number;
}

interface CatalogRow {
  session_id: string;
  transcript_relative_path: string;
  summary_relative_path: string;
  summary_json: string;
  transcript_size: number;
  transcript_mtime_ms: number;
  summary_revision: number;
  indexed_at: string;
  damaged: number;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function secretMatches(secret: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function boundedMs(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1_000, Number.isFinite(value) ? Math.floor(value!) : fallback));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = 'SessionOwnershipConflictError';
  return error;
}

function assertId(value: string, label = 'session id'): void {
  if (
    !value ||
    value.length > 256 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.includes('..')
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function boundPresenceValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length <= 6_000 ? value : `${value.slice(0, 5_988)}…[truncated]`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8) return '[truncated depth]';
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => boundPresenceValue(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    result[key] = boundPresenceValue(item, depth + 1);
  }
  return result;
}

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
      this.walkFiles(this.sessionsDir, '.jsonl').some((file) => !file.endsWith('_index.jsonl'))
    ) {
      this.rebuildCatalog();
    }
  }

  private configureDatabase(): void {
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;',
    );
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        transcript_relative_path TEXT NOT NULL,
        summary_relative_path TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        transcript_size INTEGER NOT NULL DEFAULT 0,
        transcript_mtime_ms REAL NOT NULL DEFAULT 0,
        summary_revision INTEGER NOT NULL DEFAULT 1,
        indexed_at TEXT NOT NULL,
        damaged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_leases (
        session_id TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL UNIQUE,
        lease_secret_hash TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_started_at TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        agent_revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        last_heartbeat_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS resume_reservations (
        reservation_id TEXT PRIMARY KEY,
        target_session_id TEXT NOT NULL UNIQUE,
        requester_instance_id TEXT NOT NULL,
        current_session_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS maintenance_leases (
        session_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        lease_id TEXT NOT NULL UNIQUE,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(indexed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_leases_expiry ON session_leases(lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON resume_reservations(expires_at);
      CREATE INDEX IF NOT EXISTS idx_maintenance_expiry ON maintenance_leases(expires_at);
    `);
    this.db
      .prepare('INSERT INTO catalog_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING')
      .run('schema_version', String(SCHEMA_VERSION));
    this.db
      .prepare('INSERT INTO catalog_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING')
      .run('generation', '0');
    const row = this.db
      .prepare('SELECT value FROM catalog_meta WHERE key=?')
      .get('schema_version') as { value: string };
    if (Number(row.value) !== SCHEMA_VERSION)
      throw new Error(`Unsupported session catalog schema ${row.value}`);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
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
    this.db.prepare('DELETE FROM resume_reservations WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM maintenance_leases WHERE expires_at<=?').run(now);
    const rows = this.db
      .prepare('SELECT * FROM session_leases WHERE lease_expires_at<=?')
      .all(now) as unknown as LeaseRow[];
    for (const row of rows) {
      if (!isPidAlive(row.owner_pid)) {
        this.db
          .prepare('DELETE FROM session_leases WHERE session_id=? AND lease_id=?')
          .run(row.session_id, row.lease_id);
      } else if (row.status !== 'lost') {
        this.db
          .prepare("UPDATE session_leases SET status='lost' WHERE session_id=? AND lease_id=?")
          .run(row.session_id, row.lease_id);
      }
    }
  }

  private maintenanceExists(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 AS yes FROM maintenance_leases WHERE session_id=? AND expires_at>?')
        .get(sessionId, Date.now()),
    );
  }

  private leaseRow(sessionId: string): LeaseRow | undefined {
    return this.db
      .prepare('SELECT * FROM session_leases WHERE session_id=?')
      .get(sessionId) as unknown as LeaseRow | undefined;
  }

  private verifyCredential(credential: SessionLeaseCredential): LeaseRow {
    assertId(credential.sessionId);
    const row = this.leaseRow(credential.sessionId);
    if (
      !row ||
      row.lease_id !== credential.leaseId ||
      row.owner_instance_id !== credential.ownerInstanceId ||
      !secretMatches(credential.leaseSecret, row.lease_secret_hash)
    ) {
      throw conflict(`Session ${credential.sessionId} lease proof is invalid or no longer owned`);
    }
    return row;
  }

  private createLease(
    entry: SessionRegistryEntry,
    ownerInstanceId: string,
    leaseMs?: number,
  ): SessionLeaseCredential {
    assertId(entry.sessionId);
    if (!ownerInstanceId || ownerInstanceId.length > 256)
      throw new TypeError('Invalid owner instance id');
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0)
      throw new TypeError('Invalid owner pid');
    const now = Date.now();
    const leaseId = randomUUID();
    const leaseSecret = randomBytes(32).toString('hex');
    const expiresAt = now + boundedMs(leaseMs, SESSION_CATALOG_DEFAULT_LEASE_MS, MAX_LEASE_MS);
    this.db
      .prepare(`INSERT INTO session_leases(
      session_id,lease_id,lease_secret_hash,owner_instance_id,owner_pid,owner_started_at,
      entry_json,agent_revision,status,last_heartbeat_at,lease_expires_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        entry.sessionId,
        leaseId,
        hashSecret(leaseSecret),
        ownerInstanceId,
        entry.pid,
        entry.startedAt,
        JSON.stringify(entry),
        0,
        entry.status,
        now,
        expiresAt,
      );
    return { sessionId: entry.sessionId, leaseId, leaseSecret, ownerInstanceId, expiresAt };
  }

  claimNew(
    entry: SessionRegistryEntry,
    ownerInstanceId: string,
    leaseMs?: number,
  ): SessionLeaseCredential {
    return this.transaction(() => {
      this.reapExpired();
      const existing = this.leaseRow(entry.sessionId);
      if (existing)
        throw conflict(
          `Session ${entry.sessionId} is already open in another running wstack (pid ${existing.owner_pid}).`,
        );
      if (this.maintenanceExists(entry.sessionId))
        throw conflict(`Session ${entry.sessionId} is under maintenance`);
      const reserved = this.db
        .prepare(
          'SELECT 1 AS yes FROM resume_reservations WHERE target_session_id=? AND expires_at>?',
        )
        .get(entry.sessionId, Date.now());
      if (reserved) throw conflict(`Session ${entry.sessionId} is reserved for resume`);
      const credential = this.createLease(entry, ownerInstanceId, leaseMs);
      this.bumpGeneration();
      return credential;
    });
  }

  reconnectLease(credential: SessionLeaseCredential): SessionLeaseCredential {
    return this.transaction(() => {
      const row = this.verifyCredential(credential);
      if (row.owner_pid !== process.pid && !isPidAlive(row.owner_pid))
        throw conflict(`Session ${credential.sessionId} owner process is no longer alive`);
      const expiresAt = Date.now() + SESSION_CATALOG_DEFAULT_LEASE_MS;
      this.db
        .prepare(
          'UPDATE session_leases SET lease_expires_at=?,last_heartbeat_at=?,status=? WHERE session_id=? AND lease_id=?',
        )
        .run(
          expiresAt,
          Date.now(),
          row.status === 'lost' ? 'idle' : row.status,
          row.session_id,
          row.lease_id,
        );
      return { ...credential, expiresAt };
    });
  }

  reserveResume(
    targetSessionId: string,
    requesterInstanceId: string,
    currentSessionId?: string,
    reservationMs?: number,
  ): ResumeReservation {
    assertId(targetSessionId);
    return this.transaction(() => {
      this.reapExpired();
      const live = this.leaseRow(targetSessionId);
      if (live)
        throw conflict(
          `Session ${targetSessionId} is already open in another running wstack (pid ${live.owner_pid}).`,
        );
      if (this.maintenanceExists(targetSessionId))
        throw conflict(`Session ${targetSessionId} is under maintenance`);
      const catalog = this.db
        .prepare('SELECT 1 AS yes FROM sessions WHERE session_id=?')
        .get(targetSessionId);
      if (!catalog && !fs.existsSync(this.containedPath(`${targetSessionId}.jsonl`)))
        throw new Error(`Session not found: ${targetSessionId}`);
      const reservationId = randomUUID();
      const now = Date.now();
      const expiresAt =
        now + boundedMs(reservationMs, SESSION_CATALOG_DEFAULT_RESERVATION_MS, MAX_RESERVATION_MS);
      try {
        this.db
          .prepare(
            'INSERT INTO resume_reservations(reservation_id,target_session_id,requester_instance_id,current_session_id,created_at,expires_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            reservationId,
            targetSessionId,
            requesterInstanceId,
            currentSessionId ?? null,
            now,
            expiresAt,
          );
      } catch {
        throw conflict(`Session ${targetSessionId} is already reserved for resume`);
      }
      this.bumpGeneration();
      return { reservationId, targetSessionId, requesterInstanceId, expiresAt };
    });
  }

  activateReservation(
    reservation: ResumeReservation,
    entry: SessionRegistryEntry,
    leaseMs?: number,
  ): SessionLeaseCredential {
    return this.transaction(() => {
      this.reapExpired();
      const row = this.db
        .prepare('SELECT * FROM resume_reservations WHERE reservation_id=?')
        .get(reservation.reservationId) as unknown as ReservationRow | undefined;
      if (
        !row ||
        row.target_session_id !== reservation.targetSessionId ||
        row.requester_instance_id !== reservation.requesterInstanceId ||
        row.expires_at <= Date.now()
      )
        throw conflict('Resume reservation expired or is not owned by this requester');
      if (entry.sessionId !== row.target_session_id)
        throw new TypeError('Reservation target and session entry differ');
      if (this.leaseRow(entry.sessionId) || this.maintenanceExists(entry.sessionId))
        throw conflict(`Session ${entry.sessionId} can no longer be activated`);
      const credential = this.createLease(entry, reservation.requesterInstanceId, leaseMs);
      this.db
        .prepare('DELETE FROM resume_reservations WHERE reservation_id=?')
        .run(row.reservation_id);
      this.bumpGeneration();
      return credential;
    });
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
    return this.transaction(() => {
      const row = this.verifyCredential(credential);
      const expiresAt = Date.now() + SESSION_CATALOG_DEFAULT_LEASE_MS;
      const nextStatus =
        status ??
        (row.status === 'closing' ? 'closing' : row.status === 'lost' ? 'idle' : row.status);
      const entry = parseJson<SessionRegistryEntry>(row.entry_json);
      entry.status = nextStatus;
      entry.lastHeartbeatAt = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE session_leases SET status=?,entry_json=?,last_heartbeat_at=?,lease_expires_at=? WHERE session_id=? AND lease_id=?',
        )
        .run(
          nextStatus,
          JSON.stringify(entry),
          Date.now(),
          expiresAt,
          row.session_id,
          row.lease_id,
        );
      return { ...credential, expiresAt };
    });
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
    return this.transaction(() => {
      const row = this.verifyCredential(credential);
      if (revision <= row.agent_revision) return { accepted: false, revision: row.agent_revision };
      const entry = parseJson<SessionRegistryEntry>(row.entry_json);
      entry.agents = boundedAgents;
      entry.agentCount = boundedAgents.length;
      entry.status = boundedAgents.some((agent) => agent.status !== 'idle') ? 'active' : 'idle';
      entry.lastHeartbeatAt = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE session_leases SET entry_json=?,agent_revision=?,status=?,last_heartbeat_at=? WHERE session_id=? AND lease_id=?',
        )
        .run(
          JSON.stringify(entry),
          revision,
          entry.status,
          Date.now(),
          row.session_id,
          row.lease_id,
        );
      this.bumpGeneration();
      return { accepted: true, revision };
    });
  }

  markClosing(credential: SessionLeaseCredential): void {
    const row = this.verifyCredential(credential);
    const entry = parseJson<SessionRegistryEntry>(row.entry_json);
    entry.status = 'closing';
    entry.lastHeartbeatAt = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE session_leases SET status='closing',entry_json=?,last_heartbeat_at=? WHERE session_id=? AND lease_id=?",
      )
      .run(JSON.stringify(entry), Date.now(), row.session_id, row.lease_id);
    this.bumpGeneration();
  }

  release(credential: SessionLeaseCredential): void {
    this.transaction(() => {
      const row = this.verifyCredential(credential);
      this.db
        .prepare('DELETE FROM session_leases WHERE session_id=? AND lease_id=?')
        .run(row.session_id, row.lease_id);
      this.bumpGeneration();
    });
  }

  listLive(): SessionRegistryEntry[] {
    this.reapExpired();
    return (
      this.db
        .prepare(
          'SELECT entry_json,status,last_heartbeat_at FROM session_leases ORDER BY last_heartbeat_at DESC',
        )
        .all() as unknown as Array<{
        entry_json: string;
        status: SessionRegistryEntry['status'];
        last_heartbeat_at: number;
      }>
    ).map((row) => ({
      ...parseJson<SessionRegistryEntry>(row.entry_json),
      status: row.status,
      lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString(),
    }));
  }

  getLive(sessionId: string): SessionRegistryEntry | null {
    return this.listLive().find((entry) => entry.sessionId === sessionId) ?? null;
  }

  private containedPath(relative: string): string {
    assertId(relative.replace(/\.(jsonl|summary\.json)$/, ''), 'session path');
    const root = path.resolve(this.sessionsDir);
    const candidate = path.resolve(root, relative);
    const prefix = `${root}${path.sep}`;
    if (
      candidate !== root &&
      !(process.platform === 'win32'
        ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
        : candidate.startsWith(prefix))
    )
      throw new TypeError('Session path escapes sessions directory');
    return candidate;
  }

  upsertSummary(
    summary: SessionSummary,
    transcriptRelativePath = `${summary.id}.jsonl`,
    summaryRelativePath = `${summary.id}.summary.json`,
  ): CatalogSessionRecord {
    assertId(summary.id);
    summary = this.scrubber.scrubObject(summary);
    const normalizedTranscript = transcriptRelativePath.replaceAll('\\', '/');
    const normalizedSummary = summaryRelativePath.replaceAll('\\', '/');
    if (
      normalizedTranscript !== `${summary.id}.jsonl` ||
      normalizedSummary !== `${summary.id}.summary.json`
    ) {
      throw new TypeError('Session catalog paths must match the canonical session identity');
    }
    transcriptRelativePath = normalizedTranscript;
    summaryRelativePath = normalizedSummary;
    const transcript = this.containedPath(transcriptRelativePath);
    const stat = fs.existsSync(transcript) ? fs.statSync(transcript) : undefined;
    const now = new Date().toISOString();
    return this.transaction(() => {
      const prior = this.db
        .prepare('SELECT summary_revision FROM sessions WHERE session_id=?')
        .get(summary.id) as { summary_revision: number } | undefined;
      const revision = (prior?.summary_revision ?? 0) + 1;
      this.db
        .prepare(`INSERT INTO sessions(session_id,transcript_relative_path,summary_relative_path,summary_json,transcript_size,transcript_mtime_ms,summary_revision,indexed_at,damaged)
        VALUES (?,?,?,?,?,?,?,?,0) ON CONFLICT(session_id) DO UPDATE SET transcript_relative_path=excluded.transcript_relative_path,summary_relative_path=excluded.summary_relative_path,summary_json=excluded.summary_json,transcript_size=excluded.transcript_size,transcript_mtime_ms=excluded.transcript_mtime_ms,summary_revision=excluded.summary_revision,indexed_at=excluded.indexed_at,damaged=0`)
        .run(
          summary.id,
          transcriptRelativePath,
          summaryRelativePath,
          JSON.stringify(summary),
          stat?.size ?? 0,
          stat?.mtimeMs ?? 0,
          revision,
          now,
        );
      this.bumpGeneration();
      return {
        ...summary,
        transcriptRelativePath,
        summaryRelativePath,
        transcriptSize: stat?.size ?? 0,
        transcriptMtimeMs: stat?.mtimeMs ?? 0,
        summaryRevision: revision,
        indexedAt: now,
        damaged: false,
      };
    });
  }

  private catalogRecord(row: CatalogRow): CatalogSessionRecord {
    return {
      ...parseJson<SessionSummary>(row.summary_json),
      transcriptRelativePath: row.transcript_relative_path,
      summaryRelativePath: row.summary_relative_path,
      transcriptSize: row.transcript_size,
      transcriptMtimeMs: row.transcript_mtime_ms,
      summaryRevision: row.summary_revision,
      indexedAt: row.indexed_at,
      damaged: row.damaged !== 0,
    };
  }

  listCatalog(limit = 100, search?: string): CatalogSessionRecord[] {
    const bounded = Math.min(MAX_PAGE, Math.max(1, Math.floor(limit)));
    const rows = search?.trim()
      ? this.db
          .prepare(
            "SELECT * FROM sessions WHERE session_id LIKE ? OR json_extract(summary_json,'$.title') LIKE ? OR json_extract(summary_json,'$.name') LIKE ? ORDER BY COALESCE(json_extract(summary_json,'$.lastActivityAt'),json_extract(summary_json,'$.startedAt')) DESC LIMIT ?",
          )
          .all(`%${search.trim()}%`, `%${search.trim()}%`, `%${search.trim()}%`, bounded)
      : this.db
          .prepare(
            "SELECT * FROM sessions ORDER BY COALESCE(json_extract(summary_json,'$.lastActivityAt'),json_extract(summary_json,'$.startedAt')) DESC LIMIT ?",
          )
          .all(bounded);
    return (rows as unknown as CatalogRow[]).map((row) => this.catalogRecord(row));
  }

  getSummary(sessionId: string): CatalogSessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE session_id=?')
      .get(sessionId) as unknown as CatalogRow | undefined;
    return row ? this.catalogRecord(row) : null;
  }

  resolveId(query: string): string {
    const normalized = query.trim();
    if (!normalized) throw new Error('Session not found: (empty query)');
    if (this.getSummary(normalized)) return normalized;
    const rows = this.db
      .prepare(
        'SELECT session_id FROM sessions WHERE session_id LIKE ? OR session_id LIKE ? LIMIT 3',
      )
      .all(`%/${normalized}`, `${normalized}%`) as unknown as Array<{ session_id: string }>;
    const ids = [...new Set(rows.map((row) => row.session_id))];
    if (ids.length === 1) return ids[0]!;
    if (ids.length === 0) throw new Error(`Session not found: ${query}`);
    throw new Error(`Ambiguous session id "${query}": ${ids.join(', ')}`);
  }

  async rename(sessionId: string, name: string): Promise<CatalogSessionRecord> {
    const current = this.getSummary(this.resolveId(sessionId));
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    const trimmed = name.trim();
    const summary: SessionSummary = { ...current };
    for (const key of [
      'transcriptRelativePath',
      'summaryRelativePath',
      'transcriptSize',
      'transcriptMtimeMs',
      'summaryRevision',
      'indexedAt',
      'damaged',
    ] as const)
      delete (summary as unknown as Record<string, unknown>)[key];
    const previous: SessionSummary = { ...summary };
    if (trimmed) summary.name = this.scrubber.scrub(trimmed).slice(0, 500);
    else delete summary.name;
    const summaryPath = this.containedPath(current.summaryRelativePath);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true, mode: 0o700 });
    await atomicWrite(summaryPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
    try {
      return this.upsertSummary(
        summary,
        current.transcriptRelativePath,
        current.summaryRelativePath,
      );
    } catch (error) {
      await atomicWrite(summaryPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  acquireMaintenance(
    sessionId: string,
    operation: MaintenanceLease['operation'],
    holderId: string,
    leaseMs?: number,
  ): MaintenanceLease {
    assertId(sessionId);
    return this.transaction(() => {
      this.reapExpired();
      if (this.leaseRow(sessionId)) throw conflict(`Session ${sessionId} is live`);
      const reservation = this.db
        .prepare(
          'SELECT 1 AS yes FROM resume_reservations WHERE target_session_id=? AND expires_at>?',
        )
        .get(sessionId, Date.now());
      if (reservation) throw conflict(`Session ${sessionId} is reserved for resume`);
      const leaseId = randomUUID();
      const now = Date.now();
      const expiresAt = now + boundedMs(leaseMs, 60_000, MAX_MAINTENANCE_MS);
      try {
        this.db
          .prepare(
            'INSERT INTO maintenance_leases(session_id,operation,holder_id,lease_id,acquired_at,expires_at) VALUES (?,?,?,?,?,?)',
          )
          .run(sessionId, operation, holderId, leaseId, now, expiresAt);
      } catch {
        throw conflict(`Session ${sessionId} already has maintenance in progress`);
      }
      return { sessionId, operation, holderId, leaseId, expiresAt };
    });
  }

  releaseMaintenance(lease: MaintenanceLease): void {
    this.db
      .prepare('DELETE FROM maintenance_leases WHERE session_id=? AND lease_id=? AND holder_id=?')
      .run(lease.sessionId, lease.leaseId, lease.holderId);
  }

  delete(sessionId: string, lease: MaintenanceLease): void {
    const row = this.db
      .prepare(
        'SELECT * FROM maintenance_leases WHERE session_id=? AND lease_id=? AND holder_id=? AND operation=? AND expires_at>?',
      )
      .get(sessionId, lease.leaseId, lease.holderId, lease.operation, Date.now());
    if (!row || lease.operation !== 'delete')
      throw conflict('A valid delete maintenance lease is required');
    const record = this.getSummary(sessionId);
    if (!record) throw new Error(`Session not found: ${sessionId}`);

    // Stage every artifact by rename before committing the catalog deletion.
    // A failed filesystem step can therefore restore the exact prior paths;
    // irreversible removal happens only after the SQLite transaction commits.
    const transcript = this.containedPath(record.transcriptRelativePath);
    const artifacts = [
      transcript,
      this.containedPath(record.summaryRelativePath),
      this.containedPath(`${sessionId}.plan.json`),
      this.containedPath(`${sessionId}.tasks.json`),
      this.containedPath(`${sessionId}.todos.json`),
      path.join(path.dirname(transcript), path.basename(sessionId)),
    ];
    const trashRoot = path.join(this.sessionsDir, '_trash', lease.leaseId);
    fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const moved: Array<{ from: string; to: string }> = [];
    try {
      artifacts.forEach((artifact, index) => {
        if (!fs.existsSync(artifact)) return;
        const target = path.join(trashRoot, `${index}-${path.basename(artifact)}`);
        fs.renameSync(artifact, target);
        moved.push({ from: artifact, to: target });
      });
      this.transaction(() => {
        const current = this.db
          .prepare(
            'SELECT 1 AS yes FROM maintenance_leases WHERE session_id=? AND lease_id=? AND holder_id=? AND operation=? AND expires_at>?',
          )
          .get(sessionId, lease.leaseId, lease.holderId, 'delete', Date.now());
        if (!current) throw conflict('Delete maintenance lease expired while staging artifacts');
        this.db.prepare('DELETE FROM sessions WHERE session_id=?').run(sessionId);
        this.db.prepare('DELETE FROM maintenance_leases WHERE session_id=?').run(sessionId);
        this.bumpGeneration();
      });
    } catch (error) {
      for (const item of moved.reverse()) {
        try {
          fs.mkdirSync(path.dirname(item.from), { recursive: true, mode: 0o700 });
          fs.renameSync(item.to, item.from);
        } catch {
          // The staged copy remains under _trash for explicit recovery.
        }
      }
      throw error;
    }
    try {
      fs.rmSync(trashRoot, { recursive: true, force: true });
      const trashParent = path.dirname(trashRoot);
      if (fs.readdirSync(trashParent).length === 0) fs.rmdirSync(trashParent);
    } catch {
      // Catalog deletion committed; staged artifacts remain recoverable and
      // are excluded from reconciliation until a later hygiene pass.
    }
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
    const summaries = this.walkFiles(this.sessionsDir, '.summary.json');
    const transcripts = this.walkFiles(this.sessionsDir, '.jsonl').filter(
      (file) => !file.endsWith('_index.jsonl'),
    );
    const ids = new Set<string>();
    for (const file of [...summaries, ...transcripts]) {
      const relative = path.relative(this.sessionsDir, file).replaceAll('\\', '/');
      ids.add(relative.replace(/\.summary\.json$|\.jsonl$/, ''));
    }
    let indexed = 0;
    let damaged = 0;
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions').run();
      for (const id of ids) {
        try {
          const summaryFile = this.containedPath(`${id}.summary.json`);
          const summary = fs.existsSync(summaryFile)
            ? parseJson<SessionSummary>(fs.readFileSync(summaryFile, 'utf8'))
            : this.summarizeTranscript(id);
          if (!summary || summary.id !== id) throw new Error('summary identity mismatch');
          const transcript = this.containedPath(`${id}.jsonl`);
          const stat = fs.existsSync(transcript) ? fs.statSync(transcript) : undefined;
          const now = new Date().toISOString();
          this.db
            .prepare(
              'INSERT INTO sessions(session_id,transcript_relative_path,summary_relative_path,summary_json,transcript_size,transcript_mtime_ms,summary_revision,indexed_at,damaged) VALUES (?,?,?,?,?,?,?,?,0)',
            )
            .run(
              id,
              `${id}.jsonl`,
              `${id}.summary.json`,
              JSON.stringify(summary),
              stat?.size ?? 0,
              stat?.mtimeMs ?? 0,
              1,
              now,
            );
          indexed++;
        } catch {
          const now = new Date().toISOString();
          const fallback: SessionSummary = {
            id,
            title: id,
            startedAt: now,
            model: '',
            provider: '',
            tokenTotal: 0,
          };
          this.db
            .prepare(
              'INSERT INTO sessions(session_id,transcript_relative_path,summary_relative_path,summary_json,summary_revision,indexed_at,damaged) VALUES (?,?,?,?,1,?,1)',
            )
            .run(id, `${id}.jsonl`, `${id}.summary.json`, JSON.stringify(fallback), now);
          damaged++;
        }
      }
      this.db
        .prepare(
          "INSERT INTO catalog_meta(key,value) VALUES ('last_reconciliation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(new Date().toISOString());
      this.bumpGeneration();
    });
    return { indexed, damaged };
  }

  private walkFiles(root: string, suffix: string): string[] {
    const result: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== '_cas' && entry.name !== '_trash') visit(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith(suffix))
          result.push(path.join(dir, entry.name));
      }
    };
    visit(root);
    return result;
  }

  private summarizeTranscript(id: string): SessionSummary {
    const file = this.containedPath(`${id}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let start: Extract<SessionEvent, { type: 'session_start' }> | undefined;
    let endedAt: string | undefined;
    let lastActivityAt: string | undefined;
    let messageCount = 0;
    let iterationCount = 0;
    let toolCallCount = 0;
    let compactionCount = 0;
    let tokenTotal = 0;
    for (const line of lines) {
      if (!line) continue;
      let event: SessionEvent;
      try {
        event = parseJson<SessionEvent>(line);
      } catch {
        continue;
      }
      lastActivityAt = event.ts;
      if (event.type === 'session_start') start = event;
      if (event.type === 'session_end') endedAt = event.ts;
      if (
        event.type === 'message_appended' &&
        (event.message.role === 'user' || event.message.role === 'assistant')
      )
        messageCount++;
      if (event.type === 'llm_response') {
        iterationCount++;
        tokenTotal +=
          event.usage.input +
          event.usage.output +
          (event.usage.cacheRead ?? 0) +
          (event.usage.cacheWrite ?? 0);
      }
      if (event.type === 'tool_call_end') toolCallCount++;
      if (event.type === 'compaction') compactionCount++;
    }
    if (!start) throw new Error('missing session_start');
    return {
      id,
      title: id,
      startedAt: start.ts,
      ...(endedAt ? { endedAt } : {}),
      model: start.model,
      provider: start.provider,
      tokenTotal,
      ...(lastActivityAt ? { lastActivityAt } : {}),
      messageCount,
      iterationCount,
      toolCallCount,
      compactionCount,
    };
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
    this.reapExpired();
    const count = (table: string, where = ''): number =>
      Number(
        (
          this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as {
            count: number;
          }
        ).count,
      );
    const reconciliation = this.db
      .prepare("SELECT value FROM catalog_meta WHERE key='last_reconciliation'")
      .get() as { value: string } | undefined;
    return {
      ...base,
      catalogRows: count('sessions'),
      damagedRows: count('sessions', 'WHERE damaged<>0'),
      liveLeases: count('session_leases'),
      reservations: count('resume_reservations'),
      maintenanceLeases: count('maintenance_leases'),
      generation: this.generation(),
      ...(reconciliation ? { lastReconciliation: reconciliation.value } : {}),
    };
  }
}
