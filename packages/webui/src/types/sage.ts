/**
 * WebUI mirror of the canonical SAGE memory model.
 *
 * WHY THIS IS A MIRROR AND NOT AN IMPORT: `@wrongstack/sage` is a Node-side
 * package and is deliberately absent from `packages/webui/package.json`. Pulling
 * it in (or into a browser bundle) to share one type would couple the frontend
 * to a backend the frontend never executes. The mirror is therefore kept honest
 * by a CONTRACT TEST, not by a type import:
 *
 *   `tests/types/sage-type-contract.test.ts` parses BOTH this file and
 *   `packages/sage/src/memory-model.ts` and fails when the canonical shape
 *   gains or loses a field. Add a field to one side and it goes red.
 *
 * When you add a field to the canonical `Sage` / `MemoryAnchor`, add it here in
 * the same commit or the contract test fails.
 *
 * Two deliberate divergences from canonical, both safe:
 *  - `kind` stays `string` rather than the closed `SageKind` union: this UI must
 *    render kinds sent by older/newer servers without a type error. The contract
 *    test compares field NAMES, not their types, so this is unaffected.
 *  - Fields optional in canonical are optional here too, so existing test
 *    fixtures that build partial entries keep compiling.
 */
export type SageScope = 'project' | 'user' | 'session' | 'file' | 'symbol';
export type SageStatus =
  | 'active'
  | 'stale'
  | 'superseded'
  | 'contradicted'
  | 'archived'
  | 'deleted';

/** Mirrors `MemoryScope` from `@wrongstack/contracts/types` (legacy back-compat field). */
export type SageLegacyScope = 'project-agents' | 'project-memory' | 'user-memory';

/** Mirrors `PersistenceClass` — controls how hygiene treats a memory. */
export type SagePersistence = 'permanent' | 'long_lived' | 'short_lived';

/**
 * Why a `stale` memory is stale.
 *  - `verification` — anchor verification demoted it, so a later passing
 *    verification may restore it.
 *  - `manual` — someone set the status (retirement); automatic passes leave it
 *    alone.
 * Absent on records written before the field existed.
 */
export type SageStaleReason = 'verification' | 'manual';

/** Mirrors `MemoryFeedbackInput` / `MemoryFeedback` — model judgments. */
export interface SageFeedback {
  verdict: 'useful' | 'outdated' | 'incorrect' | 'irrelevant' | 'uncertain';
  /** Revision actually read by the model, not a fresh revision guessed at write time. */
  observedRevision: number;
  evidence: string;
  sessionId?: string | undefined;
  at: string;
}

/** Mirrors `MemorySourceRef` — provenance for a memory or a candidate. */
export interface SageSourceRef {
  type:
    | 'user'
    | 'session'
    | 'tool_result'
    | 'project_instruction'
    | 'file'
    | 'test'
    | 'command'
    | 'legacy_memory';
  sessionId?: string | undefined;
  toolUseId?: string | undefined;
  path?: string | undefined;
  command?: string | undefined;
  excerptHash?: string | undefined;
}

export interface SageAnchor {
  type: 'file' | 'directory' | 'symbol' | 'package' | 'command' | 'test' | 'git' | 'agent';
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
  role?: string | undefined;
  contentHash?: string | undefined;
  gitBlobHash?: string | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}

export interface SageEntry {
  id: string;
  revision: number;
  /** Applicability assumptions; source matches alone do not establish applicability. */
  validity?:
    | {
        statement: string;
        checks?: Array<{ type: 'source_contains'; path: string; text: string }> | undefined;
      }
    | undefined;
  /** Bounded model judgments; not verification or permission signals. */
  feedback?: SageFeedback[] | undefined;
  scope: SageScope;
  legacyScope?: SageLegacyScope | undefined;
  kind: string;
  status: SageStatus;
  /** Orthogonal to lifecycle: only `never` is an absolute LLM-context ban. */
  contextPolicy?: 'eligible' | 'never' | undefined;
  persistence?: SagePersistence | undefined;
  text: string;
  summary?: string | undefined;
  importance: number;
  confidence: number;
  freshness: number;
  tags: string[];
  anchors: SageAnchor[];
  /** Optional project-local audience. Omitted memories remain general knowledge. */
  audience?: { roles?: string[]; taskTypes?: string[]; modes?: string[] } | undefined;
  sources?: SageSourceRef[] | undefined;
  supersedes?: string[] | undefined;
  supersededBy?: string | undefined;
  contradicts?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string | undefined;
  lastVerifiedAt?: string | undefined;
  staleReason?: SageStaleReason | undefined;
  /** Last time the assistant referenced an injected memory (usefulness signal). */
  lastUsedAt?: string | undefined;
  expiresAt?: string | undefined;
  /** How often this memory was injected into context. */
  injectionCount?: number | undefined;
  /** How often an injected memory was referenced by the assistant afterwards. */
  useCount?: number | undefined;
  /** The session that owns a `scope: 'session'` memory. */
  ownerSessionId?: string | undefined;
}

export interface SageStats {
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  edges: number;
}

export interface SageGraphEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  weight: number;
  evidence?: string[] | undefined;
  createdAt: string;
}

export interface WSMemorySageList {
  type: 'memory.sage.list';
  payload: {
    /**
     * Echoed back from the request when the caller minted one
     * (`withRequestId` on the server). `consumeSuppressedChatEcho` correlates
     * on it to drop the chat echo for exactly the request that asked to be
     * suppressed.
     */
    requestId?: string | undefined;
    memories?: SageEntry[] | undefined;
    stats?: SageStats | undefined;
    error?: string | undefined;
  };
}

export interface WSMemorySageListPage {
  type: 'memory.sage.listPage';
  payload: {
    requestId?: string | undefined;
    memories?: SageEntry[] | undefined;
    nextCursor?: string | null | undefined;
    total?: number | undefined;
    statusCounts?: Record<string, number> | undefined;
    stats?: SageStats | undefined;
    error?: string | undefined;
  };
}

export interface WSMemorySageListCandidates {
  type: 'memory.sage.listCandidates';
  payload: {
    candidates?: MemoryCandidateEntry[] | undefined;
    error?: string | undefined;
  };
}

export interface WSMemorySageGet {
  type: 'memory.sage.get';
  payload: {
    memory?: SageEntry | undefined;
    error?: string | undefined;
  };
}

export interface WSMemorySageGraph {
  type: 'memory.sage.graph';
  payload: {
    query: string;
    edges?: SageGraphEdge[] | undefined;
    memories?: SageEntry[] | undefined;
    error?: string | undefined;
  };
}

/**
 * One hit in the breakdown-shaped search response. `vectorScore` is
 * null when the result only came from the lexical channel (no
 * semantic contribution); `lexicalScore` is null when only the
 * vector channel found it. `finalScore` is the RRF-style combined
 * score the WebUI should sort by default. `source` is a hint for
 * the renderer (color-coding).
 */
export interface WSSearchBreakdownHit {
  memory: SageEntry;
  vectorScore: number | null;
  lexicalScore: number | null;
  finalScore: number;
  source: 'lexical' | 'vector' | 'both';
}

export interface WSMemorySageSearchBreakdown {
  type: 'memory.sage.searchBreakdown';
  payload: {
    hits?: WSSearchBreakdownHit[] | undefined;
    /**
     * `breakdown` when the rich variant was used; `lexical` when the
     * fallback synthesized the score. Lets the UI decide whether to
     * render a dual-column score card or a single lexical column.
     */
    source?: 'breakdown' | 'lexical' | undefined;
    error?: string | undefined;
  };
}

export interface WSMemorySageUpdate {
  type: 'memory.sage.update';
  payload: {
    memory?: SageEntry | undefined;
    error?: string | undefined;
  };
}

export interface WSMemorySageRemember {
  type: 'memory.sage.remember';
  payload: {
    memory?: SageEntry | undefined;
    error?: string | undefined;
  };
}

export interface WSMemorySageDelete {
  type: 'memory.sage.delete';
  payload: {
    success: boolean;
    message: string;
  };
}

/**
 * Why a memory matched the file/drawer query. Mirrors
 * `MemoryMatchVia` from `@wrongstack/sage` (see PR #4 backend).
 * Kept as a local re-declaration so the webui types module doesn't have to
 * import from sage directly.
 */
export type MemoryMatchVia =
  | 'scope_file'
  | 'scope_symbol'
  | 'anchor_file'
  | 'anchor_symbol'
  | 'anchor_directory'
  | 'mention';

export interface MemoryPendingReview {
  candidateId: string;
  reason: string;
  suggestedAction: 'delete' | 'archive' | 'update' | 'investigate';
  ageDays: number;
}

/** Web-side mirror of `MemoryForFileMatch` — superset kept local for layering. */
export interface MemoryForFileMatch {
  memory: SageEntry;
  matchedVia: MemoryMatchVia;
  /** 0..1; higher = stronger match signal. */
  matchStrength: number;
  /** Populated for `status='superseded'` records when a head-of-chain exists. */
  supersededByActiveId?: string | undefined;
  /** Populated when hygiene has emitted a pending review candidate. */
  pendingReview?: MemoryPendingReview | undefined;
}

export interface MemoryForFileResponse {
  filePath: string;
  primaryMatches: MemoryForFileMatch[];
  symbolMatches: MemoryForFileMatch[];
  relatedMatches: MemoryForFileMatch[];
  totalCount: number;
  activeCount: number;
  supersededCount: number;
  reviewPendingCount: number;
}

/**
 * Request payload for `memory.sage.forFile`. Cursor fields are optional —
 * when both are provided, symbol-anchored memories overlapping the cursor
 * range surface first (cursor-aware boost).
 */
export interface WSMemorySageForFileRequest {
  /** Project-relative file path. */
  filePath: string;
  /** Optional caret line (1-indexed). */
  lineStart?: number;
  /** Optional last caret line. Pair with `lineStart`. */
  lineEnd?: number;
  /** Per-bucket cap. Default 50. */
  limit?: number;
  /** Default true. Include superseded memories (with supersededByActiveId). */
  showSuperseded?: boolean;
  /** Default false. Show recoverable deleted memories for one-click recovery. */
  showDeleted?: boolean;
}

export interface WSMemorySageForFile {
  type: 'memory.sage.forFile';
  payload: {
    response?: MemoryForFileResponse | undefined;
    error?: string | undefined;
  };
}

// ── Memory recover (PR #1) ──────────────────────────────────────────────
export interface WSMemorySageRecover {
  type: 'memory.sage.recover';
  payload: {
    /** The restored memory (active status). */
    memory?: SageEntry | undefined;
    /** True when the requested id was already active/superseded (no-op write). */
    noop?: boolean | undefined;
    /** Head-of-chain id when the requested id was superseded. */
    activeId?: string | undefined;
    error?: string | undefined;
  };
}

// ── Memory candidate resolve (PR #1 hygiene review queue) ──────────────
export interface WSMemorySageCandidateResolve {
  type: 'memory.sage.candidateResolve';
  payload: {
    /** The resolved candidate (with updated status). */
    candidate?: MemoryCandidateEntry | undefined;
    /** The user-facing action that was applied: accept | reject. */
    resolvedAction?: 'accept' | 'reject' | undefined;
    /** Echo of the request's `requestId`, when the request carried one. */
    requestId?: string | undefined;
    error?: string | undefined;
  };
}

/** Local mirror of sage's `MemoryCandidate`. */
export interface MemoryCandidateEntry {
  schemaVersion: 1;
  id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'merged';
  text: string;
  kind: string;
  confidence: number;
  importance: number;
  tags: string[];
  anchors: SageAnchor[];
  sources: Array<{
    type:
      | 'user'
      | 'session'
      | 'tool_result'
      | 'project_instruction'
      | 'file'
      | 'test'
      | 'command'
      | 'legacy_memory';
    sessionId?: string;
    toolUseId?: string;
    path?: string;
    command?: string;
    excerptHash?: string;
  }>;
  createdAt: string;
  updatedAt: string;
  /** Memory this proposal targets (hygiene / triage). */
  targetMemoryId?: string | undefined;
  reviewReason?: string | undefined;
  suggestedAction?: 'delete' | 'archive' | 'update' | 'investigate' | undefined;
  memoryId?: string | undefined;
  reason?: string | undefined;
}

// ── Memory backfill recoverable (PR #3) ───────────────────────────────
export interface WSMemorySageBackfillRecoverable {
  type: 'memory.sage.backfillRecoverable';
  payload: {
    /** Total count of deleted records examined. */
    examined?: number | undefined;
    /** How many of those were judged recoverable. */
    recoverable?: number | undefined;
    /** How many were actually written back as fresh active versions. */
    recovered?: number | undefined;
    /** True when the request was a dry-run (no writes). */
    dryRun?: boolean | undefined;
    error?: string | undefined;
  };
}
