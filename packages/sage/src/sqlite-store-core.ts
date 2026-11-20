import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveSagePaths } from './paths.js';
import type { SqliteMemoryMutationsHost } from './sqlite-memory-mutations.js';
import { upsertMemory as upsertMemoryFromHost } from './sqlite-memory-mutations.js';
import { pruneSqliteAuditLog } from './sqlite-store-audit.js';
import {
  acceptCandidateOp,
  addCandidateOp,
  createCandidateOp,
  listCandidatesOp,
  rejectCandidateOp,
  resolveCandidateOp,
  type SqliteCandidateHost,
} from './sqlite-store-candidate-ops.js';
import { reconcileAcceptedCandidates } from './sqlite-store-candidates.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import {
  cascadeDeleteEdges as delegateCascadeDeleteEdges,
  type SqliteStoreGraphHost,
} from './sqlite-store-graph.js';
import {
  audit as auditFromHost,
  type SqliteStoreGraphWriteHost,
  syncAnchorEdges as syncAnchorEdgesFromHost,
} from './sqlite-store-graph-write.js';
import { initializeSqliteSageStore } from './sqlite-store-initialize.js';
import { migrateSqliteLegacyJsonl } from './sqlite-store-jsonl-migration.js';
import { SqliteMutationQueue } from './sqlite-store-mutation-queue.js';
import { initSageHqSync, type SqliteAdminHost } from './sqlite-store-operations.js';
import { SqliteStatementCache } from './sqlite-store-statement-cache.js';
import { upsertSqliteCandidate } from './sqlite-store-upsert.js';
import type {
  CandidateDecision,
  CreateCandidateInput,
  MemoryCandidate,
  MemoryCandidateResolution,
  MemoryGraphEdge,
  RememberSageInput,
  Sage,
  SageSearchOptions,
  SageStatus,
  SageStoreOptions,
  UpdateSageInput,
} from './types.js';

/**
 * Connection, transaction and helper-host machinery behind
 * `SqliteSageStore`: the database handle and statement cache, one-time
 * initialization (incl. legacy JSONL migration), the mutation / counter /
 * composite chains, anchor-edge sync, audit, the candidate review queue,
 * and the host views the `sqlite-store-*` operation modules take. `SqliteSageStore`
 * (sqlite-store.ts) extends this with the public store API; the members the
 * host views need from it are declared abstract here.
 */
export abstract class SqliteSageStoreCore {
  readonly paths;
  protected readonly projectRoot: string;
  protected readonly now: () => Date;
  protected readonly events: SageStoreOptions['events'];
  protected readonly operationContext: SageStoreOptions['operationContext'];
  protected readonly symbolSpans: SageStoreOptions['symbolSpans'];
  protected traceId?: string | undefined;
  protected db!: DatabaseSync;
  protected initialized = false;
  protected initializing: Promise<void> | undefined;
  protected readonly mutationQueue = new SqliteMutationQueue();
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
  protected auditWritesSincePrune = 0;
  protected readonly stmtCache = new SqliteStatementCache(128);

  constructor(opts: SageStoreOptions) {
    this.projectRoot = path.resolve(opts.projectRoot);
    this.paths = resolveSagePaths(this.projectRoot, opts.directory);
    this.traceId = opts.traceId;
    this.now = opts.now ?? (() => new Date());
    this.events = opts.events;
    this.operationContext = opts.operationContext;
    this.symbolSpans = opts.symbolSpans;
  }

  withTraceId(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  /** Prepare-once helper: compile `sql` on first use, reuse thereafter. */
  protected stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    return this.stmtCache.get(this.db, sql);
  }

  protected rowToMemory(row: { data: string }): Sage {
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

  protected async initializeOnce(): Promise<void> {
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
    initSageHqSync(this.db);
    // H2 (docs/archive/plans/sage-phase4-design.md): reconcile candidates whose memoryId
    // annotation was lost to a crash between rememberSage and the annotation
    // write. Recovery failure is audited, never fatal — the store must open.
    try {
      await this.runMutation(() =>
        reconcileAcceptedCandidates({
          stmt: (sql) => this.stmt(sql),
          nowIso: () => this.nowIso(),
          audit: (event, data) => this.audit(event, data),
        }),
      );
    } catch (error) {
      this.audit('memory.candidate_accept_reconcile_failed', {
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    this.initialized = true;
  }

  // ─── JSONL migration ────────────────────────────────────────────────

  protected async migrateFromJsonl(): Promise<void> {
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

  protected nowIso(): string {
    return this.now().toISOString();
  }

  protected currentTraceId(): string | undefined {
    return this.operationContext?.()?.traceId ?? this.traceId;
  }

  protected cascadeDeleteEdges(nodeId: string): void {
    delegateCascadeDeleteEdges((sql) => this.stmt(sql), nodeId);
  }

  /**
   * Serialize mutations with the file lock and a single SQLite write transaction.
   * Multi-statement paths (remember merge, cascade delete, counter batch) commit
   * once instead of once per prepared statement.
   */
  protected runMutation<T>(work: () => T, signal?: AbortSignal): Promise<T> {
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
  protected runCounterMutation<T>(work: () => T extends Promise<unknown> ? never : T): Promise<T> {
    return this.mutationQueue.runCounter(this.db, work);
  }

  protected runCompositeOperation<T>(work: () => Promise<T>): Promise<T> {
    return this.mutationQueue.runCompositeOperation(work);
  }

  protected upsertMemory(m: Sage): void {
    upsertMemoryFromHost.call(this.sqliteMemoryMutationsHost(), m);
  }

  protected upsertCandidate(candidate: MemoryCandidate, canonicalText?: string): void {
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
  protected syncAnchorEdges(memory: Sage): void {
    syncAnchorEdgesFromHost(this.sqliteStoreGraphWriteHost(), memory);
  }

  // ─── Audit ──────────────────────────────────────────────────────────

  protected audit(event: string, data?: Record<string, unknown>): void {
    auditFromHost(this.sqliteStoreGraphWriteHost(), event, data);
  }

  /** Delete all but the most recent {@link AUDIT_LOG_MAX_ROWS} audit rows. */
  protected pruneAuditLog(): void {
    pruneSqliteAuditLog({ stmt: (sql) => this.stmt(sql) });
  }

  protected eventPayload<T extends object>(
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

  protected candidateHost(): SqliteCandidateHost {
    return {
      projectRoot: this.projectRoot,
      paths: this.paths,
      stmt: (...args) => this.stmt(...args),
      nowIso: (...args) => this.nowIso(...args),
      runMutation: (...args) => this.runMutation(...args),
      rememberSage: (...args) => this.rememberSage(...args),
      updateSage: (...args) => this.updateSage(...args),
      upsertCandidate: (...args) => this.upsertCandidate(...args),
      audit: (...args) => this.audit(...args),
    };
  }

  protected adminHost(): SqliteAdminHost {
    return {
      projectRoot: this.projectRoot,
      now: (...args) => this.now(...args),
      nowIso: (...args) => this.nowIso(...args),
      stmt: (...args) => this.stmt(...args),
      runMutation: (...args) => this.runMutation(...args),
      upsertMemory: (...args) => this.upsertMemory(...args),
      syncAnchorEdges: (...args) => this.syncAnchorEdges(...args),
      audit: (...args) => this.audit(...args),
      emit: (event, payload) =>
        this.events?.emit(event as never, this.eventPayload(payload) as never),
      listCandidates: (...args) => this.listCandidates(...args),
    };
  }

  protected sqliteStoreGraphHost(): SqliteStoreGraphHost {
    return {
      stmt: (...args) => this.stmt(...args),
      nowIso: (...args) => this.nowIso(...args),
      initialize: (...args) => this.initialize(...args),
      events: this.events,
      eventPayload: (...args) => this.eventPayload(...args),
      projectRoot: this.projectRoot,
      searchSage: (...args) => this.searchSage(...args),
      traverseGraph: (...args) => this.traverseGraph(...args),
    };
  }

  protected sqliteMemoryMutationsHost(): SqliteMemoryMutationsHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.initialize satisfies SqliteMemoryMutationsHost['initialize']);
    void (this.runMutation satisfies SqliteMemoryMutationsHost['runMutation']);
    void (this.stmt satisfies SqliteMemoryMutationsHost['stmt']);
    void (this.nowIso satisfies SqliteMemoryMutationsHost['nowIso']);
    void (this.upsertMemory satisfies SqliteMemoryMutationsHost['upsertMemory']);
    void (this.cascadeDeleteEdges satisfies SqliteMemoryMutationsHost['cascadeDeleteEdges']);
    void (this.audit satisfies SqliteMemoryMutationsHost['audit']);
    void (this.events satisfies SqliteMemoryMutationsHost['events']);
    void (this.syncAnchorEdges satisfies SqliteMemoryMutationsHost['syncAnchorEdges']);
    void (this.db satisfies SqliteMemoryMutationsHost['db']);
    void (this.projectRoot satisfies SqliteMemoryMutationsHost['projectRoot']);
    void (this.symbolSpans satisfies SqliteMemoryMutationsHost['symbolSpans']);
    void (this.eventPayload satisfies SqliteMemoryMutationsHost['eventPayload']);
    void (this.deleteSage satisfies SqliteMemoryMutationsHost['deleteSage']);
    void (this.runCounterMutation satisfies SqliteMemoryMutationsHost['runCounterMutation']);
    return this as unknown as SqliteMemoryMutationsHost;
  }

  protected sqliteStoreGraphWriteHost(): SqliteStoreGraphWriteHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      sqliteStoreGraphHost: this.sqliteStoreGraphHost,
      projectRoot: this.projectRoot,
      symbolSpans: this.symbolSpans,
      initialize: this.initialize,
      nowIso: this.nowIso,
      stmt: this.stmt,
      runMutation: this.runMutation,
      upsertMemory: this.upsertMemory,
      syncAnchorEdges: this.syncAnchorEdges,
      events: this.events,
      eventPayload: this.eventPayload,
      runCompositeOperation: this.runCompositeOperation,
      currentTraceId: this.currentTraceId,
      auditWritesSincePrune: this.auditWritesSincePrune,
      now: this.now,
      listMemories: this.listMemories,
      listCandidates: this.listCandidates,
      addCandidate: this.addCandidate,
      cascadeDeleteEdges: this.cascadeDeleteEdges,
      audit: this.audit,
      pruneAuditLog: this.pruneAuditLog,
    } satisfies SqliteStoreGraphWriteHost);
    return this as unknown as SqliteStoreGraphWriteHost;
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
    return this.runCompositeOperation(() => acceptCandidateOp(this.candidateHost(), candidateId));
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
    return this.runCompositeOperation(() =>
      resolveCandidateOp(this.candidateHost(), candidateId, decision, reason),
    );
  }

  abstract rememberSage(input: RememberSageInput): Promise<Sage>;
  abstract updateSage(id: string, input: UpdateSageInput): Promise<Sage>;
  abstract listMemories(opts?: {
    status?: SageStatus | 'all';
    kind?: string;
    limit?: number;
    offset?: number;
  }): Promise<Sage[]>;
  abstract searchSage(query: string, opts?: SageSearchOptions): Promise<Sage[]>;
  abstract traverseGraph(
    starts: string[],
    opts?: { maxDepth?: number; limit?: number },
  ): Promise<MemoryGraphEdge[]>;
  abstract deleteSage(
    id: string,
    reason?: string,
    options?: { force?: boolean; neverInject?: boolean },
  ): Promise<void>;
}
