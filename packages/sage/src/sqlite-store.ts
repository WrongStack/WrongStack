/**
 * SQLite-backed SAGE store.
 *
 * Replaces the JSONL full-load-on-every-op pattern with an indexed database.
 * Uses `node:sqlite` (DatabaseSync), WAL mode, and FTS5 for full-text search.
 *
 * The schema stores the full Sage object as JSON in a `memories` table
 * (primary index on id, with indexes on status, kind, scope, importance,
 * updatedAt) plus an FTS5 virtual table over the searchable text.  Graph edges
 * are stored in an `edges` table with indexes on from/to nodes.
 *
 * On first open, if a legacy `memories.jsonl` exists and the SQLite db is empty,
 * the store migrates records automatically (one-time cost).
 */
import * as path from 'node:path';
import type { MemoryEntry, MemoryScope, MemoryStore } from '@wrongstack/contracts/types';
import type { HqSageRecord } from '@wrongstack/hq';
import type { SageDoctorOptions, SageDoctorReport } from './memory-doctor-types.js';
import type { VectorAugmentHit } from './retrieval/vector-augment.js';
import type { SearchOptions, SearchQuery, SearchResult } from './service-contract.js';
import {
  applyHqSync as applyHqSyncFromHost,
  clear as clearFromHost,
  consolidate as consolidateFromHost,
  forget as forgetFromHost,
  hardDeleteSage as hardDeleteSageFromHost,
  recordInjection as recordInjectionFromHost,
  recordUse as recordUseFromHost,
  updateSage as updateSageFromHost,
} from './sqlite-memory-mutations.js';
import { readSqliteAudit } from './sqlite-store-audit.js';
import { getCompatSage, listCompatSage } from './sqlite-store-compat.js';
import { SqliteSageStoreCore } from './sqlite-store-core.js';
import { runSqliteSageDoctor } from './sqlite-store-doctor.js';
import {
  findRelatedSqliteSage,
  type SqliteFindRelatedOptions,
} from './sqlite-store-find-related.js';
import {
  addGraphEdge as delegateAddGraphEdge,
  graphFor as delegateGraphFor,
} from './sqlite-store-graph.js';
import { traverseSqliteGraph } from './sqlite-store-graph-traverse.js';
import {
  deleteSage as deleteSageFromHost,
  hygiene as hygieneFromHost,
  rememberSage as rememberSageFromHost,
  verifyForPaths as verifyForPathsFromHost,
  verify as verifyFromHost,
} from './sqlite-store-graph-write.js';
import { importLegacySqliteMemory, searchLegacySqliteMemory } from './sqlite-store-legacy-api.js';
import {
  readAllSqliteMemory,
  readSqliteMemory,
  rememberSqliteMemoryBridge,
} from './sqlite-store-legacy-bridge.js';
import { listLegacySqliteMemory } from './sqlite-store-legacy-list.js';
import { listSqliteMemories } from './sqlite-store-list-memories.js';
import { listSqliteSagePage } from './sqlite-store-list-page.js';
import {
  backfillAdminSage,
  closeSqliteStore,
  drainSqliteStoreMutations,
  findAdminMemoriesForFile,
  listSageHqSync,
  recoverAdminSage,
  sageHqSyncVersion,
} from './sqlite-store-operations.js';
import {
  explainSqliteSageRecall,
  retrieveSageAudienceWithAudit,
  searchSqliteSageWithRecall,
} from './sqlite-store-recall.js';
import { retrieveSqliteSageForPath } from './sqlite-store-retrieve-path.js';
import { executeUnifiedSearch } from './sqlite-store-search.js';
import { consolidateSqliteSession } from './sqlite-store-session-consolidation.js';
import { getSqliteSageStats } from './sqlite-store-stats.js';
import type {
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  LegacyImportResult,
  ListSagePageOptions,
  ListSagePageResult,
  MemoryAudienceContext,
  MemoryGraphEdge,
  MemoryGraphRelation,
  MemoryVerificationResult,
  RememberSageInput,
  Sage,
  SageAuditRecord,
  SageBackfillOptions,
  SageBackfillReport,
  SageForPathOptions,
  SageHygieneOptions,
  SageHygieneReport,
  SageSearchOptions,
  SageStats,
  SageStatus,
  SessionConsolidationInput,
  SessionConsolidationResult,
  UpdateSageInput,
} from './types.js';

export { sqliteStoreCoverage } from './sqlite-store-coverage.js';
export { isSqliteAvailable } from './sqlite-store-loader.js';

// ─── Store ──────────────────────────────────────────────────────────────

/**
 * @deprecated Use `createSqliteMemoryPort` and depend on Core's `MemoryPort`.
 * This class remains public only for the compatibility window.
 */
export class SqliteSageStore extends SqliteSageStoreCore implements MemoryStore {
  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Store (or merge) a SAGE record.
   *
   * **Field precedence for the dual-bridge API:**
   * - `scope` (SageScope) and `kind` (SageKind) are the primary
   *   fields. `legacyScope` (MemoryScope) and `type` (MemoryType) are read-only
   *   bridges for backward compatibility with the legacy `MemoryStore` API.
   * - When `scope` is omitted, it is derived from `legacyScope` via
   *   `legacyToSageScope()`.  Defaults to `'project'` when neither is given.
   * - When `kind` is omitted, it is derived from `type` via
   *   `legacyTypeToKind()`.  Defaults to `'fact'` when neither is given.
   * - **`kind` always wins over `type`**, and **`scope` always wins over
   *   `legacyScope`**.  Callers supplying both should ensure they are
   *   semantically consistent.
   */
  async rememberSage(input: RememberSageInput): Promise<Sage> {
    return rememberSageFromHost(this.sqliteStoreGraphWriteHost(), input);
  }

  // ─── Legacy MemoryStore compatibility ──────────────────────────────

  async readAll(): Promise<string> {
    return readAllSqliteMemory((scope) => this.read(scope));
  }

  async read(scope: MemoryScope): Promise<string> {
    return readSqliteMemory((targetScope) => this.list(targetScope), scope);
  }

  async remember(
    text: string,
    scope: MemoryScope = 'project-memory',
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ): Promise<void> {
    return rememberSqliteMemoryBridge((input) => this.rememberSage(input), text, scope, metadata);
  }

  async forget(query: string, scope: MemoryScope = 'project-memory'): Promise<number> {
    return forgetFromHost.call(this.sqliteMemoryMutationsHost(), query, scope);
  }

  async consolidate(scope: MemoryScope): Promise<void> {
    return consolidateFromHost.call(this.sqliteMemoryMutationsHost(), scope);
  }

  async clear(scope?: MemoryScope): Promise<void> {
    return clearFromHost.call(this.sqliteMemoryMutationsHost(), scope);
  }

  async list(scope: MemoryScope = 'project-memory', limit?: number): Promise<MemoryEntry[]> {
    await this.initialize();
    return listLegacySqliteMemory({ stmt: (sql) => this.stmt(sql) }, scope, limit);
  }

  async listHqSync(after = ''): Promise<HqSageRecord[]> {
    await this.initialize();
    return listSageHqSync(this.db, after);
  }

  async getHqSyncVersion(): Promise<string> {
    await this.initialize();
    return sageHqSyncVersion(this.db);
  }

  async applyHqSync(records: HqSageRecord[]): Promise<void> {
    return applyHqSyncFromHost.call(this.sqliteMemoryMutationsHost(), records);
  }

  async updateSage(id: string, input: UpdateSageInput): Promise<Sage> {
    return updateSageFromHost.call(this.sqliteMemoryMutationsHost(), id, input);
  }

  async hardDeleteSage(id: string, reason?: string): Promise<{ deleted: true; id: string }> {
    return hardDeleteSageFromHost.call(this.sqliteMemoryMutationsHost(), id, reason);
  }

  async recordInjection(memoryIds: string[], trigger: string, sessionId?: string): Promise<void> {
    return recordInjectionFromHost.call(
      this.sqliteMemoryMutationsHost(),
      memoryIds,
      trigger,
      sessionId,
    );
  }

  async recordUse(memoryIds: string[], source: string, sessionId?: string): Promise<void> {
    return recordUseFromHost.call(this.sqliteMemoryMutationsHost(), memoryIds, source, sessionId);
  }

  async searchSage(query: string, opts?: SageSearchOptions): Promise<Sage[]> {
    await this.initialize();
    return searchSqliteSageWithRecall((sql) => this.stmt(sql), query, opts);
  }
  /** See {@link explainSqliteSageRecall}. */
  async searchSageWithBreakdown(
    query: string,
    opts?: SageSearchOptions,
  ): Promise<VectorAugmentHit[]> {
    await this.initialize();
    return explainSqliteSageRecall((sql) => this.stmt(sql), query, opts);
  }

  async retrieveForPath(paths: string[], opts?: SageForPathOptions): Promise<Sage[]> {
    await this.initialize();
    return retrieveSqliteSageForPath(
      { projectRoot: this.projectRoot, stmt: (sql) => this.stmt(sql) },
      paths,
      opts,
    );
  }

  /** SQLite equivalent of JSONL graph/metadata expansion. */
  async findRelatedSage(memoryIds: string[], opts: SqliteFindRelatedOptions = {}): Promise<Sage[]> {
    await this.initialize();
    return findRelatedSqliteSage(
      {
        stmt: (sql) => this.stmt(sql),
        traverseGraph: (starts, graphOpts) => this.traverseGraph(starts, graphOpts),
      },
      memoryIds,
      opts,
    );
  }
  /** See {@link retrieveSageAudienceWithAudit}. */
  async retrieveForAudience(
    context: MemoryAudienceContext,
    limit?: number,
    onTruncated?: (info: { sqlRowsExamined: number; returned: number }) => void,
    sessionId?: string | undefined,
    includeAllSessions?: boolean | undefined,
  ): Promise<Sage[]> {
    await this.initialize();
    return retrieveSageAudienceWithAudit(
      (sql) => this.stmt(sql),
      (event, data) => this.audit(event, data),
      context,
      limit,
      onTruncated,
      sessionId,
      includeAllSessions,
    );
  }

  async listMemories(opts?: {
    status?: SageStatus | 'all';
    kind?: string;
    limit?: number;
    offset?: number;
  }): Promise<Sage[]> {
    await this.initialize();
    return listSqliteMemories({ stmt: (sql) => this.stmt(sql) }, opts);
  }

  /**
   * Paginated, status-filtered listing (SQLite backend). Mirrors
   * `SageStore.listSagePage`: defaults to EXCLUDING `deleted`, returns a
   * bounded page plus an opaque `updatedAt`/`id` cursor, and reports total +
   * whole-store `statusCounts` for UI tab badges.
   *
   * Ordering: `updated_at DESC, id DESC`. Cursor pagination uses the tuple
   * comparison `(updated_at, id) < (cursorUpdatedAt, cursorId)` which the
   * composite DESC index can serve without scanning skipped pages.
   */
  async listSagePage(options: ListSagePageOptions = {}): Promise<ListSagePageResult> {
    await this.initialize();
    return listSqliteSagePage({ stmt: (sql) => this.stmt(sql) }, options);
  }

  async getStats(): Promise<SageStats> {
    await this.initialize();
    return getSqliteSageStats({ stmt: (sql) => this.stmt(sql) });
  }

  // ─── Graph ──────────────────────────────────────────────────────────

  async addGraphEdge(
    from: string,
    to: string,
    relation: MemoryGraphRelation,
    weight = 1,
  ): Promise<void> {
    return delegateAddGraphEdge(this.sqliteStoreGraphHost(), from, to, relation, weight);
  }

  async traverseGraph(
    starts: string[],
    opts?: { maxDepth?: number; limit?: number },
  ): Promise<MemoryGraphEdge[]> {
    await this.initialize();
    return traverseSqliteGraph({ stmt: (sql) => this.stmt(sql) }, starts, opts);
  }

  /**
   * Resolve a free-form graph query (a node id, a bare memory id, a project
   * path, or arbitrary text) into start nodes, then traverse. Restores the
   * host-facing `graphFor` surface the legacy JSONL store exposed and that the
   * `/memory graph` command and the webui graph handler still call.
   */
  async graphFor(query: string, maxDepth = 2, limit = 100): Promise<MemoryGraphEdge[]> {
    return delegateGraphFor(this.sqliteStoreGraphHost(), query, maxDepth, limit);
  }

  /**
   * Re-check the filesystem anchors of one memory (or every non-deleted memory)
   * and reconcile status: a memory whose anchors have vanished flips
   * active→stale; a stale memory whose anchors reappear flips back to active.
   * Restores the standalone `verify` surface the JSONL store exposed and that
   * `/memory verify` still calls. The SQLite hygiene pass runs the same probe
   * inline, but the host-facing surface needs it as a discrete operation.
   */
  async verify(memoryId?: string, signal?: AbortSignal): Promise<MemoryVerificationResult[]> {
    return verifyFromHost(this.sqliteStoreGraphWriteHost(), memoryId, signal);
  }

  /**
   * Re-check only the memories anchored to `paths` (absolute or
   * project-relative). The tool-call middleware calls this after a mutating
   * tool so memories about the touched files are reconciled immediately.
   */
  async verifyForPaths(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemoryVerificationResult[]> {
    return verifyForPathsFromHost(this.sqliteStoreGraphWriteHost(), paths, signal);
  }

  /**
   * Read the most recent audit events, newest first. Backs `/memory audit`.
   * Bounded by {@link AUDIT_LOG_MAX_ROWS} retention, so this is a rolling
   * window of recent activity, not a full history.
   */
  async readAudit(limit = 50): Promise<SageAuditRecord[]> {
    await this.initialize();
    return readSqliteAudit({ stmt: (sql) => this.stmt(sql) }, limit);
  }

  // ─── Hygiene ────────────────────────────────────────────────────────

  async hygiene(opts?: SageHygieneOptions): Promise<SageHygieneReport> {
    return hygieneFromHost(this.sqliteStoreGraphWriteHost(), opts);
  }

  /** Health report plus the named, idempotent repairs (see sqlite-store-doctor.ts). */
  async doctor(options?: SageDoctorOptions): Promise<SageDoctorReport> {
    await this.initialize();
    return runSqliteSageDoctor(
      {
        stmt: (sql) => this.stmt(sql),
        dbPath: path.join(this.paths.rootDir, 'sage.db'),
        nowIso: () => this.nowIso(),
        runMutation: (work) => this.runMutation(work),
        upsertMemory: (memory) => this.upsertMemory(memory),
        audit: (event, data) => this.audit(event, data),
        hygiene: () => this.hygiene(options?.hygieneOptions),
      },
      options,
    );
  }

  // ─── Legacy compat ──────────────────────────────────────────────────

  async importLegacy(raw: string): Promise<LegacyImportResult> {
    return this.runCompositeOperation(() =>
      importLegacySqliteMemory({ rememberSage: (input) => this.rememberSage(input) }, raw),
    );
  }

  async consolidateSession(input: SessionConsolidationInput): Promise<SessionConsolidationResult> {
    await this.initialize();
    return this.runCompositeOperation(() =>
      consolidateSqliteSession(
        {
          stmt: (sql) => this.stmt(sql),
          listCandidates: () => this.listCandidates(),
          createCandidate: (candidate) => this.createCandidate(candidate),
          acceptCandidate: (candidateId) => this.acceptCandidate(candidateId),
        },
        input,
      ),
    );
  }

  // ─── Alias methods matching SageStore's public API ──────────

  async unifiedSearchService(query: SearchQuery, options?: SearchOptions): Promise<SearchResult> {
    await this.initialize();
    return executeUnifiedSearch(this.adminHost(), query, options);
  }

  async stats(): Promise<SageStats> {
    return this.getStats();
  }

  async listSage(statuses?: SageStatus[]): Promise<Sage[]> {
    await this.initialize();
    return listCompatSage({ stmt: (sql) => this.stmt(sql) }, statuses);
  }

  async getSage(id: string): Promise<Sage | null> {
    await this.initialize();
    return getCompatSage(
      {
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        rowToMemory: (row) => this.rowToMemory(row),
      },
      id,
    );
  }

  async recoverSage(id: string, reason?: string): Promise<Sage> {
    await this.initialize();
    return this.runCompositeOperation(() => recoverAdminSage(this.adminHost(), id, reason));
  }
  async backfillRecoverable(options?: SageBackfillOptions): Promise<SageBackfillReport> {
    await this.initialize();
    return this.runCompositeOperation(() => backfillAdminSage(this.adminHost(), options));
  }
  async findMemoriesForFile(
    filePath: string,
    options?: FindMemoriesForFileOptions,
  ): Promise<FindMemoriesForFileResponse> {
    await this.initialize();
    return findAdminMemoriesForFile(this.adminHost(), filePath, options);
  }
  async search(
    query: string,
    scope: MemoryScope = 'project-memory',
    limit?: number,
  ): Promise<MemoryEntry[]> {
    return searchLegacySqliteMemory(
      { searchSage: (targetQuery, opts) => this.searchSage(targetQuery, opts) },
      query,
      scope,
      limit,
    );
  }

  async deleteSage(
    id: string,
    reason = 'Manually deleted via API.',
    options: { force?: boolean; neverInject?: boolean } = {},
  ): Promise<void> {
    return deleteSageFromHost(this.sqliteStoreGraphWriteHost(), id, reason, options);
  }

  async drainMutations(): Promise<void> {
    await drainSqliteStoreMutations(this.mutationQueue);
  }

  close(): void {
    closeSqliteStore(this.stmtCache, this.db);
  }
}
