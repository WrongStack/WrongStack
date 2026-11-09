/**
 * SAGE memory operations for the WrongMemory port: every SAGE-scoped daemon
 * call (search, mutations, candidates, hygiene, maintenance, HQ sync, audit)
 * plus the three capability objects.
 */
import {
  isWrongMemoryError,
  METHODS,
  type SearchResult as WireSearchResult,
} from '@wrongstack/wrongmemory-client';
import { legacyToSageScope, legacyTypeToKind } from './legacy-memory-conversion.js';
import type {
  SageDoctorOptions,
  SageDoctorReport,
  SageMaintenanceStatus,
} from './memory-doctor-types.js';
import {
  augmentLexicalWithVectorRecall,
  type VectorAugmentHit,
} from './retrieval/vector-augment.js';
import { isSageVisibleForSearch } from './retrieval/visibility.js';
import {
  InvalidSearchCursorError,
  type SearchOptions,
  type SearchQuery,
  type SearchResult,
} from './service-contract.js';
import { DEFAULT_PAGE_STATUSES, VALID_MEMORY_STATUSES } from './shared/pagination.js';
import { consolidateSession as sharedConsolidateSession } from './shared/session-consolidation.js';
import { importanceFromPriority } from './sqlite-store-legacy.js';
import { canonicalMemoryText } from './store-helpers.js';
import type {
  CandidateDecision,
  CreateCandidateInput,
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  LegacyImportResult,
  ListSagePageOptions,
  ListSagePageResult,
  MemoryCandidate,
  MemoryCandidateResolution,
  MemoryGraphEdge,
  MemoryVerificationResult,
  RememberSageInput,
  Sage,
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
import {
  CANDIDATE_STATUSES,
  DAEMON_MAX_PAGE,
  HYGIENE_KEYS,
  SLOW_OP_TIMEOUT_MS,
  UPDATE_KEYS,
} from './wrongmemory-errors.js';
import { WrongMemorySageSync } from './wrongmemory-sage-sync.js';
import {
  type CandidateOutcome,
  compact,
  filterStatuses,
  type MutationOutcome,
  ownsFusion,
  pick,
  rankScore,
  toMaintenanceStatus,
  type WireGraphView,
  type WireMaintenanceStatus,
  type WirePage,
  type WireStats,
} from './wrongmemory-wire.js';

export abstract class WrongMemorySageOps extends WrongMemorySageSync {
  async searchSage(query: string, options: SageSearchOptions = {}): Promise<Sage[]> {
    const lexical = await this.lexicalSearch(query, options);
    if (!ownsFusion(options)) return lexical;
    return (await this.fuse(query, lexical, options)).map((hit) => hit.memory);
  }

  /** The daemon's lexical channel under the caller's session. */
  private async lexicalSearch(query: string, options: SageSearchOptions): Promise<Sage[]> {
    const result = await this.scoped<WireSearchResult>(
      METHODS.MEMORY_SEARCH,
      compact({ query, limit: options.limit, statuses: options.includeStatuses }),
      this.session(options.sessionId),
    );
    return result.hits.map((hit) => hit.memory as unknown as Sage);
  }

  /**
   * Store-side fusion, as the in-process store does when the caller passes
   * `vectorRecall` (`searchSqliteSageWithRecall`): one RRF over the daemon's
   * lexical channel and the caller's vector channel. A vector-only id is
   * resolved through the daemon under the caller's session (hidden and
   * absent rows both come back as absent) and then must pass the lexical
   * channel's visibility rules, so a stale or foreign semantic id never
   * surfaces. Host-level wrappers skip their own fusion when the caller
   * owns it, so nothing is fused twice.
   */
  private fuse(
    query: string,
    lexical: readonly Sage[],
    options: SageSearchOptions,
  ): Promise<VectorAugmentHit[]> {
    return augmentLexicalWithVectorRecall(query, lexical, {
      vectorRecall: options.vectorRecall,
      vectorCandidateLimit: options.vectorCandidateLimit,
      materializeVectorOnly: async (id) => {
        const memory = await this.getSage(id, options.sessionId);
        return memory && isSageVisibleForSearch(memory, options) ? memory : undefined;
      },
      ...(options.vectorRecallWeight !== undefined
        ? { vectorWeight: options.vectorRecallWeight }
        : {}),
      ...(options.vectorRecallMinScore !== undefined
        ? { threshold: options.vectorRecallMinScore }
        : {}),
      ...(options.vectorRecallThreshold !== undefined
        ? { vectorOnlyThreshold: options.vectorRecallThreshold }
        : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  async searchSageWithBreakdown(
    query: string,
    options: SageSearchOptions = {},
  ): Promise<VectorAugmentHit[]> {
    const rows = await this.lexicalSearch(query, options);
    if (ownsFusion(options)) return this.fuse(query, rows, options);
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
    const m = outcome.record;
    if (!outcome.replayed) {
      // A merge returns the existing record at a bumped revision; a new
      // memory starts at revision 1.
      if ((m.revision ?? 1) > 1) {
        this.emit('memory.merged', { memoryId: m.id, mergedIds: [] }, input.ownerSessionId);
      } else {
        this.emit(
          'memory.accepted',
          {
            memoryId: m.id,
            kind: m.kind,
            persistence: m.persistence ?? 'durable',
            confidence: m.confidence,
            freshness: m.freshness,
          },
          input.ownerSessionId,
        );
      }
    }
    return m;
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
    this.emitUpdated(record);
    return record;
  }

  async deleteSage(
    id: string,
    reason?: string,
    options?: { force?: boolean; neverInject?: boolean },
  ): Promise<void> {
    const outcome = await this.scoped<MutationOutcome<Sage>>(
      METHODS.MEMORY_DELETE,
      compact({ id, reason, force: options?.force, neverInject: options?.neverInject }),
      this.session(undefined),
    );
    const contextPolicy = options?.neverInject === true ? 'never' : 'eligible';
    this.emit('memory.deleted', {
      memoryId: id,
      reason: reason ?? 'deleted',
      persistence: outcome?.record?.persistence ?? 'durable',
      contextPolicy,
    });
    this.emit('memory.updated', { memoryId: id, status: 'deleted', contextPolicy });
  }

  async recoverSage(id: string, reason?: string): Promise<Sage> {
    const recovered = await this.scoped<Sage>(
      METHODS.MEMORY_RECOVER,
      compact({ id, reason }),
      this.session(undefined),
    );
    this.emit('memory.recovered', { memoryId: recovered.id, ...(reason ? { reason } : {}) });
    return recovered;
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

  /**
   * `memory.forFile`: the daemon resolves the path against the project root
   * (symlink escapes rejected) and applies the session rule to memories,
   * supersession heads and review hints.
   */
  async findMemoriesForFile(
    filePath: string,
    options: FindMemoriesForFileOptions = {},
  ): Promise<FindMemoriesForFileResponse> {
    return this.scoped<FindMemoriesForFileResponse>(
      METHODS.MEMORY_FOR_FILE,
      compact({
        path: filePath,
        lineStart: options.lineStart,
        lineEnd: options.lineEnd,
        includeSuperseded: options.includeSuperseded,
        includeDeleted: options.includeDeleted,
        limit: options.limit,
      }),
      this.session(options.sessionId),
    );
  }

  /**
   * `memory.verify`: anchors are checked by the daemon against the project
   * tree (nothing is executed) and active/stale is reconciled. Curator
   * action; rows of other sessions are neither verified nor reported.
   */
  async verify(memoryId?: string, signal?: AbortSignal): Promise<MemoryVerificationResult[]> {
    signal?.throwIfAborted();
    const result = await this.scoped<{ results: MemoryVerificationResult[] }>(
      METHODS.MEMORY_VERIFY,
      compact({ id: memoryId }),
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    return result.results;
  }

  /** `memory.verify` for the memories anchored to `paths` only. */
  async verifyForPaths(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemoryVerificationResult[]> {
    signal?.throwIfAborted();
    if (paths.length === 0) return [];
    const result = await this.scoped<{ results: MemoryVerificationResult[] }>(
      METHODS.MEMORY_VERIFY,
      { paths: [...paths] },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    return result.results;
  }

  /**
   * `memory.importLegacy`: the daemon reads the named legacy Markdown notes
   * (relative to the project root, or absolute inside it) and imports their
   * bullet lines as project memories. Curator action. Only regular
   * `.md`/`.markdown` files outside `.wrongstack/` and `.git/` are read.
   */
  async importLegacyFiles(files: string[]): Promise<LegacyImportResult> {
    if (files.length === 0) return { imported: 0, skipped: 0, files: 0 };
    return this.scoped<LegacyImportResult>(
      METHODS.MEMORY_IMPORT_LEGACY,
      { files: [...files] },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
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
      ...(outcome.error === undefined
        ? { alreadyResolved: outcome.alreadyResolved }
        : { error: outcome.error }),
    };
  }

  /**
   * `memory.unifiedSearch`: the daemon runs the baseline unified search
   * (filters, audience/anchor post-filters, rankings, scores, suggestions,
   * keyset cursors). The session comes from the bound connection; the
   * caller's `includeAllSessions` cannot be honored and is not sent. An
   * invalid or foreign cursor surfaces as {@link InvalidSearchCursorError}.
   */
  async unifiedSearchService(
    query: SearchQuery,
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    const { sessionId, includeAllSessions: _ignored, ...rest } = options;
    try {
      return await this.scoped<SearchResult>(
        METHODS.MEMORY_UNIFIED_SEARCH,
        { query, options: rest },
        this.session(sessionId),
      );
    } catch (error) {
      if (isWrongMemoryError(error, 'INVALID_REQUEST') && /search cursor/i.test(error.message)) {
        throw new InvalidSearchCursorError(error.message);
      }
      throw error;
    }
  }

  async runHygiene(
    options?: SageHygieneOptions & { dryRun?: boolean },
  ): Promise<SageHygieneReport> {
    const params = pick(options ?? {}, [...HYGIENE_KEYS, 'dryRun']);
    return this.scoped<SageHygieneReport>(METHODS.MEMORY_HYGIENE, params, this.session(undefined), {
      timeoutMs: SLOW_OP_TIMEOUT_MS,
    });
  }

  /**
   * Daemon-owned maintenance. `schedule` hands the host's hygiene options to
   * the daemon's durable scheduler (`maintenance.configure`, curator action),
   * which keeps running hygiene on its own cadence after this host exits; the
   * daemon is the only scheduler, so nothing is scheduled in-process.
   * `status` maps `maintenance.status` onto the SAGE shape.
   */
  async maintenance(
    action: 'schedule' | 'status',
    options?: SageHygieneOptions,
  ): Promise<SageMaintenanceStatus> {
    if (action === 'schedule') {
      await this.scoped(
        METHODS.MAINTENANCE_CONFIGURE,
        { options: pick(options ?? {}, [...HYGIENE_KEYS]), enabled: true },
        this.session(undefined),
      );
    }
    const wire = await this.scoped<WireMaintenanceStatus>(
      METHODS.MAINTENANCE_STATUS,
      {},
      this.session(undefined),
    );
    return toMaintenanceStatus(wire);
  }

  /**
   * `memory.doctor` (host-only on the daemon): the SAGE doctor report and
   * its named repairs, plus the daemon scheduler's maintenance status, as
   * the baseline project server reports it.
   */
  async doctor(options?: SageDoctorOptions): Promise<SageDoctorReport> {
    const report = await this.scoped<SageDoctorReport>(
      METHODS.MEMORY_DOCTOR,
      compact({
        fix: options?.fix ? [...options.fix] : undefined,
        hygieneOptions: options?.hygieneOptions
          ? pick(options.hygieneOptions, [...HYGIENE_KEYS])
          : undefined,
      }),
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    return { ...report, maintenance: await this.maintenance('status') };
  }

  /**
   * `consolidateSession` (project-server op): session facts become review
   * candidates, auto-accepted above the policy threshold, skipping texts
   * already known as active/stale project memories or project candidates.
   * The baseline's shared loop over this port's candidate operations.
   */
  async consolidateSession(input: SessionConsolidationInput): Promise<SessionConsolidationResult> {
    const dedup = new Set<string>();
    for (const m of await this.listSage(['active', 'stale'])) {
      if (m.scope === 'project') dedup.add(canonicalMemoryText(m.text));
    }
    for (const c of await this.listCandidates()) {
      if (c.scope === 'project') dedup.add(canonicalMemoryText(c.text));
    }
    return sharedConsolidateSession(
      {
        createCandidate: (candidate) => this.createCandidate(candidate),
        acceptCandidate: (id) => this.acceptCandidate(id),
      },
      dedup,
      input,
    );
  }
}
