import type { MemoryStore } from '@wrongstack/core/types';
import type {
  CandidateDecision,
  CreateCandidateInput,
  SageSearchOptions,
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  LegacyImportResult,
  ListSagePageOptions,
  ListSagePageResult,
  MemoryAnchor,
  MemoryAudienceSelector,
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
  SageKind,
  SageScope,
  SageStats,
  SageStatus,
  UpdateSageInput,
} from './types.js';

export type SearchRanking = 'relevance' | 'recency' | 'importance' | 'hybrid';
export type SearchSuggestionMode = 'never' | 'empty' | 'always';
export type SearchMatchReason =
  | 'lexical'
  | 'tag'
  | 'recency'
  | `anchor:${string}`
  | `graph:${string}`
  | `audience:${string}`
  | `kind:${SageKind}`;

export interface SearchQuery {
  text?: string | undefined;
  paths?: string[] | undefined;
  kinds?: SageKind[] | undefined;
  scopes?: SageScope[] | undefined;
  importanceAtLeast?: number | undefined;
  freshness?:
    | {
        verifiedAfter?: string | undefined;
        createdAfter?: string | undefined;
      }
    | undefined;
  audience?: MemoryAudienceSelector | undefined;
  anchor?: MemoryAnchor | undefined;
  cursor?:
    | {
        memoryId: string;
        direction: 'before' | 'after';
      }
    | undefined;
}

export interface SearchOptions {
  limit?: number | undefined;
  includeStatuses?: SageStatus[] | undefined;
  ranking?: SearchRanking | undefined;
  suggest?: SearchSuggestionMode | undefined;
  /**
   * Session ownership filter. When set, only session-scoped memories owned
   * by this session (plus all non-session memories) are returned. When
   * unset (and `includeAllSessions` is not true), owned session-scoped
   * memories are hidden — only unowned session memories remain visible,
   * so pass `sessionId` to see your own session's records.
   */
  sessionId?: string | undefined;
  /** Admin opt-out: include all sessions' session-scoped memories. */
  includeAllSessions?: boolean | undefined;
}

export interface SearchHit {
  id: string;
  kind: SageKind;
  scope: SageScope;
  tags: string[];
  anchors?: MemoryAnchor[] | undefined;
  audience?: MemoryAudienceSelector | undefined;
  text: string;
  importance: number;
  confidence: number;
  status: SageStatus;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string | undefined;
  score: number;
  matchReason: SearchMatchReason;
}

export interface SearchResult {
  hits: SearchHit[];
  suggestions: SearchHit[];
  totalCandidates: number;
  rankingApplied: SearchRanking;
  queryEcho: Partial<SearchQuery>;
}

/** Capability used by CLI/TUI/WebUI presentation adapters. */
export interface SageSurface {
  stats(): Promise<SageStats>;
  listSage(statuses?: SageStatus[]): Promise<Sage[]>;
  listSagePage(options?: ListSagePageOptions): Promise<ListSagePageResult>;
  getSage(id: string): Promise<Sage | null>;
  rememberSage(input: RememberSageInput): Promise<Sage>;
  updateSage(id: string, patch: UpdateSageInput): Promise<Sage>;
  deleteSage(
    id: string,
    reason?: string,
    options?: { force?: boolean; neverInject?: boolean },
  ): Promise<void>;
  retrieveForPath(options: SageForPathOptions): Promise<Sage[]>;
  /**
   * Rich variant of `searchSage` that returns the augmented hits with
   * per-channel scores. Consumers that only need the SAGE list use
   * `searchSage`; the WebUI / explainer tools / diagnostics use this.
   */
  searchSageWithBreakdown(
    query: string,
    options?: SageSearchOptions,
  ): Promise<import('./retrieval/vector-augment.js').VectorAugmentHit[]>;
  searchSage(
    query: string,
    options?: {
      limit?: number;
      includeStatuses?: SageStatus[];
      /**
       * Session ownership filter, consistent with `retrieveForAudience` below and
       * with every SQL retrieval surface: pass the calling session to see its own
       * session-scoped memories. Omitting it hides owned session records rather
       * than exposing them, so a forgetful caller under-reports instead of
       * crossing a session boundary.
       */
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<Sage[]>;
  acceptCandidate(candidateId: string): Promise<Sage | undefined>;
  rejectCandidate(candidateId: string, reason: string): Promise<boolean>;
  retrieveForAudience(
    context: { role?: string; taskType?: string; mode?: string },
    limit?: number,
    /**
     * Optional truncation callback. Fires when the SQL prefilter was
     * saturated — the scan window hit `AUDIENCE_MAX_SCAN` before the corpus
     * ran out and more matching rows likely exist beyond it. When omitted,
     * the store still emits an internal `memory.audience_truncated` audit
     * event so downstream observers (e.g. CLI hygiene teardown) can pick it
     * up without having to thread a callback through every call site.
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
  ): Promise<Sage[]>;
  hygiene(options?: SageHygieneOptions): Promise<SageHygieneReport>;
  listCandidates(includeResolved?: boolean): Promise<MemoryCandidate[]>;
  createCandidate(input: CreateCandidateInput): Promise<MemoryCandidate>;
  graphFor?(query: string, maxDepth?: number, limit?: number): Promise<MemoryGraphEdge[]>;
  verify?(memoryId?: string, signal?: AbortSignal): Promise<MemoryVerificationResult[]>;
  recoverSage?(id: string, reason?: string): Promise<Sage>;
  backfillRecoverable?(options?: SageBackfillOptions): Promise<SageBackfillReport>;
  findMemoriesForFile?(
    filePath: string,
    options?: FindMemoriesForFileOptions,
  ): Promise<FindMemoriesForFileResponse>;
  readAudit?(limit?: number): Promise<import('./types.js').SageAuditRecord[]>;
  importLegacy?(files: string[]): Promise<LegacyImportResult>;
  compactLog?(): Promise<{ beforeRecords: number; afterRecords: number; uniqueIds: number }>;
  getLogStats?(): Promise<{
    rawRecords: number;
    uniqueIds: number;
    duplicateRatio: number;
    fileSizeBytes: number;
  }>;
}

/** Capabilities required by the complete SAGE tool surface. */
export interface SageServiceLike extends MemoryStore {
  unifiedSearchService(query: SearchQuery, options?: SearchOptions): Promise<SearchResult>;
  retrieveForPath(opts: {
    path: string;
    limit?: number;
    includeAncestors?: boolean;
    includeStatuses?: Sage['status'][];
    sessionId?: string | undefined;
    includeAllSessions?: boolean | undefined;
  }): Promise<Sage[]>;
  searchSage(
    query: string,
    opts?: {
      limit?: number;
      includeStatuses?: Sage['status'][];
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<Sage[]>;
  /**
   * Rich search that returns per-channel scores. Optional on
   * retrieval-style ports — the explainer tools / WebUI breakdown view
   * reads this when present and falls back to plain `searchSage` when
   * not.
   */
  searchSageWithBreakdown?(
    query: string,
    opts?: {
      limit?: number;
      includeStatuses?: Sage['status'][];
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    },
  ): Promise<import('./retrieval/vector-augment.js').VectorAugmentHit[]>;
  retrieveForAudience?(
    context: { role?: string; taskType?: string; mode?: string },
    limit?: number,
    /**
     * Optional truncation callback. Fires when the SQL prefilter was
     * saturated — the scan window hit `AUDIENCE_MAX_SCAN` before the corpus
     * ran out and more matching rows likely exist beyond it. When omitted,
     * the store still emits an internal `memory.audience_truncated` audit
     * event so downstream observers (e.g. CLI hygiene teardown) can pick it
     * up without having to thread a callback through every call site.
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
  ): Promise<Sage[]>;
  graphFor(query: string, maxDepth?: number, limit?: number): Promise<MemoryGraphEdge[]>;
  verify(memoryId?: string, signal?: AbortSignal): Promise<MemoryVerificationResult[]>;
  hygiene(options?: SageHygieneOptions, signal?: AbortSignal): Promise<SageHygieneReport>;
  listCandidates(includeResolved?: boolean): Promise<MemoryCandidate[]>;
  createCandidate(input: CreateCandidateInput): Promise<MemoryCandidate>;
  resolveCandidate(
    candidateId: string,
    decision: CandidateDecision,
    reason?: string,
  ): Promise<MemoryCandidateResolution | undefined>;
  acceptCandidate(candidateId: string): Promise<Sage | undefined>;
  rejectCandidate(candidateId: string, reason: string): Promise<boolean>;
  rememberSage(input: RememberSageInput): Promise<Sage>;
  updateSage(id: string, patch: UpdateSageInput): Promise<Sage>;
  deleteSage(
    id: string,
    reason?: string,
    options?: { force?: boolean; neverInject?: boolean },
  ): Promise<void>;
  recoverSage(id: string, reason?: string): Promise<Sage>;
  backfillRecoverable(options?: SageBackfillOptions): Promise<SageBackfillReport>;
  findMemoriesForFile(
    filePath: string,
    options?: FindMemoriesForFileOptions,
  ): Promise<FindMemoriesForFileResponse>;
  getSage(id: string): Promise<Sage | null>;
  /** Enumerate a bounded page of memories, with optional status/kind/query filtering. */
  listSagePage(options?: ListSagePageOptions): Promise<ListSagePageResult>;
}
