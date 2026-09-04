export type SageScope = 'project' | 'user' | 'session' | 'file' | 'symbol';
export type SageStatus =
  | 'active'
  | 'stale'
  | 'superseded'
  | 'contradicted'
  | 'archived'
  | 'deleted';

export interface SageAnchor {
  type: 'file' | 'directory' | 'symbol' | 'package' | 'command' | 'test' | 'git' | 'agent';
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
  role?: string | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}

export interface SageEntry {
  id: string;
  revision: number;
  scope: SageScope;
  kind: string;
  status: SageStatus;
  contextPolicy?: 'eligible' | 'never' | undefined;
  text: string;
  summary?: string | undefined;
  importance: number;
  confidence: number;
  freshness: number;
  tags: string[];
  anchors: SageAnchor[];
  audience?: { roles?: string[]; taskTypes?: string[]; modes?: string[] } | undefined;
  supersedes?: string[] | undefined;
  supersededBy?: string | undefined;
  contradicts?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string | undefined;
  lastVerifiedAt?: string | undefined;
  expiresAt?: string | undefined;
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
