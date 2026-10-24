import type { EventBus } from '@wrongstack/contracts/kernel';
import type { MemoryPriority, MemoryScope, MemoryType } from '@wrongstack/contracts/types';
import type {
  MemoryAnchor,
  MemoryAudienceContext,
  MemoryAudienceSelector,
  MemorySourceRef,
  PersistenceClass,
  Sage,
  SageKind,
  SageScope,
  SageStatus,
} from './memory-model.js';

export const SAGE_SCHEMA_VERSION = 1;

export const DEFAULT_PERSISTENCE: PersistenceClass = 'long_lived';
export const VALID_PERSISTENCE: ReadonlySet<PersistenceClass> = new Set([
  'permanent',
  'long_lived',
  'short_lived',
]);

export type MemoryGraphRelation =
  | 'about_file'
  | 'about_directory'
  | 'about_symbol'
  | 'about_package'
  | 'about_command'
  | 'about_agent'
  | 'derived_from'
  | 'validated_by'
  | 'invalidated_by'
  | 'supersedes'
  | 'contradicts'
  | 'related_to'
  | 'same_topic';

export interface MemoryGraphEdge {
  schemaVersion: 1;
  id: string;
  from: string;
  to: string;
  relation: MemoryGraphRelation;
  weight: number;
  /** Human-readable structural evidence for why this edge exists. */
  evidence?: string[] | undefined;
  createdAt: string;
  deletedAt?: string | undefined;
}

/**
 * Filter for `backfillRecoverable`. Restricts which `status='deleted'` records
 * are eligible for new-active-version creation. Empty fields mean "no filter".
 */
export interface SageBackfillFilter {
  /** Restrict recovery to an explicitly reviewed set of tombstone ids. */
  ids?: string[] | undefined;
  kinds?: SageKind[] | undefined;
  scopes?: SageScope[] | undefined;
  /** Only consider records with `updatedAt >= this`. ISO-8601 string. */
  updatedAfter?: string | undefined;
  /** Only consider records with `updatedAt <= this`. ISO-8601 string. */
  updatedBefore?: string | undefined;
  /** Skip records whose `text` is empty or whitespace-only. Default true. */
  requireText?: boolean | undefined;
  /** Skip records with no `sources` and no `anchors`. Default true. */
  requireProvenance?: boolean | undefined;
}

export interface SageBackfillOptions {
  filter?: SageBackfillFilter | undefined;
  /** Default true: report only, no writes. Pass `dryRun: false` to apply. */
  dryRun?: boolean | undefined;
}

export interface SageBackfillRecord {
  /** Original `status='deleted'` memory id. */
  originalId: string;
  /** New active version id (only populated when `dryRun=false`). */
  newActiveId?: string | undefined;
  /** Short reason the record is recoverable / or skipped. */
  reason: string;
  kind: SageKind;
  scope: SageScope;
  /** Truncated text preview for display. */
  textPreview: string;
  /** Original `updatedAt` (when it was deleted). */
  deletedAt: string;
  /** Detected persistence class at deletion time. */
  persistence: PersistenceClass;
}

export interface SageBackfillReport {
  startedAt: string;
  completedAt: string;
  dryRun: boolean;
  examined: number;
  /** Subset of `examined` that pass the recoverability filter. */
  recoverable: number;
  /** Count of records that were actually restored to a new active version. */
  recovered: number;
  skipped: number;
  /** Records that did NOT pass the filter, with a reason. */
  skippedRecords: SageBackfillRecord[];
  /** Records that DO pass the filter. When `dryRun=true` these are preview-only;
   *  when `dryRun=false` they have `newActiveId` populated. */
  recoverableRecords: SageBackfillRecord[];
  byKind: Partial<Record<SageKind, number>>;
  byReason: Record<string, number>;
}

export interface LegacyImportResult {
  imported: number;
  skipped: number;
  files: number;
}

type MemoryCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'merged';

export interface MemoryCandidate {
  validity?: import('./memory-model.js').MemoryValidity | undefined;
  schemaVersion: 1;
  id: string;
  status: MemoryCandidateStatus;
  text: string;
  kind: SageKind;
  scope: SageScope;
  confidence: number;
  importance: number;
  tags: string[];
  anchors: MemoryAnchor[];
  audience?: MemoryAudienceSelector | undefined;
  sources: MemorySourceRef[];
  createdAt: string;
  updatedAt: string;
  memoryId?: string | undefined;
  reason?: string | undefined;
  /** First-class linkage to the memory this proposal reviews (proposal metadata — never overwritten by resolution). */
  targetMemoryId?: string | undefined;
  /** When set, destructive review resolution must still target this revision. */
  targetRevision?: number | undefined;
  /** Why the review was proposed (proposal metadata — never overwritten by resolution). */
  reviewReason?: string | undefined;
  /** Advisory suggested action (typed successor of the legacy `suggested:` tag prefix). */
  suggestedAction?: CandidateSuggestedAction | undefined;
}

export interface SessionConsolidationInput {
  sessionId: string;
  facts: Array<{
    text: string;
    kind?: SageKind | undefined;
    confidence?: number | undefined;
    importance?: number | undefined;
    tags?: string[] | undefined;
    anchors?: MemoryAnchor[] | undefined;
  }>;
  autoAcceptThreshold?: number | undefined;
}

export interface SessionConsolidationResult {
  candidates: number;
  accepted: number;
  rejected: number;
  duplicate: number;
}

type SageOp = 'create' | 'update' | 'delete';

export interface SageRecord {
  recordType: 'memory';
  schemaVersion: 1;
  op: SageOp;
  memory: Sage;
}

export interface SageAuditRecord {
  schemaVersion: 1;
  event: string;
  memoryId?: string | undefined;
  source?: string | undefined;
  reason?: string | undefined;
  at: string;
  traceId?: string | undefined;
  details?: unknown;
}

export interface SageManifest {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  lastSnapshotId?: string | undefined;
  indexes?:
    | {
        version: 1;
        builtAt: string;
      }
    | undefined;
}

export interface SageSnapshot {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  memories: Sage[];
}

export interface SageIndexes {
  byPath: Record<string, string[]>;
  bySymbol: Record<string, string[]>;
  byTag: Record<string, string[]>;
  byKind: Record<string, string[]>;
  lexical: Record<string, string[]>;
}

export interface SagePaths {
  rootDir: string;
  manifest: string;
  memoriesLog: string;
  candidatesLog: string;
  auditLog: string;
  graphDir: string;
  edgesLog: string;
  indexesDir: string;
  snapshotsDir: string;
  hygieneDir: string;
  tmpDir: string;
  locksDir: string;
}

export interface SageStoreOptions {
  projectRoot: string;
  directory?: string | undefined;
  traceId?: string | undefined;
  events?: EventBus | undefined;
  now?: (() => Date) | undefined;
  /** Request-scoped server correlation; avoids cross-client mutable trace state. */
  operationContext?:
    | (() => { traceId?: string | undefined; sessionId?: string | undefined } | undefined)
    | undefined;
  /**
   * Minimum interval between persisted feedback-counter flushes
   * (injection/use counters). Must be finite and non-negative; `0` flushes
   * every update. Default: 3600000 (1 hour). Lower values reduce staleness
   * but increase disk writes on every store instance.
   */
  counterFlushIntervalMs?: number | undefined;
}

/**
 * Options for a paginated, status-filtered SAGE listing.
 *
 * Cursor-based: `cursor` is an opaque token derived from the last item of the
 * previous page (encodes `updatedAt` + `id` so ties are broken deterministically).
 * Ordering is always `updatedAt DESC, id DESC` so a stable cursor walk is possible.
 *
 * `statuses` defaults to every status EXCEPT `deleted` — deleted memories are a
 * soft-delete audit trail and would otherwise dominate the list. To view them,
 * pass `statuses: ['deleted']` explicitly (the "Deleted" page in the WebUI).
 */
export interface ListSagePageOptions {
  /** Which statuses to include. Default: all except `deleted`. */
  statuses?: SageStatus[] | undefined;
  /** Optional kind filter (e.g. 'fact'). Omit or 'all' for every kind. */
  kind?: string | undefined;
  /** Case-insensitive substring match against memory text. */
  query?: string | undefined;
  /** Max items to return. Clamped to [1, 500]. Default: 50. */
  limit?: number | undefined;
  /** Opaque cursor from a previous page's `nextCursor`. Omit for the first page. */
  cursor?: string | undefined;
  /**
   * Session ownership filter, matching every other retrieval surface. Unset
   * hides owned session records rather than listing them, so an enumerator
   * that forgets it under-reports instead of paging through another session's
   * private memories.
   */
  sessionId?: string | undefined;
  /** Admin opt-out: list every session's session-scoped memories. */
  includeAllSessions?: boolean | undefined;
}

/** A single page of SAGE results plus paging metadata. */
export interface ListSagePageResult {
  /** The page of memories (already filtered + sorted `updatedAt DESC, id DESC`). */
  memories: Sage[];
  /** Opaque cursor to fetch the next page, or `null` when this is the last page. */
  nextCursor: string | null;
  /** Total number of memories matching the filter (across all pages). */
  total: number;
  /**
   * Count of ALL memories per status, ignoring the `statuses`/`query`/`kind`
   * filters. Lets the UI render tab badges (e.g. "Deleted (1234)") without a
   * second round-trip. Keys are `SageStatus` values.
   */
  statusCounts: Record<string, number>;
}

/** Result from memory_gather_batch: memories plus their graph relations. */
export interface GatherBatchResult {
  /** The page of memories matching the filter. */
  memories: Sage[];
  /** Graph edges among and to related memories in the batch.
   *  Scanned for the first N memories (see `relationsScannedAt`); beyond
   *  that cap, relations are not collected. Use `memory_graph` on specific
   *  IDs for deeper traversal. */
  relations: MemoryGraphEdge[];
  /** How many memories were scanned for graph relations. 0 when
   * `includeRelations` is false. The cap is a resource guard — a
   * large batch (>10) only scans the first batch for relations, so
   * `relationsScannedAt < memories.length` means un-scanned memories
   * may have edge data not included here. */
  relationsScannedAt: number;
  /** Opaque cursor to fetch the next page, or `null` for the last page. */
  nextCursor: string | null;
  /** Total memories matching the filter (across all pages). */
  total: number;
  /** Counts of ALL memories per status (ignoring the filter). */
  statusCounts: Record<string, number>;
}

export interface RememberSageInput {
  text: string;
  validity?: import('./memory-model.js').MemoryValidity | undefined;
  scope?: SageScope | undefined;
  legacyScope?: MemoryScope | undefined;
  /**
   * Persistence class. Defaults to `long_lived` when omitted. Validated against
   * `VALID_PERSISTENCE`; unknown values are rejected.
   */
  persistence?: PersistenceClass | undefined;
  kind?: SageKind | undefined;
  tags?: string[] | undefined;
  /** Limit automatic agent injection to matching project roles/tasks/modes. */
  audience?: MemoryAudienceSelector | undefined;
  priority?: MemoryPriority | undefined;
  type?: MemoryType | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  anchors?: MemoryAnchor[] | undefined;
  sources?: MemorySourceRef[] | undefined;
  supersedes?: string[] | undefined;
  contradicts?: string[] | undefined;
  /**
   * Session that owns this memory. Required when `scope` is `'session'` so
   * retrieval and injection can filter by the requesting session. Ignored
   * for non-session scopes.
   */
  ownerSessionId?: string | undefined;
  /**
   * Optional hard TTL (ISO-8601). Used with `short_lived` / session digests;
   * hygiene soft-deletes when past.
   */
  expiresAt?: string | undefined;
}

/**
 * Input for `createCandidate` (review proposals). Carries the optional
 * first-class target linkage (`targetMemoryId`) and review reason
 * (`reviewReason`) so proposal consumers (ReviewQueue, resolvers) can attach
 * the candidate to the memory it reviews without parsing tags. Distinct from
 * `memoryId`/`reason` on `MemoryCandidate`, which record resolution results
 * (accepted memory id / rejection reason) and must not be overwritten.
 *
 * Candidates are PROPOSALS, not memories: they carry no `persistence` class
 * (the accepted memory is created by `rememberSage` with its own defaults),
 * so the field is omitted even though it exists on `RememberSageInput`.
 * Kind/scope are still runtime-validated through `validateRememberInput`.
 */
export type CreateCandidateInput = Omit<
  RememberSageInput,
  'legacyScope' | 'priority' | 'type' | 'persistence'
> & {
  /** Id of the memory this proposal reviews (e.g. a suggested delete/archive target). */
  targetMemoryId?: string | undefined;
  /** Revision reviewed; omitted for legacy proposals without a snapshot guard. */
  targetRevision?: number | undefined;
  /** Review reason (e.g. 'noise', 'contradiction', 'expires_at_passed'). */
  reviewReason?: string | undefined;
  /** Advisory suggested action (typed successor of the legacy `suggested:` tag prefix). */
  suggestedAction?: CandidateSuggestedAction | undefined;
};

/** Outcome of resolving a review candidate (the redesign contract's decision path). */
export type CandidateDecision = 'delete' | 'archive' | 'keep';

/**
 * Advisory action a review proposal suggests (typed successor of the legacy
 * `suggested:` tag prefix). The resolver's `CandidateDecision` remains the
 * authoritative outcome; `'investigate'`/`'update'` are advisory-only.
 */
export type CandidateSuggestedAction = CandidateDecision | 'investigate' | 'update';

export interface MemoryCandidateResolution {
  candidateId: string;
  decision: CandidateDecision;
  /** The memory the decision applied to, when the candidate carried target linkage. */
  targetMemoryId?: string | undefined;
  /** Whether the memory was actually mutated (false for permanent/missing targets). */
  applied: boolean;
  /** True when the candidate was already resolved — the call was a no-op. */
  alreadyResolved?: boolean | undefined;
  /** Mutation failure detail when a claimed candidate was restored for re-review. */
  error?: string | undefined;
}

export interface UpdateSageInput {
  /** Replace applicability conditions; null explicitly removes them. */
  validity?: import('./memory-model.js').MemoryValidity | null | undefined;
  /** Optimistic concurrency guard for corrections based on a previously read revision. */
  expectedRevision?: number | undefined;
  /** Evidence sources for corrected knowledge (replaces the old source list). */
  sources?: import('./memory-model.js').MemorySourceRef[] | undefined;
  /** Feedback-only update: never changes lifecycle, confidence or content revision. */
  feedback?: import('./memory-model.js').MemoryFeedbackInput | undefined;
  text?: string | undefined;
  tags?: string[] | undefined;
  /** Promote/demote persistence class. Forward-compatible: any future value is rejected. */
  persistence?: PersistenceClass | undefined;
  kind?: SageKind | undefined;
  anchors?: MemoryAnchor[] | undefined;
  /** Replace the automatic-injection audience; `{}` clears role/task/mode restrictions. */
  audience?: MemoryAudienceSelector | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  status?: SageStatus | undefined;
  supersedes?: string[] | undefined;
  contradicts?: string[] | undefined;
  /**
   * The memory that replaces this one. Only valid together with a resulting
   * status of `superseded`; the successor must exist and not be deleted.
   * Without it a superseded memory has no chain head, so `recoverSage` and the
   * file drawer cannot point at what replaced it.
   */
  supersededBy?: string | undefined;
  /**
   * Override the permanent-memory guard when setting `status: 'deleted'`.
   * Mirrors the `{ force: true }` contract on `deleteSage`. The
   * override is recorded in the audit log so the caller's intent is always
   * traceable. Ignored for non-deletion patches.
   */
  force?: boolean | undefined;
  /**
   * Authorize a `status: 'deleted'` transition without user-level force.
   * Candidate resolution uses this: the delete is authorized, but the
   * update-layer permanent-persistence guard stays armed, so a target
   * promoted to `'permanent'` between the review snapshot and the mutation
   * is refused instead of destroyed. Only `force: true` overrides
   * permanence. Ignored for non-deletion patches.
   */
  deleteAuthorized?: boolean | undefined;
}

/**
 * A semantic-recall provider. `search` returns the top-k semantic matches
 * for `query`, each carrying a `metadata.sageId` field that the fusion
 * function uses to map hits back to SAGE memory ids. The interface stays
 * structural so any backend (vector-memory, a remote embedding API, a
 * test fake) plugs in without subclassing.
 *
 * Declared here — not in `retrieval/vector-augment.ts` — because
 * `SageSearchOptions.vectorRecall` references it; declaring it next to the
 * consumer that imports `Sage` back would form a type-level module cycle
 * (ARCH: vector-augment ↔ types).
 */
export interface VectorRecallProvider {
  search(
    query: string,
    opts: { limit: number; threshold?: number },
  ): Promise<
    Array<{
      id: string;
      score: number;
      text: string;
      summary?: string | undefined;
      tags: string[];
      metadata?: Record<string, unknown> | undefined;
    }>
  >;
}

export interface SageSearchOptions {
  scope?: SageScope | undefined;
  legacyScope?: MemoryScope | undefined;
  limit?: number | undefined;
  includeStatuses?: SageStatus[] | undefined;
  /** Default true for management/search surfaces; automatic injection opts out explicitly. */
  includeAudienceScoped?: boolean | undefined;
  /**
   * Require every FTS term to match. Default false: an all-terms query that
   * finds nothing is retried as any-term, which is what an operator typing a
   * phrase into search expects. Automatic injection sets this so a zero-result
   * query stays a zero-result query instead of becoming a corpus scan.
   */
  requireAllTerms?: boolean | undefined;
  /**
   * The requesting session's ID. When set, session-scoped memories
   * (`scope = 'session'`) are filtered so only those owned by this session
   * are returned. Non-session scopes are unaffected.
   */
  sessionId?: string | undefined;
  /**
   * When true, session-scoped memories from ALL sessions are returned
   * regardless of `sessionId`. Intended for administrative surfaces
   * (memory manager UI, hygiene). Default false.
   */
  includeAllSessions?: boolean | undefined;
  /**
   * Soft hybrid re-rank of lexical/FTS hits with offline hashing embeddings.
   * Default: true for multi-token queries (fail-open). Set false to keep pure
   * SQL order. Stronger semantic indexing remains a future option.
   */
  semanticRerank?: boolean | undefined;
  /**
   * Optional semantic-recall backend. When set, the lexical candidate set
   * is fused with semantic matches from this provider via
   * `augmentLexicalWithVectorRecall`. The provider is decoupled from any
   * specific vector store — pass any object satisfying the structural
   * `VectorRecallProvider` contract. Fail-open: any error in the backend
   * is swallowed and the lexical list passes through unchanged.
   *
   * Production wiring: `@wrongstack/vector-memory`'s `VectorMemoryStore`
   * wrapped in a thin adapter that returns `{id, score, text, summary,
   * tags, metadata}` from `store.search()`.
   */
  vectorRecall?: VectorRecallProvider | undefined;
  /**
   * Weight of the vector channel when fusing with lexical. 0 = pure
   * lexical order, 1 = pure vector order. Default 0.3 (mirrors
   * `hybridRerankMemories`).
   */
  vectorRecallWeight?: number | undefined;
  /**
   * Extra vector-only candidates beyond `limit` for downstream relevance
   * filtering. Default 0 preserves strict search limits; clamped to 12.
   * Automatic tool retrieval opts in, then applies its normal injection gates.
   */
  vectorCandidateLimit?: number | undefined;
  /**
   * Cosine threshold for the vector-only channel. Vector-only hits below
   * this floor are dropped. Default 0.
   */
  vectorRecallThreshold?: number | undefined;
  /**
   * Cosine threshold forwarded to the vector backend's `search()`. Default
   * unset (backend default).
   */
  vectorRecallMinScore?: number | undefined;
}

export interface SageForAudienceOptions extends MemoryAudienceContext {
  limit?: number | undefined;
  includeStatuses?: SageStatus[] | undefined;
}

export interface SageForPathOptions {
  path: string;
  limit?: number | undefined;
  includeAncestors?: boolean | undefined;
  includeStatuses?: SageStatus[] | undefined;
  /** Default true for explicit reads; automatic tool-result injection sets false. */
  includeAudienceScoped?: boolean | undefined;
  /**
   * The requesting session's ID. When set, session-scoped memories
   * are filtered to only those owned by this session.
   */
  sessionId?: string | undefined;
  /**
   * When true, session-scoped memories from ALL sessions are returned.
   * Intended for administrative surfaces. Default false.
   */
  includeAllSessions?: boolean | undefined;
}

/**
 * How a memory matched the file/drawer query. Used by the UI to show the user
 * *why* a record appeared — `scope_file` is the strongest signal (the memory
 * was created specifically for this file); `mention` is the weakest.
 */
export type MemoryMatchVia =
  | 'scope_file'
  | 'scope_symbol'
  | 'anchor_file'
  | 'anchor_symbol'
  | 'anchor_directory'
  | 'mention';

/** Compact review-candidate metadata surfaced with a matched memory. */
export interface MemoryPendingReview {
  candidateId: string;
  reason: string;
  suggestedAction: 'delete' | 'archive' | 'update' | 'investigate';
  ageDays: number;
}

/**
 * A memory returned by `findMemoriesForFile`, augmented with UI-friendly
 * metadata: how it matched, whether a pending review candidate exists, and
 * — for superseded records — the head-of-chain id.
 *
 * Always use this shape (not raw `Sage`) for file-drawer / file-editor
 * surfaces, because the user needs the *why* before they decide what to do.
 */
export interface MemoryForFileMatch {
  memory: Sage;
  matchedVia: MemoryMatchVia;
  /** 0..1 — `scope_file` = 1.0, `anchor_file` = 0.85, `mention` = 0.3. */
  matchStrength: number;
  /** Populated when the memory is `superseded` and a head-of-chain exists. */
  supersededByActiveId?: string | undefined;
  /** Populated when hygiene has emitted a pending review candidate. */
  pendingReview?: MemoryPendingReview | undefined;
}

/** Filter / sort knobs for `findMemoriesForFile`. */
export interface FindMemoriesForFileOptions {
  /** Optional cursor line range — only symbol anchors overlapping this range are boosted. */
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
  /** Default true. If true, also include `superseded` and (optionally) `deleted` matches. */
  includeSuperseded?: boolean | undefined;
  /** Default false. Requires the explicit `deletedToggle` to opt in. */
  includeDeleted?: boolean | undefined;
  /** Cap on returned matches. Default 50. */
  limit?: number | undefined;
  /**
   * Session ownership filter, matching every other retrieval surface: pass the
   * calling session to see its own session-scoped memories. Unset hides owned
   * session records and leaves only unowned ones — fail-closed, so a caller
   * that forgets it under-reports instead of leaking another session's notes.
   */
  sessionId?: string | undefined;
  /** Admin opt-out: include every session's session-scoped memories. */
  includeAllSessions?: boolean | undefined;
}

/**
 * Aggregated response from `findMemoriesForFile`. Returns three buckets so
 * the file drawer can render primary / symbol-anchored / mentioned memories
 * in separate sections. Counts let the UI show "5 matches" headers without
 * needing the caller to recount.
 */
export interface FindMemoriesForFileResponse {
  filePath: string;
  /** file/symbol scope matches + file/directory anchor matches. */
  primaryMatches: MemoryForFileMatch[];
  /** symbol-anchored matches overlapping the cursor line range (if provided). */
  symbolMatches: MemoryForFileMatch[];
  /** Memories that mention this file path but aren't anchored to it. */
  relatedMatches: MemoryForFileMatch[];
  totalCount: number;
  activeCount: number;
  supersededCount: number;
  /** Count of matches that have a pending review candidate (any bucket). */
  reviewPendingCount: number;
}
export {
  kindToLegacyType,
  legacyToSageScope,
  legacyTypeToKind,
  sageToLegacyScope,
  toLegacyEntry,
} from './legacy-memory-conversion.js';
export type {
  AnchorVerificationResult,
  MemoryReviewReason,
  MemoryVerificationResult,
  SageHygieneOptions,
  SageHygieneReport,
  SageStats,
  VerificationStatus,
} from './memory-hygiene-types.js';
export type {
  MemoryAnchor,
  MemoryAudienceContext,
  MemoryAudienceSelector,
  MemoryFeedback,
  MemoryFeedbackInput,
  MemorySourceRef,
  MemoryValidity,
  PersistenceClass,
  Sage,
  SageKind,
  SageScope,
  SageStatus,
} from './memory-model.js';
export { SAGE_KINDS } from './memory-model.js';
