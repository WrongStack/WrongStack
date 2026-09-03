import { createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionRegistryEntry } from './session-registry-types.js';

/**
 * Bumped ONLY for breaking changes — a mismatch throws and takes the catalog
 * with it (`initializeCatalogSchema`), and there is no downgrade path.
 *
 * Purely additive tables do not qualify and must not bump it: every statement
 * below is `IF NOT EXISTS`, so a new binary adds what it needs on open and an
 * older binary reading the same file simply never queries the extra tables.
 * `session_agents` / `session_agent_index` were added this way.
 */
export const SCHEMA_VERSION = 1;
export const MAX_LEASE_MS = 120_000;
export const MAX_RESERVATION_MS = 60_000;
export const MAX_MAINTENANCE_MS = 5 * 60_000;
export const MAX_PAGE = 1_000;

export interface LeaseRow {
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

export interface ReservationRow {
  reservation_id: string;
  target_session_id: string;
  requester_instance_id: string;
  current_session_id: string | null;
  expires_at: number;
}

export interface SessionAgentRow {
  session_id: string;
  agent_id: string;
  role: string | null;
  provider: string | null;
  model: string | null;
  agent_session_id: string | null;
  transcript_path: string | null;
  parent_agent_id: string | null;
  spawned_at: string | null;
  ended_at: string | null;
  status: string;
  error: string | null;
  interleaved_event_count: number;
  usage_json: string | null;
  ordinal: number;
}

export interface CatalogRow {
  session_id: string;
  transcript_relative_path: string;
  summary_relative_path: string;
  summary_json: string;
  transcript_size: number;
  transcript_mtime_ms: number;
  summary_revision: number;
  indexed_at: string;
  damaged: number;
  storage_state?: string;
  codec?: string | null;
  uncompressed_size?: number;
  compressed_size?: number;
  content_sha256?: string | null;
  archived_at?: string | null;
}

export type SessionStorageState = 'hot' | 'cold';

export function ensureCatalogStorageColumns(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const have = new Set(cols.map((col) => col.name));
  const add: Array<[string, string]> = [
    ['storage_state', "TEXT NOT NULL DEFAULT 'hot'"],
    ['codec', 'TEXT'],
    ['uncompressed_size', 'INTEGER NOT NULL DEFAULT 0'],
    ['compressed_size', 'INTEGER NOT NULL DEFAULT 0'],
    ['content_sha256', 'TEXT'],
    ['archived_at', 'TEXT'],
  ];
  for (const [name, ddl] of add) {
    if (!have.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${ddl}`);
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretMatches(secret: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function boundedMs(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1_000, Number.isFinite(value) ? Math.floor(value!) : fallback));
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function conflict(message: string): Error {
  const error = new Error(message);
  error.name = 'SessionOwnershipConflictError';
  return error;
}

export function assertId(value: string, label = 'session id'): void {
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

export function boundPresenceValue(value: unknown, depth: number): unknown {
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

export function configureCatalogDatabase(db: DatabaseSync): void {
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;',
  );
}

export function initializeCatalogSchema(db: DatabaseSync): void {
  db.exec(`
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
      damaged INTEGER NOT NULL DEFAULT 0,
      storage_state TEXT NOT NULL DEFAULT 'hot',
      codec TEXT,
      uncompressed_size INTEGER NOT NULL DEFAULT 0,
      compressed_size INTEGER NOT NULL DEFAULT 0,
      content_sha256 TEXT,
      archived_at TEXT
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
    CREATE TABLE IF NOT EXISTS session_agents (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT,
      provider TEXT,
      model TEXT,
      agent_session_id TEXT,
      transcript_path TEXT,
      parent_agent_id TEXT,
      spawned_at TEXT,
      ended_at TEXT,
      status TEXT NOT NULL,
      error TEXT,
      interleaved_event_count INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      ordinal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS session_agent_index (
      session_id TEXT PRIMARY KEY,
      transcript_size INTEGER NOT NULL,
      transcript_mtime_ms REAL NOT NULL,
      derived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(indexed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leases_expiry ON session_leases(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON resume_reservations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_maintenance_expiry ON maintenance_leases(expires_at);
  `);
  ensureCatalogStorageColumns(db);
  db.prepare('INSERT INTO catalog_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
  db.prepare('INSERT INTO catalog_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(
    'generation',
    '0',
  );
  const row = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get('schema_version') as {
    value: string;
  };
  if (Number(row.value) !== SCHEMA_VERSION)
    throw new Error(`Unsupported session catalog schema ${row.value}`);
}
