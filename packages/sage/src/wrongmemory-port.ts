/**
 * WrongMemory-backed {@link MemoryPort}.
 *
 * Talks to the `wrongmemoryd` service over the vendored
 * `@wrongstack/wrongmemory-client`. It exposes the same capability surface as
 * {@link ProjectSageMemoryPort} (`wrongstack.memory.sage-service.v1`,
 * `wrongstack.memory.retrieval.v1`, `wrongstack.memory.surface.v1`) and maps
 * every operation the daemon supports. Anything the daemon cannot serve
 * throws {@link WrongMemoryNotImplementedError}; this port NEVER falls back to
 * a local SQLite store. A lost daemon surfaces as
 * {@link WrongMemoryUnavailableError} (the next call reconnects).
 *
 * Session visibility: the daemon binds ONE session per connection
 * (`session.acquire{hostSessionId}`). Every call that carries a session
 * (explicit `sessionId` option, else `getSessionId()`) binds it first under a
 * port-wide lock, so a bind and the call it scopes never interleave with
 * another session's call. A call without a session releases the binding, so
 * owned session records stay hidden — the same under-report rule the SQLite
 * store applies. `includeAllSessions` cannot be honored (the daemon exposes no
 * cross-session view) and is ignored.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type {
  MemoryCapability,
  MemoryEntry,
  MemoryHealth,
  MemoryPort,
  MemoryScope,
} from '@wrongstack/contracts/types';
import { buildChildEnv } from '@wrongstack/core/utils';
import {
  type ConnectOptions,
  isWrongMemoryError,
  METHODS,
  type ProjectInfo,
  resolveDataRoot,
  type SearchResult as WireSearchResult,
  WrongMemoryClient,
  WrongMemoryError,
} from '@wrongstack/wrongmemory-client';
import {
  legacyToSageScope,
  legacyTypeToKind,
  sageToLegacyScope,
  toLegacyEntry,
} from './legacy-memory-conversion.js';
import type { SageRetrievalCapability } from './memory-port.js';
import type { VectorAugmentHit } from './retrieval/vector-augment.js';
import type {
  SageServiceLike,
  SageSurface,
  SearchHit,
  SearchOptions,
  SearchQuery,
  SearchResult,
} from './service-contract.js';
import { DEFAULT_PAGE_STATUSES, VALID_MEMORY_STATUSES } from './shared/pagination.js';
import { importanceFromPriority } from './sqlite-store-legacy.js';
import { readAllSqliteMemory, readSqliteMemory } from './sqlite-store-legacy-bridge.js';
import type {
  CandidateDecision,
  CreateCandidateInput,
  ListSagePageOptions,
  ListSagePageResult,
  MemoryCandidate,
  MemoryCandidateResolution,
  MemoryGraphEdge,
  RememberSageInput,
  Sage,
  SageBackfillOptions,
  SageBackfillReport,
  SageForPathOptions,
  SageHygieneOptions,
  SageHygieneReport,
  SageStats,
  SageStatus,
  UpdateSageInput,
} from './types.js';

export const WRONGMEMORY_BACKEND = 'wrongmemory';

const SAGE_SERVICE_CAPABILITY_ID = 'wrongstack.memory.sage-service.v1';
const SAGE_RETRIEVAL_CAPABILITY_ID = 'wrongstack.memory.retrieval.v1';
const SAGE_SURFACE_CAPABILITY_ID = 'wrongstack.memory.surface.v1';

/** Daemon page ceiling (`MAX_PAGE_SIZE` in the wire contract). */
const DAEMON_MAX_PAGE = 200;
const SLOW_OP_TIMEOUT_MS = 5 * 60_000;
const CANDIDATE_STATUSES = ['pending', 'accepted', 'rejected', 'merged'] as const;
/** `memory.update` accepts exactly these keys; anything else is rejected by the daemon. */
const UPDATE_KEYS = [
  'text',
  'persistence',
  'kind',
  'status',
  'tags',
  'anchors',
  'importance',
  'confidence',
  'freshness',
  'audience',
  'supersedes',
  'contradicts',
  'supersededBy',
  'validity',
  'sources',
  'expectedRevision',
  'force',
] as const;
const HYGIENE_KEYS = [
  'retentionDays',
  'sessionRetentionDays',
  'archiveLowConfidenceAfterDays',
  'archiveUnusedAfterDays',
  'unusedMinInjections',
  'verify',
  'verifyDepth',
  'nearDedup',
  'purgeDeletedAfterDays',
] as const;

/** An operation the WrongMemory daemon does not serve. Never retried locally. */
export class WrongMemoryNotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED' as const;
  constructor(readonly operation: string) {
    super(`NOT_IMPLEMENTED: ${operation} is not supported by the WrongMemory backend`);
    this.name = 'WrongMemoryNotImplementedError';
  }
}

/** The WrongMemory daemon is unreachable or the connection dropped. No inline fallback. */
export class WrongMemoryUnavailableError extends Error {
  readonly code = 'WRONGMEMORY_UNAVAILABLE' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(`WRONGMEMORY_UNAVAILABLE: ${message}`, options);
    this.name = 'WrongMemoryUnavailableError';
  }
}

/** The project root has no WrongMemory registration and this port may not create one. */
export class WrongMemoryProjectNotRegisteredError extends Error {
  readonly code = 'PROJECT_NOT_FOUND' as const;
  constructor(readonly projectRoot: string) {
    super(`PROJECT_NOT_FOUND: ${projectRoot} is not registered with WrongMemory`);
    this.name = 'WrongMemoryProjectNotRegisteredError';
  }
}

/** The subset of {@link WrongMemoryClient} this port uses (test seam). */
export interface WrongMemoryClientLike {
  call<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { projectId?: string; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<T>;
  close(): void;
}

export interface WrongMemoryPortOptions {
  projectRoot: string;
  /** Use this registered project instead of locating/registering by root. */
  projectId?: string | undefined;
  /** WrongMemory data root (default: `WRONGMEMORY_HOME` or `~/.wrongmemory`). */
  dataRoot?: string | undefined;
  /** `wrongmemoryd` executable used when `startPolicy` is `on-demand`. */
  daemonPath?: string | undefined;
  /** `on-demand` starts the daemon when none is reachable; `never` only attaches. */
  startPolicy?: 'on-demand' | 'never' | undefined;
  /** When false, an unregistered root fails instead of being registered. Default true. */
  register?: boolean | undefined;
  /** Session resolver used when a call carries no explicit `sessionId`. */
  getSessionId?: (() => string | undefined) | undefined;
  clientName?: string | undefined;
  timeoutMs?: number | undefined;
  /** Daemon launcher used for `on-demand` starts (tests). */
  startDaemon?: ((options: StartDaemonOptions) => Promise<WrongMemoryClientLike>) | undefined;
  /** Connection factory (tests). Defaults to `WrongMemoryClient.connect`. */
  connect?: ((options: ConnectOptions) => Promise<WrongMemoryClientLike>) | undefined;
}

interface MutationOutcome<R = unknown> {
  outcome: string;
  id: string;
  revision?: number;
  replayed: boolean;
  record: R;
}

interface CandidateOutcome {
  candidateId: string;
  status: string;
  memoryId?: string;
  decision?: string;
  targetMemoryId?: string;
  applied: boolean;
  alreadyResolved: boolean;
}

interface WireGraphView {
  edges: Array<{ from: string; to: string; relation: string; weight: number; createdAt: string }>;
}

interface WirePage {
  memories: Sage[];
  nextCursor: string | null;
  total: number;
  statusCounts: Record<string, number>;
}

interface WireStats {
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  pendingCandidates?: number;
  edges: number;
}

type CallOpts = { timeoutMs?: number; idempotencyKey?: string };
/** `undefined` session = release any binding; a string binds that host session. */
type SessionChoice = { sessionId: string | undefined };

function normalizeRoot(root: string): string {
  let r = path.resolve(root.replace(/^\\\\\?\\/, ''));
  r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Drop `undefined` members so the wire carries only intended fields. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function pick(source: object, keys: readonly string[]): Record<string, unknown> {
  const rec = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (rec[k] !== undefined) out[k] = rec[k];
  return out;
}

function isTransportFailure(error: unknown): boolean {
  return (
    isWrongMemoryError(error) &&
    (error.code === 'UNAVAILABLE' ||
      error.code === 'TRANSPORT' ||
      error.code === 'DEADLINE_EXCEEDED' ||
      error.code === 'SHUTTING_DOWN')
  );
}

function filterStatuses(memories: Sage[], statuses: SageStatus[] | undefined): Sage[] {
  if (!statuses || statuses.length === 0) return memories;
  const allowed = new Set<string>(statuses);
  return memories.filter((m) => allowed.has(m.status));
}

function rankScore(index: number, total: number): number {
  return total <= 1 ? 1 : 1 - index / (total - 1);
}

export class WrongMemoryPort implements MemoryPort {
  private client: WrongMemoryClientLike | undefined;
  private connecting: Promise<WrongMemoryClientLike> | undefined;
  private project: ProjectInfo | undefined;
  /** Session bound on the current connection; `undefined` = none. */
  private boundSession: string | undefined;
  private lock: Promise<unknown> = Promise.resolve();
  private traceId: string | undefined;
  private disposed = false;

  constructor(private readonly options: WrongMemoryPortOptions) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await this.ensureProject();
  }

  /** Registered project this port serves (after `initialize`). */
  getProject(): ProjectInfo | undefined {
    return this.project;
  }

  async health(): Promise<MemoryHealth> {
    try {
      const client = await this.ensureClient();
      const health = await client.call<Record<string, unknown>>(
        METHODS.DAEMON_HEALTH,
        {},
        {
          timeoutMs: 5_000,
        },
      );
      const project = this.project;
      const readOnly = project !== undefined && project.admission !== 'read-write';
      return {
        status: readOnly ? 'degraded' : 'ready',
        backend: WRONGMEMORY_BACKEND,
        details: {
          ...health,
          projectId: project?.projectId,
          admission: project?.admission,
          admissionReason: project?.admissionReason,
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        backend: WRONGMEMORY_BACKEND,
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dropClient();
  }

  /** Drop the connection but stay usable; the next call reconnects. */
  releaseConnection(): void {
    this.dropClient();
  }

  withTraceId(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  getBackend(): unknown {
    return {
      kind: WRONGMEMORY_BACKEND,
      projectId: this.project?.projectId,
      connected: this.client !== undefined,
      traceId: this.traceId,
    };
  }

  getCapability<T>(capability: MemoryCapability<T>): T | undefined {
    switch (capability.id) {
      case SAGE_SERVICE_CAPABILITY_ID:
        return this.serviceCapability as unknown as T;
      case SAGE_RETRIEVAL_CAPABILITY_ID:
        return this.retrievalCapability as unknown as T;
      case SAGE_SURFACE_CAPABILITY_ID:
        return this.surfaceCapability as unknown as T;
      default:
        return undefined;
    }
  }

  // ─── Legacy MemoryStore ────────────────────────────────────────────

  readAll(): Promise<string> {
    return readAllSqliteMemory((scope) => this.read(scope));
  }

  read(scope: MemoryScope): Promise<string> {
    return readSqliteMemory((s) => this.list(s), scope);
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

  /**
   * Legacy bulk mutations run on the daemon (`memory.legacy*`, curator
   * action) with the baseline semantics, restricted to rows this session
   * can see. A grant without the curator profile gets `FORBIDDEN`.
   */
  async forget(query: string, scope: MemoryScope = 'project-memory'): Promise<number> {
    const result = await this.scoped<{ record: { removed: number } }>(
      METHODS.MEMORY_LEGACY_FORGET,
      { query, scope },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    return result.record.removed;
  }

  async consolidate(scope: MemoryScope): Promise<void> {
    await this.scoped(METHODS.MEMORY_LEGACY_CONSOLIDATE, { scope }, this.session(undefined), {
      timeoutMs: SLOW_OP_TIMEOUT_MS,
    });
  }

  /** `clear()` without a scope clears every scope, as the baseline does. */
  async clear(scope?: MemoryScope): Promise<void> {
    await this.scoped(
      METHODS.MEMORY_LEGACY_CLEAR,
      scope ? { scope } : { all: true },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
  }

  /** Active memories of one legacy scope, newest first (SQLite `list` order). */
  async list(scope: MemoryScope = 'project-memory', limit?: number): Promise<MemoryEntry[]> {
    const memories = (await this.listSage(['active'])).filter(
      (m) => (m.legacyScope ?? sageToLegacyScope(m.scope)) === scope,
    );
    memories.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    );
    const entries = memories.map(toLegacyEntry);
    return limit === undefined ? entries : entries.slice(0, Math.max(0, limit));
  }

  async search(
    query: string,
    scope: MemoryScope = 'project-memory',
    limit?: number,
  ): Promise<MemoryEntry[]> {
    const memories = await this.searchSage(query, limit === undefined ? {} : { limit });
    return memories
      .filter((m) => m.contextPolicy !== 'never')
      .filter((m) => (m.legacyScope ?? sageToLegacyScope(m.scope)) === scope)
      .map(toLegacyEntry);
  }

  findRelated(text: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    return this.search(text, scope, limit);
  }

  hygiene(options?: SageHygieneOptions): Promise<SageHygieneReport> {
    return this.runHygiene(options);
  }

  // ─── SAGE operations ───────────────────────────────────────────────

  async searchSage(
    query: string,
    options: {
      limit?: number | undefined;
      includeStatuses?: SageStatus[] | undefined;
      sessionId?: string | undefined;
    } = {},
  ): Promise<Sage[]> {
    const result = await this.scoped<WireSearchResult>(
      METHODS.MEMORY_SEARCH,
      compact({ query, limit: options.limit, statuses: options.includeStatuses }),
      this.session(options.sessionId),
    );
    return result.hits.map((hit) => hit.memory as unknown as Sage);
  }

  async searchSageWithBreakdown(
    query: string,
    options: { limit?: number | undefined; sessionId?: string | undefined } = {},
  ): Promise<VectorAugmentHit[]> {
    // Lexical-only: vector fusion ownership is not on the daemon yet.
    const rows = await this.searchSage(query, options);
    return rows.map((memory, index) => {
      const score = rankScore(index, rows.length);
      return {
        memory,
        vectorScore: null,
        lexicalScore: score,
        finalScore: score,
        source: 'lexical',
      };
    });
  }

  async getSage(id: string, sessionId?: string): Promise<Sage | null> {
    try {
      return await this.scoped<Sage>(METHODS.MEMORY_GET, { id }, this.session(sessionId));
    } catch (error) {
      if (isWrongMemoryError(error, 'NOT_FOUND')) return null;
      throw error;
    }
  }

  async retrieveForPath(options: SageForPathOptions): Promise<Sage[]> {
    const result = await this.scoped<WireSearchResult>(
      METHODS.MEMORY_FOR_PATH,
      compact({ path: options.path, limit: options.limit }),
      this.session(options.sessionId),
    );
    return filterStatuses(
      result.hits.map((hit) => hit.memory as unknown as Sage),
      options.includeStatuses,
    );
  }

  async rememberSage(input: RememberSageInput): Promise<Sage> {
    const params = compact({
      text: input.text,
      kind: input.kind ?? (input.type !== undefined ? legacyTypeToKind(input.type) : undefined),
      scope: input.scope ?? (input.legacyScope ? legacyToSageScope(input.legacyScope) : undefined),
      persistence: input.persistence,
      tags: input.tags,
      anchors: input.anchors,
      audience: input.audience,
      sources: input.sources,
      validity: input.validity,
      importance:
        input.importance ??
        (input.priority !== undefined ? importanceFromPriority(input.priority) : undefined),
      confidence: input.confidence,
      freshness: input.freshness,
      expiresAt: input.expiresAt,
      supersedes: input.supersedes,
      contradicts: input.contradicts,
    });
    const outcome = await this.scoped<MutationOutcome<Sage>>(
      METHODS.MEMORY_REMEMBER,
      params,
      this.session(input.ownerSessionId),
    );
    return outcome.record;
  }

  async updateSage(id: string, patch: UpdateSageInput): Promise<Sage> {
    let record: Sage | undefined;
    if (patch.feedback) {
      const { verdict, observedRevision, evidence } = patch.feedback;
      const outcome = await this.scoped<MutationOutcome<Sage>>(
        METHODS.MEMORY_FEEDBACK,
        { id, feedback: { verdict, observedRevision, evidence } },
        this.session(patch.feedback.sessionId),
      );
      record = outcome.record;
    }
    const fields = pick(patch, UPDATE_KEYS);
    if (Object.keys(fields).length > 0 || record === undefined) {
      const outcome = await this.scoped<MutationOutcome<Sage>>(
        METHODS.MEMORY_UPDATE,
        { id, ...fields },
        this.session(undefined),
      );
      record = outcome.record;
    }
    return record;
  }

  async deleteSage(
    id: string,
    reason?: string,
    options?: { force?: boolean; neverInject?: boolean },
  ): Promise<void> {
    await this.scoped(
      METHODS.MEMORY_DELETE,
      compact({ id, reason, force: options?.force, neverInject: options?.neverInject }),
      this.session(undefined),
    );
  }

  async recoverSage(id: string, reason?: string): Promise<Sage> {
    return this.scoped<Sage>(
      METHODS.MEMORY_RECOVER,
      compact({ id, reason }),
      this.session(undefined),
    );
  }

  async backfillRecoverable(options: SageBackfillOptions = {}): Promise<SageBackfillReport> {
    return this.scoped<SageBackfillReport>(
      METHODS.MEMORY_BACKFILL,
      { filter: compact({ ...(options.filter ?? {}) }), apply: options.dryRun === false },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
  }

  async recordUsage(
    memoryIds: string[],
    kind: 'injection' | 'use',
    label: string,
    sessionId?: string,
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.scoped(
      METHODS.MEMORY_RECORD_USAGE,
      { ids: memoryIds, kind, label },
      this.session(sessionId),
    );
  }

  async findRelatedSage(
    memoryIds: string[],
    options: {
      limit?: number | undefined;
      maxDepth?: number | undefined;
      includeStatuses?: SageStatus[] | undefined;
      sessionId?: string | undefined;
    } = {},
  ): Promise<Sage[]> {
    const result = await this.scoped<{ hits: Array<{ memory: Sage }> }>(
      METHODS.MEMORY_RELATED,
      compact({ ids: memoryIds, limit: options.limit, maxDepth: options.maxDepth }),
      this.session(options.sessionId),
    );
    return filterStatuses(
      result.hits.map((h) => h.memory),
      options.includeStatuses,
    );
  }

  /**
   * `memory.forAudience`: the daemon runs the baseline audience scan
   * (importance-ordered windows, 10k scan cap, case-folded matching) under
   * the session rule and audits truncation itself. `includeAllSessions` has
   * no daemon equivalent and is ignored, as for every other read.
   */
  async retrieveForAudience(
    context: { role?: string; taskType?: string; mode?: string },
    limit?: number,
    onTruncated?: (info: { sqlRowsExamined: number; returned: number }) => void,
    sessionId?: string,
    _includeAllSessions?: boolean,
  ): Promise<Sage[]> {
    const result = await this.scoped<{
      memories: Sage[];
      truncated: { sqlRowsExamined: number; returned: number } | null;
    }>(
      METHODS.MEMORY_FOR_AUDIENCE,
      compact({ context: compact({ ...context }), limit }),
      this.session(sessionId),
    );
    if (result.truncated) onTruncated?.(result.truncated);
    return result.memories;
  }

  async graphFor(query: string, maxDepth?: number, limit?: number): Promise<MemoryGraphEdge[]> {
    const view = await this.scoped<WireGraphView>(
      METHODS.MEMORY_GRAPH,
      compact({ query, maxDepth, limit }),
      this.session(undefined),
    );
    return view.edges.map((edge) => ({
      schemaVersion: 1,
      id: `${edge.from}->${edge.to}:${edge.relation}`,
      from: edge.from,
      to: edge.to,
      relation: edge.relation as MemoryGraphEdge['relation'],
      weight: edge.weight,
      createdAt: edge.createdAt,
    }));
  }

  async stats(): Promise<SageStats> {
    const wire = await this.scoped<WireStats>(METHODS.MEMORY_STATS, {}, this.session(undefined));
    const total = Object.values(wire.byStatus).reduce((sum, n) => sum + n, 0);
    return {
      total,
      byStatus: wire.byStatus as SageStats['byStatus'],
      byKind: wire.byKind as SageStats['byKind'],
      edges: wire.edges,
    };
  }

  async listSagePage(options: ListSagePageOptions = {}): Promise<ListSagePageResult> {
    const limit =
      options.limit === undefined
        ? undefined
        : Math.min(DAEMON_MAX_PAGE, Math.max(1, options.limit));
    const page = await this.scoped<WirePage>(
      METHODS.MEMORY_LIST_PAGE,
      compact({
        statuses: options.statuses,
        kind: options.kind === 'all' ? undefined : options.kind,
        query: options.query,
        limit,
        cursor: options.cursor,
      }),
      this.session(options.sessionId),
    );
    return {
      memories: page.memories,
      nextCursor: page.nextCursor ?? null,
      total: page.total,
      statusCounts: page.statusCounts,
    };
  }

  /** Every memory with the given statuses, walked page by page (cursor-deduplicated). */
  async listSage(statuses?: SageStatus[]): Promise<Sage[]> {
    const effective = statuses && statuses.length > 0 ? statuses : DEFAULT_PAGE_STATUSES;
    const valid = effective.filter((status) => VALID_MEMORY_STATUSES.has(status));
    if (valid.length === 0) return [];
    const seen = new Set<string>();
    const seenCursors = new Set<string>();
    const memories: Sage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listSagePage({
        statuses: valid,
        limit: DAEMON_MAX_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const memory of page.memories) {
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        memories.push(memory);
      }
      const next = page.nextCursor ?? undefined;
      if (next === undefined || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    } while (cursor !== undefined);
    return memories;
  }

  async createCandidate(input: CreateCandidateInput): Promise<MemoryCandidate> {
    const outcome = await this.scoped<MutationOutcome<MemoryCandidate>>(
      METHODS.CANDIDATE_PROPOSE,
      compact({
        text: input.text,
        kind: input.kind,
        scope: input.scope,
        tags: input.tags,
        anchors: input.anchors,
        audience: input.audience,
        sources: input.sources,
        validity: input.validity,
        importance: input.importance,
        confidence: input.confidence,
        targetMemoryId: input.targetMemoryId,
        targetRevision: input.targetRevision,
        reviewReason: input.reviewReason,
        suggestedAction: input.suggestedAction,
        supersedesMemoryIds: input.supersedesMemoryIds,
        supersedesRevisions: input.supersedesRevisions,
      }),
      this.session(input.ownerSessionId),
    );
    return outcome.record;
  }

  async listCandidates(includeResolved = false): Promise<MemoryCandidate[]> {
    const statuses = includeResolved ? CANDIDATE_STATUSES : (['pending'] as const);
    const out: MemoryCandidate[] = [];
    for (const status of statuses) {
      const result = await this.scoped<{ candidates: MemoryCandidate[] }>(
        METHODS.CANDIDATE_LIST,
        { status, limit: DAEMON_MAX_PAGE },
        this.session(undefined),
      );
      out.push(...result.candidates);
    }
    return out;
  }

  async acceptCandidate(candidateId: string): Promise<Sage | undefined> {
    const outcome = await this.scoped<CandidateOutcome>(
      METHODS.CANDIDATE_ACCEPT,
      { id: candidateId },
      this.session(undefined),
    );
    if (!outcome.memoryId) return undefined;
    return (await this.getSage(outcome.memoryId)) ?? undefined;
  }

  async rejectCandidate(candidateId: string, reason: string): Promise<boolean> {
    const outcome = await this.scoped<CandidateOutcome>(
      METHODS.CANDIDATE_REJECT,
      { id: candidateId, reason },
      this.session(undefined),
    );
    return !outcome.alreadyResolved && outcome.status === 'rejected';
  }

  async resolveCandidate(
    candidateId: string,
    decision: CandidateDecision,
    reason?: string,
  ): Promise<MemoryCandidateResolution | undefined> {
    const outcome = await this.scoped<CandidateOutcome>(
      METHODS.CANDIDATE_RESOLVE,
      compact({ id: candidateId, decision, reason }),
      this.session(undefined),
    );
    return {
      candidateId: outcome.candidateId,
      decision: (outcome.decision as CandidateDecision | undefined) ?? decision,
      ...(outcome.targetMemoryId === undefined ? {} : { targetMemoryId: outcome.targetMemoryId }),
      applied: outcome.applied,
      alreadyResolved: outcome.alreadyResolved,
    };
  }

  /**
   * Approximation of the unified search service over `memory.search` /
   * `memory.forPath` / `memory.listPage`. Cursor paging, audience, anchor and
   * freshness filters have no daemon equivalent and are refused.
   */
  async unifiedSearchService(
    query: SearchQuery,
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    if (query.cursor !== undefined)
      throw new WrongMemoryNotImplementedError('unifiedSearch.cursor');
    if (
      query.audience !== undefined ||
      query.anchor !== undefined ||
      query.freshness !== undefined
    ) {
      throw new WrongMemoryNotImplementedError('unifiedSearch.filters');
    }
    const limit = Math.min(DAEMON_MAX_PAGE, Math.max(1, options.limit ?? 20));
    const session = this.session(options.sessionId);
    const text = query.text?.trim();
    let rows: Array<{ memory: Sage; reason: SearchHit['matchReason'] }>;
    if (text) {
      const r = await this.scoped<WireSearchResult>(
        METHODS.MEMORY_SEARCH,
        compact({ query: text, limit, kinds: query.kinds, statuses: options.includeStatuses }),
        session,
      );
      rows = r.hits.map((h) => ({ memory: h.memory as unknown as Sage, reason: 'lexical' }));
    } else if (query.paths && query.paths.length > 0) {
      rows = [];
      for (const p of query.paths) {
        const r = await this.scoped<WireSearchResult>(
          METHODS.MEMORY_FOR_PATH,
          { path: p, limit },
          session,
        );
        for (const h of r.hits)
          rows.push({ memory: h.memory as unknown as Sage, reason: `anchor:${p}` });
      }
    } else {
      const page = await this.scoped<WirePage>(
        METHODS.MEMORY_LIST_PAGE,
        compact({
          statuses: options.includeStatuses,
          kind: query.kinds?.length === 1 ? query.kinds[0] : undefined,
          limit,
        }),
        session,
      );
      rows = page.memories.map((memory) => ({ memory, reason: 'recency' as const }));
    }
    const seen = new Set<string>();
    const kinds = query.kinds ? new Set<string>(query.kinds) : undefined;
    const scopes = query.scopes ? new Set<string>(query.scopes) : undefined;
    const filtered = rows.filter(({ memory }) => {
      if (seen.has(memory.id)) return false;
      seen.add(memory.id);
      if (kinds && !kinds.has(memory.kind)) return false;
      if (scopes && !scopes.has(memory.scope)) return false;
      if (options.excludeSessionScoped && memory.scope === 'session') return false;
      if (query.importanceAtLeast !== undefined && memory.importance < query.importanceAtLeast) {
        return false;
      }
      return true;
    });
    const hits = filtered.slice(0, limit).map(({ memory, reason }, index, all) => ({
      id: memory.id,
      kind: memory.kind,
      scope: memory.scope,
      tags: memory.tags,
      anchors: memory.anchors,
      audience: memory.audience,
      text: memory.text,
      importance: memory.importance,
      confidence: memory.confidence,
      status: memory.status,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      verifiedAt: memory.lastVerifiedAt,
      score: rankScore(index, all.length),
      bm25: null,
      matchReason: reason,
    }));
    return {
      hits,
      suggestions: [],
      totalCandidates: filtered.length,
      rankingApplied: options.ranking ?? 'relevance',
      queryEcho: compact({ text: query.text, paths: query.paths, kinds: query.kinds }),
      nextCursor: null,
      matchChannel: text ? 'fts' : 'plain',
    };
  }

  private async runHygiene(
    options?: SageHygieneOptions & { dryRun?: boolean },
  ): Promise<SageHygieneReport> {
    const params = pick(options ?? {}, [...HYGIENE_KEYS, 'dryRun']);
    return this.scoped<SageHygieneReport>(METHODS.MEMORY_HYGIENE, params, this.session(undefined), {
      timeoutMs: SLOW_OP_TIMEOUT_MS,
    });
  }

  private notImplemented(operation: string): Promise<never> {
    return Promise.reject(new WrongMemoryNotImplementedError(operation));
  }

  // ─── Capabilities ──────────────────────────────────────────────────

  private readonly retrievalCapability: SageRetrievalCapability = {
    retrieveForPath: (options) => this.retrieveForPath(options),
    searchSage: (query, options) => this.searchSage(query, options),
    searchSageWithBreakdown: (query, options) => this.searchSageWithBreakdown(query, options),
    findRelatedSage: (memoryIds, options) => this.findRelatedSage(memoryIds, options),
    recordInjection: (memoryIds, trigger, sessionId) =>
      this.recordUsage(memoryIds, 'injection', trigger, sessionId),
    recordUse: (memoryIds, source, sessionId) =>
      this.recordUsage(memoryIds, 'use', source, sessionId),
    // Usage counters are durable on the daemon when `recordUsage` returns.
    flushPendingCounters: async () => {},
  };

  private readonly surfaceCapability: SageSurface = {
    stats: () => this.stats(),
    listSage: (statuses) => this.listSage(statuses),
    listSagePage: (options) => this.listSagePage(options),
    getSage: (id) => this.getSage(id),
    rememberSage: (input) => this.rememberSage(input),
    updateSage: (id, patch) => this.updateSage(id, patch),
    deleteSage: (id, reason, options) => this.deleteSage(id, reason, options),
    retrieveForPath: (options) => this.retrieveForPath(options),
    searchSageWithBreakdown: (query, options) => this.searchSageWithBreakdown(query, options),
    searchSage: (query, options) => this.searchSage(query, options),
    acceptCandidate: (candidateId) => this.acceptCandidate(candidateId),
    rejectCandidate: (candidateId, reason) => this.rejectCandidate(candidateId, reason),
    resolveCandidate: (candidateId, decision, reason) =>
      this.resolveCandidate(candidateId, decision, reason),
    retrieveForAudience: (context, limit, onTruncated, sessionId, includeAllSessions) =>
      this.retrieveForAudience(context, limit, onTruncated, sessionId, includeAllSessions),
    hygiene: (options) => this.runHygiene(options),
    listCandidates: (includeResolved) => this.listCandidates(includeResolved),
    createCandidate: (input) => this.createCandidate(input),
    graphFor: (query, maxDepth, limit) => this.graphFor(query, maxDepth, limit),
    recoverSage: (id, reason) => this.recoverSage(id, reason),
    backfillRecoverable: (options) => this.backfillRecoverable(options),
  };

  private readonly serviceCapability: SageServiceLike = {
    unifiedSearchService: (query, options) => this.unifiedSearchService(query, options),
    readAll: () => this.readAll(),
    read: (scope) => this.read(scope),
    remember: (text, scope, metadata) => this.remember(text, scope, metadata),
    forget: (query, scope) => this.forget(query, scope),
    consolidate: (scope) => this.consolidate(scope),
    clear: (scope) => this.clear(scope),
    list: (scope, limit) => this.list(scope, limit),
    search: (query, scope, limit) => this.search(query, scope, limit),
    getBackend: () => this.getBackend(),
    findRelated: (text, scope, limit) => this.findRelated(text, scope, limit),
    hygiene: (options) => this.runHygiene(options),
    withTraceId: (traceId) => {
      this.withTraceId(traceId);
      return this.serviceCapability;
    },
    retrieveForPath: (options) => this.retrieveForPath(options),
    searchSage: (query, options) => this.searchSage(query, options),
    searchSageWithBreakdown: (query, options) => this.searchSageWithBreakdown(query, options),
    graphFor: (query, maxDepth, limit) => this.graphFor(query, maxDepth, limit),
    verify: () => this.notImplemented('verify'),
    listCandidates: (includeResolved) => this.listCandidates(includeResolved),
    createCandidate: (input) => this.createCandidate(input),
    resolveCandidate: (candidateId, decision, reason) =>
      this.resolveCandidate(candidateId, decision, reason),
    acceptCandidate: (candidateId) => this.acceptCandidate(candidateId),
    rejectCandidate: (candidateId, reason) => this.rejectCandidate(candidateId, reason),
    rememberSage: (input) => this.rememberSage(input),
    updateSage: (id, patch) => this.updateSage(id, patch),
    deleteSage: (id, reason, options) => this.deleteSage(id, reason, options),
    recoverSage: (id, reason) => this.recoverSage(id, reason),
    backfillRecoverable: (options) => this.backfillRecoverable(options),
    findMemoriesForFile: () => this.notImplemented('findMemoriesForFile'),
    getSage: (id) => this.getSage(id),
    listSagePage: (options) => this.listSagePage(options),
  };

  // ─── Transport ─────────────────────────────────────────────────────

  private session(explicit: string | undefined): SessionChoice {
    return { sessionId: explicit ?? this.options.getSessionId?.() };
  }

  /**
   * Project-scoped call under the port lock: bind (or release) the session,
   * then send. A transport failure drops the connection and surfaces as
   * {@link WrongMemoryUnavailableError}.
   */
  private scoped<T>(
    method: string,
    params: unknown,
    session: SessionChoice,
    opts: CallOpts = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        const project = await this.ensureProject();
        const client = await this.ensureClient();
        await this.bindSession(client, session.sessionId);
        return await client.call<T>(method, params, { ...opts, projectId: project.projectId });
      } catch (error) {
        throw this.translate(error);
      }
    };
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private async bindSession(
    client: WrongMemoryClientLike,
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId === this.boundSession) return;
    if (sessionId === undefined) {
      await client.call(METHODS.SESSION_RELEASE, {});
    } else {
      await client.call(METHODS.SESSION_ACQUIRE, { hostSessionId: sessionId });
    }
    this.boundSession = sessionId;
  }

  private translate(error: unknown): unknown {
    if (error instanceof WrongMemoryUnavailableError) return error;
    if (isTransportFailure(error)) {
      this.dropClient();
      return new WrongMemoryUnavailableError((error as Error).message, { cause: error });
    }
    return error;
  }

  private dropClient(): void {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    this.boundSession = undefined;
    client?.close();
  }

  private async ensureClient(): Promise<WrongMemoryClientLike> {
    if (this.disposed) throw new WrongMemoryUnavailableError('port disposed');
    if (this.client) return this.client;
    this.connecting ??= (async () => {
      const connect = this.options.connect ?? ((o: ConnectOptions) => WrongMemoryClient.connect(o));
      // The vendored client's own `start` spawns with the inherited
      // environment; WrongStack starts the daemon itself through
      // buildChildEnv (VF-09) and only ever connects with `start: false`.
      const connectOptions = compact({
        dataRoot: this.options.dataRoot,
        start: false,
        clientName: this.options.clientName ?? 'wrongstack',
        timeoutMs: this.options.timeoutMs,
      }) as ConnectOptions;
      try {
        let client: WrongMemoryClientLike;
        try {
          client = await connect(connectOptions);
        } catch (error) {
          if (
            this.options.startPolicy === 'never' ||
            !(error instanceof WrongMemoryError) ||
            error.code !== 'UNAVAILABLE'
          ) {
            throw error;
          }
          client = await (this.options.startDaemon ?? startWrongMemoryDaemon)({
            dataRoot: this.options.dataRoot,
            daemonPath: this.options.daemonPath,
            connect: () => connect(connectOptions),
          });
        }
        this.client = client;
        this.boundSession = undefined;
        return client;
      } catch (error) {
        this.connecting = undefined;
        if (
          error instanceof WrongMemoryError &&
          (error.code === 'UNAVAILABLE' || error.code === 'TRANSPORT')
        ) {
          throw new WrongMemoryUnavailableError(error.message, { cause: error });
        }
        throw error;
      }
    })();
    return this.connecting;
  }

  private async ensureProject(): Promise<ProjectInfo> {
    if (this.project) return this.project;
    let client: WrongMemoryClientLike;
    try {
      client = await this.ensureClient();
    } catch (error) {
      throw this.translate(error);
    }
    try {
      this.project = await resolveWrongMemoryProject(client, {
        projectRoot: this.options.projectRoot,
        projectId: this.options.projectId,
        register: this.options.register !== false,
      });
    } catch (error) {
      throw this.translate(error);
    }
    return this.project;
  }
}

/**
 * Locate (or, with `register`, create) the WrongMemory project for a root.
 * An explicit `projectId` wins. A root that already holds a project-local
 * SAGE store is registered as `adopted` (the daemon refuses a second
 * authoritative `managed` store for it); otherwise `managed`.
 */
export async function resolveWrongMemoryProject(
  client: WrongMemoryClientLike,
  options: { projectRoot: string; projectId?: string | undefined; register: boolean },
): Promise<ProjectInfo> {
  if (options.projectId) {
    return client.call<ProjectInfo>(METHODS.PROJECT_GET, {}, { projectId: options.projectId });
  }
  const want = normalizeRoot(options.projectRoot);
  const { projects } = await client.call<{ projects: ProjectInfo[] }>(METHODS.PROJECT_LIST, {});
  const found = projects.find((p) => normalizeRoot(p.root) === want);
  if (found) return found;
  if (!options.register) throw new WrongMemoryProjectNotRegisteredError(options.projectRoot);
  const localStore = path.join(options.projectRoot, '.wrongstack', 'memories', 'sage.db');
  const storeKind = existsSync(localStore) ? 'adopted' : 'managed';
  const result = await client.call<{ project: ProjectInfo }>(METHODS.PROJECT_REGISTER, {
    root: options.projectRoot,
    storeKind,
    write: true,
  });
  return result.project;
}

/**
 * `auto` probe: a daemon is reachable (never started) AND the root is
 * already registered. Returns the project, or `undefined` for either miss.
 */
export async function probeWrongMemoryProject(options: {
  projectRoot: string;
  projectId?: string | undefined;
  dataRoot?: string | undefined;
  timeoutMs?: number | undefined;
  connect?: ((options: ConnectOptions) => Promise<WrongMemoryClientLike>) | undefined;
}): Promise<ProjectInfo | undefined> {
  const connect = options.connect ?? ((o: ConnectOptions) => WrongMemoryClient.connect(o));
  let client: WrongMemoryClientLike;
  try {
    client = await connect(
      compact({
        dataRoot: options.dataRoot,
        start: false,
        clientName: 'wrongstack-probe',
        timeoutMs: options.timeoutMs ?? 1_500,
      }) as ConnectOptions,
    );
  } catch {
    return undefined;
  }
  try {
    return await resolveWrongMemoryProject(client, {
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      register: false,
    });
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

export interface StartDaemonOptions {
  dataRoot?: string | undefined;
  daemonPath?: string | undefined;
  /** Attach attempt (never starts). */
  connect: () => Promise<WrongMemoryClientLike>;
  readyTimeoutMs?: number | undefined;
}

/**
 * Spawn `wrongmemoryd --data-root <root>` detached with a sanitized
 * environment ({@link buildChildEnv}: no provider keys or vault passphrase)
 * and wait until it accepts a connection.
 */
export async function startWrongMemoryDaemon(
  options: StartDaemonOptions,
): Promise<WrongMemoryClientLike> {
  const exe =
    options.daemonPath ??
    path.join(
      path.dirname(process.execPath),
      process.platform === 'win32' ? 'wrongmemoryd.exe' : 'wrongmemoryd',
    );
  if (!existsSync(exe)) {
    throw new WrongMemoryError('UNAVAILABLE', `daemon executable not found: ${exe}`);
  }
  const child = spawn(exe, ['--data-root', resolveDataRoot(options.dataRoot)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: buildChildEnv(),
  });
  child.unref();
  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await options.connect();
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new WrongMemoryError(
    'UNAVAILABLE',
    `daemon did not become ready: ${last instanceof Error ? last.message : String(last)}`,
  );
}
