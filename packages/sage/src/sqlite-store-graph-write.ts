import type { DatabaseSync } from 'node:sqlite';
import { writeSqliteAudit } from './sqlite-store-audit.js';
import { deleteSqliteSage } from './sqlite-store-delete.js';
import {
  syncAnchorEdges as delegateSyncAnchorEdges,
  type SqliteStoreGraphHost,
} from './sqlite-store-graph.js';
import { runSqliteSageHygiene } from './sqlite-store-hygiene.js';
import { rememberSqliteSage } from './sqlite-store-remember.js';
import { verifySqliteSage, verifySqliteSageForPaths } from './sqlite-store-verify.js';
import type {
  MemoryCandidate,
  MemoryVerificationResult,
  RememberSageInput,
  Sage,
  SageHygieneOptions,
  SageHygieneReport,
  SageStatus,
  SageStoreOptions,
} from './types.js';
export interface SqliteStoreGraphWriteHost {
  sqliteStoreGraphHost(): SqliteStoreGraphHost;
  projectRoot: string;
  initialize(): Promise<void>;
  nowIso(): string;
  stmt(sql: string): ReturnType<DatabaseSync['prepare']>;
  runMutation<T>(work: () => T, signal?: AbortSignal): Promise<T>;
  upsertMemory(m: Sage): void;
  syncAnchorEdges(memory: Sage): void;
  events: SageStoreOptions['events'];
  eventPayload<T extends object>(
    payload: T,
  ): T & { traceId?: string | undefined; sessionId?: string | undefined };
  runCompositeOperation<T>(work: () => Promise<T>): Promise<T>;
  currentTraceId(): string | undefined;
  auditWritesSincePrune: number;
  now: () => Date;
  listMemories(opts?: {
    status?: SageStatus | 'all';
    kind?: string;
    limit?: number;
    offset?: number;
  }): Promise<Sage[]>;
  listCandidates(includeResolved?: boolean): Promise<MemoryCandidate[]>;
  addCandidate(candidate: MemoryCandidate): Promise<void>;
  cascadeDeleteEdges(nodeId: string): void;
  audit(event: string, data?: Record<string, unknown>): void;
  pruneAuditLog(): void;
}

export function syncAnchorEdges(host: SqliteStoreGraphWriteHost, memory: Sage): void {
  delegateSyncAnchorEdges(host.sqliteStoreGraphHost(), memory);
}

export async function rememberSage(
  host: SqliteStoreGraphWriteHost,
  input: RememberSageInput,
): Promise<Sage> {
  return rememberSqliteSage({
    input,
    projectRoot: host.projectRoot,
    initialize: () => host.initialize(),
    nowIso: () => host.nowIso(),
    stmt: (sql) => host.stmt(sql),
    runMutation: (work) => host.runMutation(work),
    upsertMemory: (memory) => host.upsertMemory(memory),
    syncAnchorEdges: (memory) => host.syncAnchorEdges(memory),
    emit: (event, payload) =>
      host.events?.emit(event as never, host.eventPayload(payload) as never),
  });
}

export async function verify(
  host: SqliteStoreGraphWriteHost,
  memoryId?: string,
  signal?: AbortSignal,
): Promise<MemoryVerificationResult[]> {
  await host.initialize();
  return host.runCompositeOperation(() =>
    verifySqliteSage(
      {
        projectRoot: host.projectRoot,
        stmt: (sql) => host.stmt(sql),
        nowIso: () => host.nowIso(),
        runMutation: (work) => host.runMutation(work),
        upsertMemory: (memory) => host.upsertMemory(memory),
        syncAnchorEdges: (memory) => host.syncAnchorEdges(memory),
      },
      memoryId,
      signal,
    ),
  );
}

export async function verifyForPaths(
  host: SqliteStoreGraphWriteHost,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<MemoryVerificationResult[]> {
  await host.initialize();
  return host.runCompositeOperation(() =>
    verifySqliteSageForPaths(
      {
        projectRoot: host.projectRoot,
        stmt: (sql) => host.stmt(sql),
        nowIso: () => host.nowIso(),
        runMutation: (work) => host.runMutation(work),
        upsertMemory: (memory) => host.upsertMemory(memory),
        syncAnchorEdges: (memory) => host.syncAnchorEdges(memory),
      },
      paths,
      signal,
    ),
  );
}

export function audit(
  host: SqliteStoreGraphWriteHost,
  event: string,
  data?: Record<string, unknown>,
): void {
  writeSqliteAudit(
    {
      stmt: (sql) => host.stmt(sql),
      nowIso: () => host.nowIso(),
      getTraceId: () => host.currentTraceId(),
      getWritesSincePrune: () => host.auditWritesSincePrune,
      setWritesSincePrune: (value) => {
        host.auditWritesSincePrune = value;
      },
    },
    event,
    data,
  );
}

export async function hygiene(
  host: SqliteStoreGraphWriteHost,
  opts?: SageHygieneOptions,
): Promise<SageHygieneReport> {
  return host.runCompositeOperation(async () => {
    await host.initialize();
    return runSqliteSageHygiene(
      {
        projectRoot: host.projectRoot,
        stmt: (sql) => host.stmt(sql),
        now: () => host.now(),
        nowIso: () => host.nowIso(),
        listMemories: (listOpts) => host.listMemories(listOpts),
        listCandidates: (includeResolved) => host.listCandidates(includeResolved),
        addCandidate: (candidate) => host.addCandidate(candidate),
        runMutation: (work) => host.runMutation(work),
        upsertMemory: (memory) => host.upsertMemory(memory),
        syncAnchorEdges: (memory) => host.syncAnchorEdges(memory),
        cascadeDeleteEdges: (nodeId) => host.cascadeDeleteEdges(nodeId),
        audit: (event, data) => host.audit(event, data),
        pruneAuditLog: () => host.pruneAuditLog(),
      },
      opts,
    );
  });
}

export async function deleteSage(
  host: SqliteStoreGraphWriteHost,
  id: string,
  reason = 'Manually deleted via API.',
  options: { force?: boolean; neverInject?: boolean } = {},
): Promise<void> {
  await host.initialize();
  await host.runMutation(() => {
    deleteSqliteSage(
      {
        stmt: (sql) => host.stmt(sql),
        nowIso: () => host.nowIso(),
        upsertMemory: (memory) => host.upsertMemory(memory),
        cascadeDeleteEdges: (nodeId) => host.cascadeDeleteEdges(nodeId),
        audit: (event, data) => host.audit(event, data),
        emit: (event, payload) =>
          host.events?.emit(event as never, host.eventPayload(payload) as never),
      },
      id,
      reason,
      options,
    );
  });
}
