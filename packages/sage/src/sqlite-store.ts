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
import { readSqliteAudit, pruneSqliteAuditLog, writeSqliteAudit } from './sqlite-store-audit.js';
import { retrieveSqliteSageForAudience } from './sqlite-store-audience.js';
import {
  acceptCandidateOp,
  addCandidateOp,
  createCandidateOp,
  listCandidatesOp,
  rejectCandidateOp,
  resolveCandidateOp,
  type SqliteCandidateHost,
} from './sqlite-store-candidate-ops.js';
import {
  readAllSqliteMemory,
  readSqliteMemory,
  rememberSqliteMemoryBridge,
} from './sqlite-store-legacy-bridge.js';
import { upsertSqliteCandidate, upsertSqliteMemory } from './sqlite-store-upsert.js';
import { probeSqliteAvailable } from './sqlite-store-loader.js';
import { graphSqliteSageFor } from './sqlite-store-graph-for.js';
import { traverseSqliteGraph } from './sqlite-store-graph-traverse.js';
import {
  findRelatedSqliteSage,
  type SqliteFindRelatedOptions,
} from './sqlite-store-find-related.js';
import { runSqliteSageHygiene } from './sqlite-store-hygiene.js';
import { syncSqliteAnchorEdges } from './sqlite-store-anchor-sync.js';
import { syncSqliteRelationshipEdges } from './sqlite-store-relationship-sync.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { retrieveSqliteSageForPath } from './sqlite-store-retrieve-path.js';
import { initializeSqliteSageStore } from './sqlite-store-initialize.js';
import { searchSqliteSage, materializeSageByIdFactory } from './sqlite-store-search-sage.js';
import { executeUnifiedSearch } from './sqlite-store-search.js';
import { augmentLexicalWithVectorRecall } from './retrieval/vector-augment.js';
import type { VectorAugmentHit } from './retrieval/vector-augment.js';
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
import { DEFAULT_PERSISTENCE } from './types.js';

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
    upsertSqliteMemory((sql) => this.stmt(sql), m);
  }

  private upsertCandidate(candidate: MemoryCandidate, canonicalText?: string): void {
    upsertSqliteCandidate((sql) => this.stmt(sql), candidate, canonicalText);
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
   *   NOTE: with `ON CONFLICT … DO UPDATE SET weight = MAX(weight, excluded.weight)`
   *   (unified 2026-08-02, see sqlite-store-schema.ts) concurrent writers can
   *   never erode an edge, but the weight is still the confidence of whichever
   *   memory synced LAST when multiple memories share the same anchor target —
   *   a last-sync-wins race on WHICH memory's confidence is reflected, not a
   *   CRDT merge. Acceptable because the value tracks the most recently
   *   refreshed confidence and re-sync converges to the newer memory.
   */
  private syncAnchorEdges(memory: Sage): void {
    const deps = { stmt: (sql: string) => this.stmt(sql), nowIso: () => this.nowIso() };
    syncSqliteAnchorEdges(deps, memory);
    // Same hook, so every writer that refreshes a memory's graph projection
    // (remember, update, hygiene, admin) also materializes its relationship
    // assertions. Insert-only — see syncSqliteRelationshipEdges.
    syncSqliteRelationshipEdges(deps, memory);
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
    const lexical = searchSqliteSage({ stmt: (sql) => this.stmt(sql) }, query, opts);
    if (!opts?.vectorRecall) return lexical;
    // Fused semantic recall — the vector channel is fail-open by contract
    // (any backend error falls through to the lexical list).
    const fused = await augmentLexicalWithVectorRecall(query, lexical, {
      vectorRecall: opts.vectorRecall,
      // Vector-only hits (semantically close but lexically missed) are
      // materialized by id under the SAME visibility rules as the lexical
      // channel — see materializeSageByIdFactory.
      materializeVectorOnly: materializeSageByIdFactory({ stmt: (sql) => this.stmt(sql) }, opts),
      ...(opts.vectorRecallWeight !== undefined ? { vectorWeight: opts.vectorRecallWeight } : {}),
      ...(opts.vectorRecallMinScore !== undefined ? { threshold: opts.vectorRecallMinScore } : {}),
      ...(opts.vectorRecallThreshold !== undefined
        ? { vectorOnlyThreshold: opts.vectorRecallThreshold }
        : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    return fused.map((hit) => hit.memory);
  }

  /**
   * Rich variant of `searchSage` that returns the augmented hits
   * (memory + per-channel scores + RRF final score + source attribution)
   * rather than a flat `Sage[]`. Use this when the caller wants to
   * surface the dual-channel breakdown to the user — e.g. the
   * `memory_search_explain` tool, the WebUI memory manager, or any
   * diagnostic that needs to answer "did this hit come from lexical,
   * semantic, or both?".
   *
   * When no `vectorRecall` is wired the result collapses to
   * `source: 'lexical'` hits with `vectorScore: null` — the same shape
   * the fused path would have produced, so consumers don't need to
   * branch.
   */
  async searchSageWithBreakdown(
    query: string,
    opts?: SageSearchOptions,
  ): Promise<VectorAugmentHit[]> {
    await this.initialize();
    const lexical = searchSqliteSage({ stmt: (sql) => this.stmt(sql) }, query, opts);
    if (!opts?.vectorRecall) {
      // No semantic channel — return lexical hits as augmentation hits
      // with `vectorScore: null` so consumers can render them uniformly.
      return lexical.map((memory, index) => ({
        memory,
        vectorScore: null,
        lexicalScore: lexical.length <= 1 ? 1 : 1 - index / (lexical.length - 1),
        finalScore: lexical.length <= 1 ? 1 : 1 - index / (lexical.length - 1),
        source: 'lexical' as const,
      }));
    }
    return augmentLexicalWithVectorRecall(query, lexical, {
      vectorRecall: opts.vectorRecall,
      // Same vector-only materialization contract as searchSage —
      // visibility-respecting, fail-open on unknown ids.
      materializeVectorOnly: materializeSageByIdFactory({ stmt: (sql) => this.stmt(sql) }, opts),
      ...(opts.vectorRecallWeight !== undefined ? { vectorWeight: opts.vectorRecallWeight } : {}),
      ...(opts.vectorRecallMinScore !== undefined ? { threshold: opts.vectorRecallMinScore } : {}),
      ...(opts.vectorRecallThreshold !== undefined
        ? { vectorOnlyThreshold: opts.vectorRecallThreshold }
        : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
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
    // Monotone merge policy (unified 2026-08-02): `MAX(weight, excluded.weight)`
    // — concurrent writers can never erode an edge and repeated identical
    // assertions are idempotent instead of inflating strength. See the policy
    // note beside the `edges` table in sqlite-store-schema.ts.
    this.stmt(
      `INSERT INTO edges (from_node, to_node, relation, weight, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(from_node, to_node, relation) DO UPDATE SET weight = MAX(weight, excluded.weight)`,
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

  private candidateHost(): SqliteCandidateHost {
    return {
      projectRoot: this.projectRoot,
      paths: this.paths,
      stmt: (sql) => this.stmt(sql),
      nowIso: () => this.nowIso(),
      runMutation: (work) => this.runMutation(work),
      rememberSage: (input) => this.rememberSage(input),
      updateSage: (id, input) => this.updateSage(id, input),
      upsertCandidate: (candidate, canonicalText) => this.upsertCandidate(candidate, canonicalText),
      audit: (event, data) => this.audit(event, data),
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
    return addCandidateOp(this.candidateHost(), candidate);
  }

  async createCandidate(input: CreateCandidateInput): Promise<MemoryCandidate> {
    await this.initialize();
    return createCandidateOp(this.candidateHost(), input);
  }

  async listCandidates(includeResolved = false): Promise<MemoryCandidate[]> {
    await this.initialize();
    return listCandidatesOp(this.candidateHost(), includeResolved);
  }

  async acceptCandidate(candidateId: string): Promise<Sage | undefined> {
    await this.initialize();
    return acceptCandidateOp(this.candidateHost(), candidateId);
  }

  async rejectCandidate(candidateId: string, reason: string): Promise<boolean> {
    await this.initialize();
    return rejectCandidateOp(this.candidateHost(), candidateId, reason);
  }

  async resolveCandidate(
    candidateId: string,
    decision: CandidateDecision,
    reason?: string,
  ): Promise<MemoryCandidateResolution | undefined> {
    await this.initialize();
    return resolveCandidateOp(this.candidateHost(), candidateId, decision, reason);
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
