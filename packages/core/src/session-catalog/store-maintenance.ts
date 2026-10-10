import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withSqliteTextIndex } from '@wrongstack/persistence';
import { removePathSync } from '@wrongstack/primitives';
import type { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import {
  resolveSessionId as resolveAmongCandidates,
  sessionIdResolutionError,
} from '../storage/session-id-resolver.js';
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
import { catalogTitleIndex } from './store-text-index.js';

export function listCatalogRecords(
  db: DatabaseSync,
  criteria: SessionCatalogListArgs = {},
  catalogRecord: (row: CatalogRow) => CatalogSessionRecord,
): CatalogSessionRecord[] {
  const read = () => readCatalogRecords(db, criteria, catalogRecord);
  return criteria.titleContains
    ? withSqliteTextIndex(
        db.prepare.bind(db),
        catalogTitleIndex,
        (value) => (value == null ? '' : String(value).toLocaleLowerCase()),
        read,
      )
    : read();
}

function readCatalogRecords(
  db: DatabaseSync,
  criteria: SessionCatalogListArgs,
  catalogRecord: (row: CatalogRow) => CatalogSessionRecord,
): CatalogSessionRecord[] {
  const requestedLimit = criteria.limit ?? 100;
  if (!Number.isFinite(requestedLimit)) throw new TypeError('Invalid session catalog limit');
  // Floor at 0, NOT 1: `clampListLimit` (storage/session-store/list-sessions.ts)
  // normalizes an untrusted caller limit so that 0 and negative both mean an
  // EMPTY PAGE, explicitly "matching the catalog RPC's bounded limit" — the
  // in-process backend gets that for free from `slice(0, 0)`. A floor of 1 here
  // made `limit: 0` (and every negative limit) answer with the single NEWEST
  // session on the catalog path while the scan path answered with none, so the
  // same `sessionStore.list(0)` returned different rows depending on whether
  // the catalog daemon was running.
  const bounded = Math.min(MAX_PAGE, Math.max(0, Math.floor(requestedLimit)));
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
    clauses.push("unicode_title LIKE ? ESCAPE '\\'");
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
  // SQL only PREFILTERS; the decision is the file-backed store's resolver, so
  // `--resume <id>` answers the same with or without the catalog daemon. The
  // old SQL decided itself: it had no leaf-prefix match (`sess_01JX…` was
  // "not found"), and the unescaped LIKE treated `_`/`%` as wildcards and
  // folded case. Escaped here; the resolver's exact comparisons drop the
  // case-folded extras.
  const literal = normalized.replace(/\\/g, '/').replaceAll('%', '\\%').replaceAll('_', '\\_');
  const rows = db
    .prepare(
      "SELECT session_id FROM sessions WHERE session_id LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\'",
    )
    .all(`${literal}%`, `%/${literal}%`) as unknown as Array<{ session_id: string }>;
  const resolution = resolveAmongCandidates(
    normalized,
    rows.map((row) => row.session_id),
  );
  if (resolution.status === 'resolved') return resolution.id;
  throw sessionIdResolutionError(resolution);
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
    storage?: {
      storageState?: 'hot' | 'cold' | undefined;
      codec?: 'gzip' | undefined;
      uncompressedSize?: number | undefined;
      compressedSize?: number | undefined;
      contentSha256?: string | undefined;
      archivedAt?: string | null | undefined;
    },
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
  // A rename must not mutate storage identity. ExecuteUpsertSummary re-derives
  // contentSha256 (`storage?.contentSha256` -> null) and archivedAt
  // (`storage?.archivedAt ?? now`) from the optional storage block, so those
  // fields are forwarded verbatim from the current record: dropping them
  // silently destroyed a cold session's integrity hash and reset its archive
  // timestamp on every rename. The transcript itself is not moved by a rename,
  // so the preserved sizes are still authoritative.
  const storage = {
    storageState: current.storageState,
    codec: current.codec,
    uncompressedSize: current.uncompressedSize,
    compressedSize: current.compressedSize,
    contentSha256: current.contentSha256,
    archivedAt: current.archivedAt,
  };
  const summaryPath = containedPath(current.summaryRelativePath);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true, mode: 0o700 });
  await atomicWrite(summaryPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
  try {
    return upsertSummary(
      summary,
      current.transcriptRelativePath,
      current.summaryRelativePath,
      storage,
    );
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
      operation === 'move' ||
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
  const hotRedoStash = containedPath(`${sessionId}.jsonl.redo`);
  const artifacts = [
    transcript,
    containedPath(`${sessionId}.jsonl`),
    containedPath(`${sessionId}.jsonl.gz`),
    containedPath(record.summaryRelativePath),
    containedPath(`${sessionId}.plan.json`),
    containedPath(`${sessionId}.tasks.json`),
    containedPath(`${sessionId}.todos.json`),
    containedPath(`${sessionId}.completed-work.json`),
    containedPath(`${sessionId}.replay.jsonl`),
    containedPath(`${sessionId}.annotations.json`),
    containedPath(`${sessionId}.annotations.jsonl`),
    containedPath(`${sessionId}.audit.jsonl`),
    `${transcript}.redo`,
    hotRedoStash,
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
    removePathSync(trashRoot, { recursive: true, force: true });
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
