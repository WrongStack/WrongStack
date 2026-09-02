import * as fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  isMigratableAuditRecord,
  isMigratableCandidate,
  isMigratableEdge,
  isMigratableMemoryRecord,
  shouldReplaceMigratedMemory,
} from './sqlite-store-legacy.js';
import {
  readLegacyJsonlRecords,
  readSqliteSageRow,
  sqliteRowToCandidate,
} from './sqlite-store-codec.js';
import { LEGACY_JSONL_MIGRATION_KEY } from './sqlite-store-schema.js';
import { normalizeTextKey } from './store-helpers.js';
import type { MemoryCandidate, MemoryGraphEdge, Sage, SageStoreOptions } from './types.js';

type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

export async function migrateSqliteLegacyJsonl(input: {
  paths: ReturnType<typeof import('./paths.js').resolveSagePaths>;
  db: DatabaseSync;
  stmt(sql: string): SqliteStatement;
  nowIso(): string;
  traceId?: SageStoreOptions['traceId'];
  upsertMemory(memory: Sage): void;
  syncAnchorEdges(memory: Sage): void;
}): Promise<void> {
  const { paths, db, stmt, nowIso, traceId, upsertMemory, syncAnchorEdges } = input;
  const legacyPaths = [paths.memoriesLog, paths.candidatesLog, paths.edgesLog, paths.auditLog];
  if (!legacyPaths.some((filePath) => fs.existsSync(filePath))) return;

  const alreadyMigrated = stmt('SELECT value FROM schema_meta WHERE key = ?').get(
    LEGACY_JSONL_MIGRATION_KEY,
  );
  if (alreadyMigrated) return;

  const [memoryRows, candidateRows, edgeRows, auditRows] = await Promise.all([
    readLegacyJsonlRecords<unknown>(paths.memoriesLog, nowIso),
    readLegacyJsonlRecords<unknown>(paths.candidatesLog, nowIso),
    readLegacyJsonlRecords<unknown>(paths.edgesLog, nowIso),
    readLegacyJsonlRecords<unknown>(paths.auditLog, nowIso),
  ]);

  const latestMemories = new Map<string, Sage>();
  for (const row of memoryRows) {
    if (!isMigratableMemoryRecord(row)) continue;
    const incoming = row.memory;
    const current = latestMemories.get(incoming.id);
    if (!current || shouldReplaceMigratedMemory(current, incoming)) {
      latestMemories.set(incoming.id, incoming);
    }
  }

  const latestCandidates = new Map<string, MemoryCandidate>();
  for (const row of candidateRows) {
    if (isMigratableCandidate(row)) latestCandidates.set(row.id, row);
  }

  const latestEdges = new Map<string, MemoryGraphEdge>();
  for (const row of edgeRows) {
    if (isMigratableEdge(row)) latestEdges.set(row.id, row);
  }

  const audits = auditRows.filter(isMigratableAuditRecord);
  let migratedMemories = 0;
  let migratedCandidates = 0;
  let migratedEdges = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    const migratedByPeer = stmt('SELECT value FROM schema_meta WHERE key = ?').get(
      LEGACY_JSONL_MIGRATION_KEY,
    );
    if (migratedByPeer) {
      db.exec('COMMIT');
      return;
    }

    for (const incoming of latestMemories.values()) {
      const existing = readSqliteSageRow(stmt, incoming.id);
      if (existing && !shouldReplaceMigratedMemory(existing, incoming)) continue;
      upsertMemory(incoming);
      syncAnchorEdges(incoming);
      migratedMemories++;
    }

    const upsertCandidate = stmt(
      `INSERT OR REPLACE INTO candidates
        (id, data, status, created_at, updated_at, canonical_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const candidate of latestCandidates.values()) {
      const existingRow = stmt('SELECT data FROM candidates WHERE id = ?').get(candidate.id) as
        | { data: string }
        | undefined;
      if (existingRow) {
        const existing = sqliteRowToCandidate(existingRow);
        // Byte comparison (locale-safe): keep the newer candidate when both
        // the JSONL replay and the SQLite row claim the same id. ISO-8601
        // timestamps sort lexicographically; `localeCompare` can reorder them
        // across locales (see shared/pagination.ts).
        if (existing.updatedAt > candidate.updatedAt) continue;
      }
      upsertCandidate.run(
        candidate.id,
        JSON.stringify(candidate),
        candidate.status,
        candidate.createdAt,
        candidate.updatedAt,
        normalizeTextKey(candidate.text),
      );
      migratedCandidates++;
    }

    const upsertEdge = stmt(
      `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(from_node, to_node, relation) DO UPDATE SET
         weight = excluded.weight`,
    );
    // EXEMPTION from the monotone MAX policy (see sqlite-store-schema.ts): the
    // JSONL migration is a REPLAY of historical edges, not a live merge — the
    // persisted legacy weight is the source of truth and must win verbatim.
    const deleteEdge = stmt(
      'DELETE FROM edges WHERE from_node = ? AND to_node = ? AND relation = ?',
    );
    for (const edge of latestEdges.values()) {
      if (edge.deletedAt) {
        deleteEdge.run(edge.from, edge.to, edge.relation);
        continue;
      }
      upsertEdge.run(edge.from, edge.to, edge.relation, edge.weight, edge.createdAt);
      migratedEdges++;
    }

    const insertAudit = stmt(
      'INSERT INTO audit_log (event, at, trace_id, data) VALUES (?, ?, ?, ?)',
    );
    for (const audit of audits) {
      insertAudit.run(audit.event, audit.at, audit.traceId ?? null, JSON.stringify(audit));
    }

    insertAudit.run(
      'memory.legacy_jsonl_migrated',
      nowIso(),
      traceId ?? null,
      JSON.stringify({
        memories: migratedMemories,
        candidates: migratedCandidates,
        edges: migratedEdges,
        auditRecords: audits.length,
      }),
    );
    stmt('INSERT INTO schema_meta (key, value) VALUES (?, 1)').run(LEGACY_JSONL_MIGRATION_KEY);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
