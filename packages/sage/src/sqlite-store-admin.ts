import type { DatabaseSync } from 'node:sqlite';
import { readSqliteSageRow, sqliteRowToMemory } from './sqlite-store-codec.js';
import { findSqliteMemoriesForFile } from './sqlite-store-find-file.js';
import { backfillRecoverableSqliteSage, recoverSqliteSage } from './sqlite-store-recovery.js';
import type {
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  MemoryCandidate,
  MemoryGraphRelation,
  Sage,
  SageBackfillOptions,
  SageBackfillReport,
} from './types.js';

export interface SqliteAdminHost {
  projectRoot: string;
  now(): Date;
  nowIso(): string;
  stmt(sql: string): ReturnType<DatabaseSync['prepare']>;
  runMutation<T>(work: () => T): Promise<T>;
  upsertMemory(memory: Sage): void;
  syncAnchorEdges(memory: Sage): void;
  audit(event: string, data?: Record<string, unknown>): void;
  emit(event: string, payload: Record<string, unknown>): void;
  listCandidates(): Promise<MemoryCandidate[]>;
}

function getMemory(host: SqliteAdminHost, id: string): Sage | null {
  return readSqliteSageRow(host.stmt, id);
}

function listMemories(host: SqliteAdminHost): Sage[] {
  const rows = host.stmt('SELECT data FROM memories ORDER BY updated_at DESC').all() as Array<{
    data: string;
  }>;
  return rows.map((row) => sqliteRowToMemory(row));
}

function addRelationshipEdge(
  host: SqliteAdminHost,
  fromId: string,
  toId: string,
  relation: MemoryGraphRelation,
  createdAt: string,
): void {
  host
    .stmt(
      `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(from_node, to_node, relation) DO UPDATE SET
         weight = MAX(weight, excluded.weight)`,
    )
    .run(`mem:${fromId}`, `mem:${toId}`, relation, createdAt);
}

function recoveryContext(host: SqliteAdminHost) {
  return {
    nowIso: () => host.nowIso(),
    getMemory: (id: string) => getMemory(host, id),
    listMemories: () => listMemories(host),
    runMutation: <T>(work: () => T) => host.runMutation(work),
    upsertMemory: (memory: Sage) => host.upsertMemory(memory),
    syncAnchorEdges: (memory: Sage) => host.syncAnchorEdges(memory),
    addSupersedesEdge: (fromId: string, toId: string, createdAt: string) =>
      addRelationshipEdge(host, fromId, toId, 'supersedes', createdAt),
    audit: (event: string, data?: Record<string, unknown>) => host.audit(event, data),
    emit: (event: string, payload: Record<string, unknown>) => host.emit(event, payload),
  };
}

export function recoverAdminSage(
  host: SqliteAdminHost,
  id: string,
  reason?: string,
): Promise<Sage> {
  return recoverSqliteSage(recoveryContext(host), id, reason);
}

export function backfillAdminSage(
  host: SqliteAdminHost,
  options?: SageBackfillOptions,
): Promise<SageBackfillReport> {
  return backfillRecoverableSqliteSage(recoveryContext(host), options);
}

export function findAdminMemoriesForFile(
  host: SqliteAdminHost,
  filePath: string,
  options?: FindMemoriesForFileOptions,
): Promise<FindMemoriesForFileResponse> {
  return findSqliteMemoriesForFile(
    {
      projectRoot: host.projectRoot,
      listMemories: () => listMemories(host),
      listCandidates: () => host.listCandidates(),
      now: () => host.now(),
    },
    filePath,
    options,
  );
}
