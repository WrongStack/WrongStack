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
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryEntry, MemoryScope, MemoryStore } from '@wrongstack/core/types';
import { ulid } from '@wrongstack/core/utils';
import { resolveSagePaths } from './paths.js';
import { consolidateSqliteSession } from './sqlite-store-session-consolidation.js';
import {
  readSqliteAudit,
  pruneSqliteAuditLog,
  writeSqliteAudit,
} from './sqlite-store-audit.js';
import { retrieveSqliteSageForAudience } from './sqlite-store-audience.js';
import {
  addSqliteCandidate,
  acceptSqliteCandidate,
  createSqliteCandidate,
  listSqliteCandidates,
  rejectSqliteCandidate,
  resolveSqliteCandidate,
} from './sqlite-store-candidates.js';
import { legacyScopeLabel } from './sqlite-store-legacy.js';
import { probeSqliteAvailable } from './sqlite-store-loader.js';
import { graphSqliteSageFor } from './sqlite-store-graph-for.js';
import { traverseSqliteGraph } from './sqlite-store-graph-traverse.js';
import { findRelatedSqliteSage, type SqliteFindRelatedOptions } from './sqlite-store-find-related.js';
import { runSqliteSageHygiene } from './sqlite-store-hygiene.js';
import { syncSqliteAnchorEdges } from './sqlite-store-anchor-sync.js';
import {
  sqliteRowToMemory,
} from './sqlite-store-codec.js';
import { formatLegacyEntry } from './sqlite-store-pagination.js';
import { retrieveSqliteSageForPath } from './sqlite-store-retrieve-path.js';
import { initializeSqliteSageStore } from './sqlite-store-initialize.js';
import { searchSqliteSage } from './sqlite-store-search-sage.js';
import { executeUnifiedSearch } from './sqlite-store-search.js';
import { getSqliteSageStats } from './sqlite-store-stats.js';
import { updateSqliteSage } from './sqlite-store-update.js';
import { verifySqliteSage } from './sqlite-store-verify.js';
import { getCompatSage, listCompatSage } from './sqlite-store-compat.js';
import { recordSqliteInjection, recordSqliteUse } from './sqlite-store-counters.js';
import { deleteSqliteSage } from './sqlite-store-delete.js';
import { clearLegacySqliteMemory } from './sqlite-store-legacy-clear.js';
import { consolidateLegacySqliteMemory } from './sqlite-store-legacy-consolidate.js';
import { forgetLegacySqliteMemory } from './sqlite-store-legacy-forget.js';
import { listLegacySqliteMemory } from './sqlite-store-legacy-list.js';
import { importLegacySqliteMemory, searchLegacySqliteMemory } from './sqlite-store-legacy-api.js';
import { listSqliteMemories } from './sqlite-store-list-memories.js';
import { listSqliteSagePage } from './sqlite-store-list-page.js';
import { SqliteMutationQueue } from './sqlite-store-mutation-queue.js';
import { rememberSqliteSage } from './sqlite-store-remember.js';
import { migrateSqliteLegacyJsonl } from './sqlite-store-jsonl-migration.js';
import { SqliteStatementCache } from './sqlite-store-statement-cache.js';
import {
  backfillAdminSage,
  closeSqliteStore,
  drainSqliteStoreMutations,
  findAdminMemoriesForFile,
  recoverAdminSage,
  type SqliteAdminHost,
} from './sqlite-store-operations.js';
import {
  normalizeTextKey,
} from './store-helpers.js';
import type { SearchOptions, SearchQuery, SearchResult } from './service-contract.js';
import type {
  CandidateDecision,
  CreateCandidateInput,
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  LegacyImportResult,
  ListSagePageOptions,
  ListSagePageResult,
  MemoryAudienceContext,
  MemoryCandidate,
  MemoryCandidateResolution,
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
  SageStoreOptions,
  SessionConsolidationInput,
  SessionConsolidationResult,
  UpdateSageInput,
} from './types.js';
import {
  DEFAULT_PERSISTENCE,
  legacyToSageScope,
  sageToLegacyScope,
} from './types.js';

export { sqliteStoreCoverage } from './sqlite-store-coverage.js';

/**
 * Non-throwing probe — returns true if `node:sqlite` is available
 * in the current runtime. Safe to call from outside the store.
 */
export function isSqliteAvailable(): boolean {
  return probeSqliteAvailable();
}

// ─── Store ──────────────────────────────────────────────────────────────

/**
 * @deprecated Use `createSqliteMemoryPort` and depend on Core's `MemoryPort`.
 * This class remains public only for the compatibility window.
 */
export class SqliteSageStore implements MemoryStore {
  readonly paths;
  private readonly projectRoot: string;
  private readonly now: () => Date;
  private readonly events: SageStoreOptions['events'];
  private readonly operationContext: SageStoreOptions['operationContext'];
  private traceId?: string | undefined;
  private db!: DatabaseSync;
  private initialized = false;
  private initializing: Promise<void> | undefined;
  private readonly mutationQueue = new SqliteMutationQueue();
  /**
   * Independent chain for lightweight counter updates (recordInjection,
   * recordUse). Runs independently of the main mutation chain so that
   * injection/use bookkeeping never blocks behind a heavy rememberSage
   * or consolidation — the actual benefit is skipping the withFileLock
   * I/O round-trip, not true parallelism. On a single synchronous
   * DatabaseSync connection the BEGIN/work/COMMIT blocks serialize
   * at the event-loop level; WAL+busy_timeout handles engine-level
   * contention.
   */
  private auditWritesSincePrune = 0;
  private readonly stmtCache = new SqliteStatementCache(128);

  constructor(opts: SageStoreOptions) {
    this.projectRoot = path.resolve(opts.projectRoot);
    this.paths = resolveSagePaths(this.projectRoot, opts.directory);
    this.traceId = opts.traceId;
    this.now = opts.now ?? (() => new Date());
    this.events = opts.events;
    this.operationContext = opts.operationContext;
  }

  withTraceId(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  /** Prepare-once helper: compile `sql` on first use, reuse thereafter. */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.stmtCache.get(this.db, sql);
  }

  private rowToMemory(row: { data: string }): Sage {
    return sqliteRowToMemory(row);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce();
    try {
      await this.initializing;
    } catch (error) {
      // A failed migration/open must not leak a handle. Without this cleanup,
      // a retry opened a second connection while the failed WAL connection
      // remained alive (notably leaving `sage.db-shm` locked on Windows).
      this.stmtCache.clear();
      if (this.db) {
        try {
          this.db.close();
        } catch {
          // Preserve the original initialization error.
        }
      }
      throw error;
    } finally {
      this.initializing = undefined;
    }
  }

  private async initializeOnce(): Promise<void> {
    await initializeSqliteSageStore({
      paths: this.paths,
      now: () => this.now(),
      stmt: (sql) => this.stmt(sql),
      setDb: (db) => {
        this.db = db;
      },
      syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
      migrateFromJsonl: () => this.migrateFromJsonl(),
    });
    this.initialized = true;
  }

  // ─── JSONL migration ────────────────────────────────────────────────

  private async migrateFromJsonl(): Promise<void> {
    await migrateSqliteLegacyJsonl({
      paths: this.paths,
      db: this.db,
      stmt: (sql) => this.stmt(sql),
      nowIso: () => this.nowIso(),
      traceId: this.currentTraceId(),
      upsertMemory: (memory) => this.upsertMemory(memory),
      syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
    });
  }

  // ─── Core helpers ───────────────────────────────────────────────────

  private nowIso(): string {
    return this.now().toISOString();
  }

  private currentTraceId(): string | undefined {
    return this.operationContext?.()?.traceId ?? this.traceId;
  }

  /**
   * Cascade-delete all graph edges referencing a given node id.
   * Called from forget(), clear(), and deleteSage() so the edge
   * cleanup logic is maintained in one place.
   */
  private cascadeDeleteEdges(nodeId: string): void {
    // Preserve structural related_to edges (symbol→file, file→dir, dir→dir ancestors)
    // that are shared across memories — they must not be destroyed when one memory
    // is deleted because other memories depend on them for graph traversal.
    this.stmt(
      "DELETE FROM edges WHERE (from_node = ? OR to_node = ?) AND relation != 'related_to'",
    ).run(nodeId, nodeId);
  }

  /**
   * Serialize mutations with the file lock and a single SQLite write transaction.
   * Multi-statement paths (remember merge, cascade delete, counter batch) commit
   * once instead of once per prepared statement.
   */
  private runMutation<T>(work: () => T, signal?: AbortSignal): Promise<T> {
    return this.mutationQueue.runLocked({
      db: this.db,
      lockPath: path.join(this.paths.locksDir, 'store-mutation'),
      work,
      signal,
    });
  }

  /**
   * Lightweight independent chain for counter-only updates (recordInjection,
   * recordUse). Skips the file lock (saving an I/O round-trip) and runs
   * independently from the main mutation chain so that counter bookkeeping
   * never delays or is delayed by a heavy remember/consolidate.
   *
   * The two chains are independent Promise chains, not truly concurrent:
   * on a single synchronous DatabaseSync connection the BEGIN/work/COMMIT
   * blocks serialize at the event-loop level, so cross-chain ordering is
   * well-defined. WAL + busy_timeout handles engine-level contention.
   * Counter updates are idempotent and loss-tolerant (they increment
   * advisory statistics), so a transient SQLITE_BUSY is safe.
   */
  private runCounterMutation<T>(work: () => T extends Promise<unknown> ? never : T): Promise<T> {
    return this.mutationQueue.runCounter(this.db, work);
  }

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
    return rememberSqliteSage({
      input,
      projectRoot: this.projectRoot,
      initialize: () => this.initialize(),
      nowIso: () => this.nowIso(),
      stmt: (sql) => this.stmt(sql),
      runMutation: (work) => this.runMutation(work),
      upsertMemory: (memory) => this.upsertMemory(memory),
      syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
      emit: (event, payload) =>
        this.events?.emit(event as never, this.eventPayload(payload) as never),
    });
  }

  // ─── Legacy MemoryStore compatibility ──────────────────────────────

  async readAll(): Promise<string> {
    const sections: string[] = [];
    for (const scope of ['project-agents', 'project-memory', 'user-memory'] as const) {
      const body = await this.read(scope);
      if (body) sections.push(`## ${legacyScopeLabel(scope)}\n\n${body}`);
    }
    return sections.join('\n\n');
  }

  async read(scope: MemoryScope): Promise<string> {
    return (await this.list(scope)).map(formatLegacyEntry).join('\n');
  }

  async remember(
    text: string,
    scope: MemoryScope = 'project-memory',
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ): Promise<void> {
    await this.rememberSage({
      text,
      legacyScope: scope,
      scope: legacyToSageScope(scope),
      type: metadata?.type,
      tags: metadata?.tags,
      priority: metadata?.priority,
      confidence: metadata?.confidence,
      sources: metadata?.source
        ? [{ type: 'legacy_memory', excerptHash: metadata.source }]
        : undefined,
    });
  }

  async forget(query: string, scope: MemoryScope = 'project-memory'): Promise<number> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return 0;
    await this.initialize();
    return this.runMutation(() => {
      return forgetLegacySqliteMemory(
        {
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          upsertMemory: (memory) => this.upsertMemory(memory),
          cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
          audit: (event, data) => this.audit(event, data),
          emitForgotten: (targetScope, targetQuery, removed) =>
            this.events?.emit('memory.forgotten', {
              scope: targetScope,
              query: targetQuery,
              removed,
            }),
        },
        query,
        scope,
      );
    });
  }

  async consolidate(scope: MemoryScope): Promise<void> {
    await this.initialize();
    await this.runMutation(() => {
      consolidateLegacySqliteMemory(
        {
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          upsertMemory: (memory) => this.upsertMemory(memory),
          syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
          audit: (event, data) => this.audit(event, data),
          emitConsolidated: (targetScope, removed) =>
            this.events?.emit('memory.consolidated', { scope: targetScope, removed }),
        },
        scope,
      );
    });
  }

  async clear(scope?: MemoryScope): Promise<void> {
    await this.initialize();
    await this.runMutation(() => {
      clearLegacySqliteMemory(
        {
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          upsertMemory: (memory) => this.upsertMemory(memory),
          cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
          audit: (event, data) => this.audit(event, data),
          emitCleared: (targetScope) => this.events?.emit('memory.cleared', { scope: targetScope }),
        },
        scope,
      );
    });
  }

  async list(scope: MemoryScope = 'project-memory', limit?: number): Promise<MemoryEntry[]> {
    await this.initialize();
    return listLegacySqliteMemory({ stmt: (sql) => this.stmt(sql) }, scope, limit);
  }

  private upsertMemory(m: Sage): void {
    // Prefer INSERT … ON CONFLICT DO UPDATE over DELETE+INSERT:
    // - Keeps the same INTEGER rowid so the external-content FTS shadow table
    //   stays aligned without delete/reinsert churn.
    // - AFTER UPDATE triggers correctly rebuild the FTS row (unlike INSERT OR
    //   REPLACE, which skips AFTER DELETE when recursive triggers are off).
    // - One statement instead of two on the hot remember/update path.
    this.stmt(
      `INSERT INTO memories
        (id, data, status, kind, scope, legacy_scope, importance, confidence, freshness, updated_at, created_at, audience, tags, owner_session_id, canonical_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        status = excluded.status,
        kind = excluded.kind,
        scope = excluded.scope,
        legacy_scope = excluded.legacy_scope,
        importance = excluded.importance,
        confidence = excluded.confidence,
        freshness = excluded.freshness,
        updated_at = excluded.updated_at,
        created_at = excluded.created_at,
        audience = excluded.audience,
        tags = excluded.tags,
        owner_session_id = excluded.owner_session_id,
        canonical_text = excluded.canonical_text`,
    ).run(
      m.id,
      JSON.stringify(m),
      m.status,
      m.kind,
      m.scope,
      m.legacyScope ?? sageToLegacyScope(m.scope),
      m.importance,
      m.confidence,
      m.freshness,
      m.updatedAt,
      m.createdAt,
      m.audience ? JSON.stringify(m.audience) : null,
      JSON.stringify(m.tags),
      m.ownerSessionId ?? null,
      normalizeTextKey(m.text),
    );
  }

  private upsertCandidate(candidate: MemoryCandidate, canonicalText?: string): void {
    this.stmt(
      `INSERT OR REPLACE INTO candidates
        (id, data, status, created_at, updated_at, canonical_text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      candidate.id,
      JSON.stringify(candidate),
      candidate.status,
      candidate.createdAt,
      candidate.updatedAt,
      canonicalText ?? normalizeTextKey(candidate.text),
    );
  }

  /**
   * Maintain typed anchor graph edges for the SQLite-backed store.
   *
   * The canonical JSONL store only rebuilds anchor edges inside its
   * `addAutomaticEdges` consolidation / relationship-proposal pass and
   * skips the rebuild on plain text or tag-only updates. The SQLite port
   * additionally keeps edge weights and soft-delete state in lock-step
   * with memory rows; this is new SQLite-side behavior, not a 1:1 parity
   * of the canonical pass.
   *
   * Responsibility split:
   * - `syncAnchorEdges` (this method) only touches the `about_*` relation
   *   family (file / directory / symbol / package / command / agent).
   *   Callers invoke it after inserts and after updates that change anchors,
   *   confidence, or eligibility for the active/stale anchor graph.
   * - `cascadeDeleteEdges` (used by forget / clear / deleteSage)
   *   drops outgoing and incoming edges for the memory node (preserving
   *   `related_to` structural edges shared across memories), which is
   *   required when a row is fully removed but is overkill for a
   *   plain upsert. The overlap on `about_*` is intentional and safe:
   *   the edge rewrite runs inside `runMutation` so it is serialized,
   *   and `ON CONFLICT … DO UPDATE` makes the inserts idempotent.
   *
   *   NOTE: `weight = excluded.weight` means the last memory to sync wins
   *   when multiple memories share the same anchor target. This is acceptable
   *   because weight reflects the most-recently-refreshed confidence score,
   *   but it's not a CRDT merge — concurrent writes from separate processes
   *   race on edge weight.
   */
  private syncAnchorEdges(memory: Sage): void {
    syncSqliteAnchorEdges({ stmt: (sql) => this.stmt(sql), nowIso: () => this.nowIso() }, memory);
  }

  async updateSage(id: string, input: UpdateSageInput): Promise<Sage> {
    await this.initialize();
    return this.runMutation(() => {
      return updateSqliteSage(
        {
          projectRoot: this.projectRoot,
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          upsertMemory: (memory) => this.upsertMemory(memory),
          syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
          cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
          audit: (event, data) => this.audit(event, data),
          emitUpdated: (memory) =>
            this.events?.emit(
              'memory.updated',
              this.eventPayload({
                memoryId: memory.id,
                status: memory.status,
                kind: memory.kind,
                persistence: memory.persistence ?? DEFAULT_PERSISTENCE,
                confidence: memory.confidence,
                freshness: memory.freshness,
              }),
            ),
          emitDeleted: (memory, reason, removedEdges) =>
            this.events?.emit(
              'memory.deleted',
              this.eventPayload({
                memoryId: memory.id,
                reason,
                persistence: memory.persistence ?? DEFAULT_PERSISTENCE,
                removedEdges,
                contextPolicy:
                  memory.contextPolicy === 'never' ? ('never' as const) : ('eligible' as const),
              }),
            ),
        },
        id,
        input,
      );
    });
  }

  async hardDeleteSage(id: string, reason?: string): Promise<{ deleted: true; id: string }> {
    // Soft-delete shim. The SQLite backend used to ship its own
    // un-audited-by-force SQL path here; it now routes through
    // `deleteSage` (which sets status: 'deleted', preserving
    // the tombstone for audit/recovery) so the same force/permanent
    // guard, edge cascade, audit entry, and event payload apply to
    // every caller.
    // Pass `force: true` because this method historically implied
    // "operator-driven, no questions asked" (it predates the guard).
    await this.deleteSage(id, reason ?? 'Manually deleted via SQLite API.', {
      force: true,
    });
    return { deleted: true, id };
  }

  async recordInjection(memoryIds: string[], trigger: string, sessionId?: string): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.initialize();
    await this.runCounterMutation(() => {
      recordSqliteInjection(
        {
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          audit: (event, data) => this.audit(event, data),
        },
        memoryIds,
        trigger,
        sessionId,
      );
    });
  }

  async recordUse(memoryIds: string[], source: string, sessionId?: string): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.initialize();
    await this.runCounterMutation(() => {
      recordSqliteUse(
        {
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          audit: (event, data) => this.audit(event, data),
        },
        memoryIds,
        source,
        sessionId,
      );
    });
  }

  async searchSage(query: string, opts?: SageSearchOptions): Promise<Sage[]> {
    await this.initialize();
    return searchSqliteSage({ stmt: (sql) => this.stmt(sql) }, query, opts);
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
  async findRelatedSage(
    memoryIds: string[],
    opts: SqliteFindRelatedOptions = {},
  ): Promise<Sage[]> {
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

  /**
   * Retrieve memories scoped to a specific agent audience (role, taskType, mode).
   * Queries all audience-scoped memories (status active/stale) then filters in JS
   * for correctness (the SQLite LIKE approach produced false negatives when a
   * memory targeted only one audience dimension).
   *
   * **Note:** The internal SQL prefilter pulls `limit * 5` rows as a safety
   * net to bound the in-memory audience filter pass. The over-fetch factor
   * (5) matches `AUDIENCE_OVERFETCH_FACTOR` in `sqlite-store-audience.ts`
   * and is the trigger for the `memory.audience_truncated` audit event
   * the onTruncated callback emits when more matching rows likely exist
   * beyond the prefilter window. Bump the factor if narrow role/task
   * filters warrant a larger window.
   */
  async retrieveForAudience(
    context: MemoryAudienceContext,
    limit?: number,
    /**
     * Optional truncation callback. Fires when the SQL prefilter is fully
     * exhausted and more matching rows likely exist beyond it. When
     * omitted, the store still emits the internal
     * `memory.audience_truncated` audit event so downstream observers
     * can pick it up via the audit log without having to thread a
     * callback through every call site. Both the callback and the
     * audit event fire on the same condition, so callers may use
     * whichever channel fits their observability story.
     */
    onTruncated?: (info: { sqlRowsExamined: number; returned: number }) => void,
    /**
     * Session ownership filter. When set, only session-scoped memories owned
     * by this session (plus all non-session memories) are returned. When
     * unset (and `includeAllSessions` is not true), owned session-scoped
     * memories are hidden — only unowned session memories remain visible,
     * so pass `sessionId` to see your own session's records.
     */
    sessionId?: string | undefined,
    /** Admin opt-out: include all sessions' session-scoped memories. */
    includeAllSessions?: boolean | undefined,
  ): Promise<Sage[]> {
    await this.initialize();
    return retrieveSqliteSageForAudience(
      {
        stmt: (sql) => this.stmt(sql),
        onTruncated: (info) => {
          this.audit('memory.audience_truncated', { context, ...info });
          onTruncated?.(info);
        },
      },
      context,
      limit === undefined
        ? { sessionId, includeAllSessions }
        : { limit, sessionId, includeAllSessions },
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
    await this.initialize();
    const edgeId = `edge_${ulid()}`;
    this.stmt(
      `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(from_node, to_node, relation) DO UPDATE SET weight = weight + excluded.weight`,
    ).run(from, to, relation, weight, this.nowIso());
    this.events?.emit(
      'memory.graph_edge_added',
      this.eventPayload({ edgeId, from, to, relation, weight }),
    );
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
    await this.initialize();
    return graphSqliteSageFor(
      {
        projectRoot: this.projectRoot,
        stmt: (sql) => this.stmt(sql),
        searchSage: (targetQuery, opts) => this.searchSage(targetQuery, opts),
        traverseGraph: (starts, opts) => this.traverseGraph(starts, opts),
      },
      query,
      maxDepth,
      limit,
    );
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
    await this.initialize();
    return verifySqliteSage(
      {
        projectRoot: this.projectRoot,
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        runMutation: (work) => this.runMutation(work),
        upsertMemory: (memory) => this.upsertMemory(memory),
        syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
      },
      memoryId,
      signal,
    );
  }

  // ─── Audit ──────────────────────────────────────────────────────────

  private audit(event: string, data?: Record<string, unknown>): void {
    writeSqliteAudit(
      {
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        getTraceId: () => this.currentTraceId(),
        getWritesSincePrune: () => this.auditWritesSincePrune,
        setWritesSincePrune: (value) => {
          this.auditWritesSincePrune = value;
        },
      },
      event,
      data,
    );
  }

  /** Delete all but the most recent {@link AUDIT_LOG_MAX_ROWS} audit rows. */
  private pruneAuditLog(): void {
    pruneSqliteAuditLog({ stmt: (sql) => this.stmt(sql) });
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

  private eventPayload<T extends object>(
    payload: T,
  ): T & { traceId?: string | undefined; sessionId?: string | undefined } {
    const context = this.operationContext?.();
    const traceId = context?.traceId ?? this.traceId;
    return {
      ...payload,
      ...(traceId ? { traceId } : {}),
      ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    };
  }

  private candidateOps() {
    return {
      projectRoot: this.projectRoot,
      candidateLockPath: (candidateId: string) =>
        path.join(this.paths.locksDir, `candidate-accept-${candidateId}`),
      stmt: (sql: string) => this.stmt(sql),
      nowIso: () => this.nowIso(),
      runMutation: <T>(work: () => T) => this.runMutation(work),
      rememberSage: (input: RememberSageInput) => this.rememberSage(input),
      updateSage: (id: string, input: UpdateSageInput) => this.updateSage(id, input),
      upsertCandidate: (candidate: MemoryCandidate, canonicalText?: string | undefined) =>
        this.upsertCandidate(candidate, canonicalText),
      audit: (event: string, data?: Record<string, unknown>) => this.audit(event, data),
    };
  }

  // ─── Hygiene ────────────────────────────────────────────────────────

  async hygiene(opts?: SageHygieneOptions): Promise<SageHygieneReport> {
    await this.initialize();
    return runSqliteSageHygiene(
      {
        projectRoot: this.projectRoot,
        stmt: (sql) => this.stmt(sql),
        now: () => this.now(),
        nowIso: () => this.nowIso(),
        listMemories: (listOpts) => this.listMemories(listOpts),
        listCandidates: () => this.listCandidates(),
        addCandidate: (candidate) => this.addCandidate(candidate),
        runMutation: (work) => this.runMutation(work),
        upsertMemory: (memory) => this.upsertMemory(memory),
        syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
        cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
        audit: (event, data) => this.audit(event, data),
        pruneAuditLog: () => this.pruneAuditLog(),
      },
      opts,
    );
  }

  // ─── Candidates ─────────────────────────────────────────────────────

  async addCandidate(candidate: MemoryCandidate): Promise<void> {
    await this.initialize();
    addSqliteCandidate(this.candidateOps(), candidate);
  }

  async createCandidate(input: CreateCandidateInput): Promise<MemoryCandidate> {
    await this.initialize();
    return createSqliteCandidate(this.candidateOps(), input);
  }

  async listCandidates(includeResolved = false): Promise<MemoryCandidate[]> {
    await this.initialize();
    return listSqliteCandidates({ stmt: (sql) => this.stmt(sql) }, includeResolved);
  }

  async acceptCandidate(candidateId: string): Promise<Sage | undefined> {
    await this.initialize();
    return acceptSqliteCandidate(this.candidateOps(), candidateId);
  }

  async rejectCandidate(candidateId: string, reason: string): Promise<boolean> {
    await this.initialize();
    return this.runMutation(() => {
      return rejectSqliteCandidate(this.candidateOps(), candidateId, reason);
    });
  }

  async resolveCandidate(
    candidateId: string,
    decision: CandidateDecision,
    reason?: string,
  ): Promise<MemoryCandidateResolution | undefined> {
    await this.initialize();
    return resolveSqliteCandidate(
      this.candidateOps(),
      candidateId,
      decision,
      reason,
    );
  }

  // ─── Legacy compat ──────────────────────────────────────────────────

  async importLegacy(raw: string): Promise<LegacyImportResult> {
    return importLegacySqliteMemory({ rememberSage: (input) => this.rememberSage(input) }, raw);
  }

  async consolidateSession(input: SessionConsolidationInput): Promise<SessionConsolidationResult> {
    await this.initialize();
    return consolidateSqliteSession(
      {
        stmt: (sql) => this.stmt(sql),
        listCandidates: () => this.listCandidates(),
        createCandidate: (candidate) => this.createCandidate(candidate),
        acceptCandidate: (candidateId) => this.acceptCandidate(candidateId),
      },
      input,
    );
  }

  // ─── Alias methods matching SageStore's public API ──────────

  async unifiedSearchService(
    query: SearchQuery,
    options?: SearchOptions,
  ): Promise<SearchResult> {
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
    return recoverAdminSage(this.adminHost(), id, reason);
  }
  async backfillRecoverable(options?: SageBackfillOptions): Promise<SageBackfillReport> {
    await this.initialize();
    return backfillAdminSage(this.adminHost(), options);
  }
  async findMemoriesForFile(
    filePath: string,
    options?: FindMemoriesForFileOptions,
  ): Promise<FindMemoriesForFileResponse> {
    await this.initialize();
    return findAdminMemoriesForFile(this.adminHost(), filePath, options);
  }
  private adminHost(): SqliteAdminHost {
    return {
      projectRoot: this.projectRoot,
      now: () => this.now(),
      nowIso: () => this.nowIso(),
      stmt: (sql) => this.stmt(sql),
      runMutation: (work) => this.runMutation(work),
      upsertMemory: (memory) => this.upsertMemory(memory),
      syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
      audit: (event, data) => this.audit(event, data),
      emit: (event, payload) =>
        this.events?.emit(event as never, this.eventPayload(payload) as never),
      listCandidates: () => this.listCandidates(),
    };
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
    await this.initialize();
    await this.runMutation(() => {
      deleteSqliteSage(
        {
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          upsertMemory: (memory) => this.upsertMemory(memory),
          cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
          audit: (event, data) => this.audit(event, data),
          emit: (event, payload) =>
            this.events?.emit(event as never, this.eventPayload(payload) as never),
        },
        id,
        reason,
        options,
      );
    });
  }

  async drainMutations(): Promise<void> {
    await drainSqliteStoreMutations(this.mutationQueue);
  }

  close(): void {
    closeSqliteStore(this.stmtCache, this.db);
  }
}
