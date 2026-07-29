import type { MemoryStore } from '@wrongstack/core/types';
import type {
  CandidateDecision,
  CreateCandidateInput,
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
  freshness?: {
    verifiedAfter?: string | undefined;
    createdAfter?: string | undefined;
  } | undefined;
  audience?: MemoryAudienceSelector | undefined;
  anchor?: MemoryAnchor | undefined;
  cursor?: {
    memoryId: string;
    direction: 'before' | 'after';
  } | undefined;
}

export interface SearchOptions {
  limit?: number | undefined;
  includeStatuses?: SageStatus[] | undefined;
  ranking?: SearchRanking | undefined;
  suggest?: SearchSuggestionMode | undefined;
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
  searchSage(
    query: string,
    options?: { limit?: number; includeStatuses?: SageStatus[] },
  ): Promise<Sage[]>;
  acceptCandidate(candidateId: string): Promise<Sage | undefined>;
  rejectCandidate(candidateId: string, reason: string): Promise<boolean>;
  retrieveForAudience(
    context: { role?: string; taskType?: string; mode?: string },
    limit?: number,
  ): Promise<Sage[]>;
  hygiene(options?: SageHygieneOptions): Promise<SageHygieneReport>;
  listCandidates(includeResolved?: boolean): Promise<MemoryCandidate[]>;
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
  }): Promise<Sage[]>;
  searchSage(
    query: string,
    opts?: { limit?: number; includeStatuses?: Sage['status'][] },
  ): Promise<Sage[]>;
  retrieveForAudience?(
    context: { role?: string; taskType?: string; mode?: string },
    limit?: number,
  ): Promise<Sage[]>;
  graphFor(query: string, maxDepth?: number, limit?: number): Promise<MemoryGraphEdge[]>;
  verify(memoryId?: string, signal?: AbortSignal): Promise<MemoryVerificationResult[]>;
  hygiene(
    options?: SageHygieneOptions,
    signal?: AbortSignal,
  ): Promise<SageHygieneReport>;
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

