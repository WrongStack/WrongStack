import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import type { SessionSummary } from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';
import type {
  CatalogSessionRecord,
  MaintenanceLease,
  SessionCatalogHealth,
  SessionCatalogListArgs,
} from './protocol.js';
import { foreignLiveLease, getLeaseRow, reapExpiredCatalogEntries } from './store-leases.js';
import {
  assertId,
  boundedMs,
  type CatalogRow,
  conflict,
  MAX_MAINTENANCE_MS,
  MAX_PAGE,
} from './store-schema.js';

export function listCatalogRecords(
  db: DatabaseSync,
  criteria: SessionCatalogListArgs = {},
  catalogRecord: (row: CatalogRow) => CatalogSessionRecord,
): CatalogSessionRecord[] {
  const requestedLimit = criteria.limit ?? 100;
  if (!Number.isFinite(requestedLimit)) throw new TypeError('Invalid session catalog limit');
  const bounded = Math.min(MAX_PAGE, Math.max(1, Math.floor(requestedLimit)));
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  const jsonText = (field: string): string =>
    `CASE WHEN json_valid(summary_json) THEN json_extract(summary_json,'$.${field}') END`;
  const literalLike = (value: string): string =>
    `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const search = criteria.search?.trim();
  if (search) {
    const pattern = literalLike(search);
    clauses.push(
      `(session_id LIKE ? ESCAPE '\\' OR ${jsonText('title')} LIKE ? ESCAPE '\\' OR ${jsonText('name')} LIKE ? ESCAPE '\\')`,
    );
    values.push(pattern, pattern, pattern);
  }
  if (criteria.since) {
    clauses.push(`${jsonText('startedAt')}>=?`);
    values.push(criteria.since);
  }
  if (criteria.until) {
    clauses.push(`${jsonText('startedAt')}<=?`);
    values.push(criteria.until);
  }
  if (criteria.provider) {
    clauses.push(`${jsonText('provider')}=?`);
    values.push(criteria.provider);
  }
  if (criteria.model) {
    clauses.push(`${jsonText('model')}=?`);
    values.push(criteria.model);
  }
  if (criteria.minTokens !== undefined) {
    if (!Number.isFinite(criteria.minTokens)) throw new TypeError('Invalid minimum token count');
    clauses.push(`CAST(COALESCE(${jsonText('tokenTotal')},0) AS REAL)>=?`);
    values.push(criteria.minTokens);
  }
  if (criteria.titleContains) {
    clauses.push(`${jsonText('title')} LIKE ? ESCAPE '\\'`);
    values.push(literalLike(criteria.titleContains.toLocaleLowerCase()));
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM sessions${where} ORDER BY COALESCE(${jsonText('lastActivityAt')},${jsonText('endedAt')},${jsonText('startedAt')}) DESC,${jsonText('startedAt')} DESC,session_id ASC LIMIT ?`,
    )
    .all(...values, bounded);
  return (rows as unknown as CatalogRow[]).map((row) => catalogRecord(row));
}

export function resolveSessionId(
  db: DatabaseSync,
  query: string,
  hasSummary: (id: string) => boolean,
): string {
  const normalized = query.trim();
  if (!normalized) throw new Error('Session not found: (empty query)');
  if (hasSummary(normalized)) return normalized;
  const rows = db
    .prepare('SELECT session_id FROM sessions WHERE session_id LIKE ? OR session_id LIKE ? LIMIT 3')
    .all(`%/${normalized}`, `${normalized}%`) as unknown as Array<{ session_id: string }>;
  const ids = [...new Set(rows.map((row) => row.session_id))];
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 0) throw new Error(`Session not found: ${query}`);
  throw new Error(`Ambiguous session id "${query}": ${ids.join(', ')}`);
}

export async function renameSessionSummary(
  current: CatalogSessionRecord,
  name: string,
  scrubber: DefaultSecretScrubber,
  containedPath: (rel: string) => string,
  upsertSummary: (
    summary: SessionSummary,
    transcriptRelativePath?: string,
    summaryRelativePath?: string,
  ) => CatalogSessionRecord,
): Promise<CatalogSessionRecord> {
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
    'storageState',
    'codec',
    'uncompressedSize',
    'compressedSize',
    'contentSha256',
    'archivedAt',
  ] as const)
    delete (summary as unknown as Record<string, unknown>)[key];
  const previous: SessionSummary = { ...summary };
  if (trimmed) summary.name = scrubber.scrub(trimmed).slice(0, 500);
  else delete summary.name;
  const summaryPath = containedPath(current.summaryRelativePath);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true, mode: 0o700 });
  await atomicWrite(summaryPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  try {
    return upsertSummary(summary, current.transcriptRelativePath, current.summaryRelativePath);
  } catch (error) {
    await atomicWrite(summaryPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 }).catch(
      () => undefined,
    );
    throw error;
  }
}

export function executeAcquireMaintenance(
  db: DatabaseSync,
  sessionId: string,
  operation: MaintenanceLease['operation'],
  holderId: string,
  leaseMs?: number,
  holderPid?: number,
): MaintenanceLease {
  assertId(sessionId);
  reapExpiredCatalogEntries(db);
  const live = getLeaseRow(db, sessionId);
  if (
    live &&
    (operation === 'delete' ||
      operation === 'archive' ||
      operation === 'rehydrate' ||
      foreignLiveLease(db, sessionId, holderPid))
  ) {
    throw conflict(`Session ${sessionId} is live`);
  }
  const reservation = db
    .prepare('SELECT 1 AS yes FROM resume_reservations WHERE target_session_id=? AND expires_at>?')
    .get(sessionId, Date.now());
  if (reservation) throw conflict(`Session ${sessionId} is reserved for resume`);
  const leaseId = randomUUID();
  const now = Date.now();
  const expiresAt = now + boundedMs(leaseMs, 60_000, MAX_MAINTENANCE_MS);
  try {
    db.prepare(
      'INSERT INTO maintenance_leases(session_id,operation,holder_id,lease_id,acquired_at,expires_at) VALUES (?,?,?,?,?,?)',
    ).run(sessionId, operation, holderId, leaseId, now, expiresAt);
  } catch {
    throw conflict(`Session ${sessionId} already has maintenance in progress`);
  }
  return { sessionId, operation, holderId, leaseId, expiresAt };
}

export function executeDeleteSession(
  db: DatabaseSync,
  sessionsDir: string,
  sessionId: string,
  lease: MaintenanceLease,
  record: CatalogSessionRecord,
  containedPath: (rel: string) => string,
  transaction: <T>(run: () => T) => T,
  bumpGeneration: () => number,
): void {
  const row = db
    .prepare(
      'SELECT * FROM maintenance_leases WHERE session_id=? AND lease_id=? AND holder_id=? AND operation=? AND expires_at>?',
    )
    .get(sessionId, lease.leaseId, lease.holderId, lease.operation, Date.now());
  if (!row || lease.operation !== 'delete')
    throw conflict('A valid delete maintenance lease is required');

  const transcript = containedPath(record.transcriptRelativePath);
  const artifacts = [
    transcript,
    containedPath(`${sessionId}.jsonl`),
    containedPath(`${sessionId}.jsonl.gz`),
    containedPath(record.summaryRelativePath),
    containedPath(`${sessionId}.plan.json`),
    containedPath(`${sessionId}.tasks.json`),
    containedPath(`${sessionId}.todos.json`),
    path.join(path.dirname(transcript), path.basename(sessionId)),
  ];
  const trashRoot = path.join(sessionsDir, '_trash', lease.leaseId);
  fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const moved: Array<{ from: string; to: string }> = [];
  try {
    artifacts.forEach((artifact, index) => {
      if (!fs.existsSync(artifact)) return;
      const target = path.join(trashRoot, `${index}-${path.basename(artifact)}`);
      fs.renameSync(artifact, target);
      moved.push({ from: artifact, to: target });
    });
    transaction(() => {
      const current = db
        .prepare(
          'SELECT 1 AS yes FROM maintenance_leases WHERE session_id=? AND lease_id=? AND holder_id=? AND operation=? AND expires_at>?',
        )
        .get(sessionId, lease.leaseId, lease.holderId, 'delete', Date.now());
      if (!current) throw conflict('Delete maintenance lease expired while staging artifacts');
      db.prepare('DELETE FROM sessions WHERE session_id=?').run(sessionId);
      db.prepare('DELETE FROM maintenance_leases WHERE session_id=?').run(sessionId);
      bumpGeneration();
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
    // Catalog deletion committed
  }
}

export function computeCatalogHealth(
  db: DatabaseSync,
  generation: number,
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
  reapExpiredCatalogEntries(db);
  const count = (table: string, where = ''): number =>
    Number(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as {
          count: number;
        }
      ).count,
    );
  const reconciliation = db
    .prepare("SELECT value FROM catalog_meta WHERE key='last_reconciliation'")
    .get() as { value: string } | undefined;
  return {
    ...base,
    catalogRows: count('sessions'),
    damagedRows: count('sessions', 'WHERE damaged<>0'),
    liveLeases: count('session_leases'),
    reservations: count('resume_reservations'),
    maintenanceLeases: count('maintenance_leases'),
    generation,
    ...(reconciliation ? { lastReconciliation: reconciliation.value } : {}),
  };
}
