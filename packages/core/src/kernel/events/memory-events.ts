import type {
  MemoryClearedPayload,
  MemoryConsolidatedPayload,
  MemoryForgottenPayload,
  MemoryRememberedPayload,
} from '../../types/memory.js';

/**
 * One memory's decision record inside a `memory.injector_run` trace.
 *
 * Structural on purpose: core must not depend on the SAGE package. The
 * producer is `toTraceMemory` in `@wrongstack/sage`; keep the two in step.
 */
export interface MemoryInjectorTraceMemory {
  id: string;
  kind: string;
  text: string;
  /** Final gate score, already clamped to 0..1. */
  score: number;
  /** The relation gate's own value — checked against `thresholds.relationFloor`. */
  relationStrength: number;
  anchor?: string | undefined;
  anchors: string[];
  tags: string[];
  activationReasons: string[];
  importance: number;
  confidence: number;
  freshness: number;
  persistence: string;
  /** Metadata floor before weighting: (importance*3 + confidence*2 + freshness) / 6. */
  metadataScore: number;
  /** Signed score contributions; they sum to the pre-clamp `score`. */
  scoreTerms: Array<{ label: string; value: number }>;
}

export interface MemoryEventMap {
  /** Cache hit on session store load — used by observability layers. */
  'storage.cache_hit': {
    sessionId: string;
    store: string;
    filePath: string;
    operation: string;
    durationMs: number;
  };
  /**
   * Fired after the user chooses 'always' or 'deny' on a confirmation prompt.
   * The TUI can use this to show a brief notification that the decision was
   * persisted to the trust file (e.g. "✓ always allowed popo.txt" / "✗ denied popo.txt").
   */
  'trust.persisted': {
    sessionId?: string | undefined;
    tool: string;
    pattern: string;
    decision: 'always' | 'deny';
  };
  // ── Memory store events — emitted by SageStore so plugins can react ──
  'memory.remembered': MemoryRememberedPayload;
  'memory.forgotten': MemoryForgottenPayload;
  'memory.cleared': MemoryClearedPayload;
  'memory.consolidated': MemoryConsolidatedPayload;
  /** Structured SAGE lifecycle events. Kept structural so core never depends on the package. */
  'memory.accepted': {
    memoryId: string;
    kind?: string | undefined;
    persistence?: string | undefined;
    confidence?: number | undefined;
    freshness?: number | undefined;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.candidate_created': {
    candidateId: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.candidate_rejected': {
    candidateId: string;
    reason: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Fired when a review candidate is resolved via resolveCandidate (delete/archive/keep). */
  'memory.candidate_resolved': {
    candidateId: string;
    decision: 'delete' | 'archive' | 'keep';
    applied: boolean;
    targetMemoryId?: string | undefined;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.updated': {
    memoryId: string;
    status: string;
    kind?: string | undefined;
    persistence?: string | undefined;
    confidence?: number | undefined;
    freshness?: number | undefined;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Fired after an explicitly authorized memory deletion has completed. */
  'memory.deleted': {
    memoryId: string;
    reason: string;
    persistence: string;
    removedEdges: number;
    contextPolicy: 'never' | 'eligible';
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.merged': {
    memoryId: string;
    mergedIds: string[];
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.superseded': {
    memoryId: string;
    supersededBy: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Fired when a deleted memory is restored to active via memory_recover. */
  'memory.recovered': {
    memoryId: string;
    reason: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Fired when memory_recover resolves to an already-active/superseded entry (no-op write). */
  'memory.recover_noop': {
    requestedId: string;
    activeId: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Emitted after a recoverable-memory backfill completes without writes. */
  'memory.backfill_dry_run': {
    examined: number;
    recoverable: number;
    recovered: number;
    skipped: number;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Emitted after a recoverable-memory backfill writes active versions. */
  'memory.backfill_applied': {
    examined: number;
    recoverable: number;
    recovered: number;
    skipped: number;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Fired when a hygiene review candidate is created for the ReviewQueue UI. */
  'memory.review_candidate_created': {
    candidateId: string;
    reason: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.contradicted': {
    memoryId: string;
    contradicts: string[];
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.staled': {
    memoryId: string;
    reason: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.archived': {
    memoryId: string;
    reason: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.injected': {
    memoryIds: string[];
    trigger: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /** Exact SAGE presence in the provider-bound request context. */
  'memory.context_snapshot': {
    at: string;
    activeMemoryIds: string[];
    enteredMemoryIds: string[];
    exitedMemoryIds: string[];
    reason: 'provider_request';
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  /**
   * One bounded, UI-facing decision trace for each on-demand Memory Injector
   * run. This is deliberately richer than `memory.injected`: it is also
   * emitted when nothing is injected, so operators can see what entered the
   * model context and what was rejected by score, visibility, cooldown, or
   * the current context budget.
   */
  'memory.injector_run': {
    runId: string;
    at: string;
    outcome: 'injected' | 'empty' | 'error';
    trigger: string;
    toolName: string;
    queryPreview: string;
    paths: string[];
    taskSignals: string[];
    contextPressure: number;
    budget: { maxHints: number; maxChars: number };
    /**
     * Gates in force for this run. A score is unreadable without them — 0.78
     * only means something once you know the bar it was measured against.
     * `relationFloor` is usually the one that decides: it rejects a candidate
     * before the composite score is ever consulted.
     */
    thresholds: { minScore: number; minImportance: number; relationFloor: number };
    candidates: number;
    eligible: number;
    rejected: {
      duplicate: number;
      belowScore: number;
      alreadyVisible: number;
      cooldown: number;
      budget: number;
    };
    activated: MemoryInjectorTraceMemory[];
    injected: MemoryInjectorTraceMemory[];
    injectedChars: number;
    error?: string | undefined;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.used': {
    memoryIds: string[];
    source: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.verified': {
    memoryId: string;
    status: string;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.hygiene_started': {
    examined: number;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.hygiene_completed': {
    examined: number;
    deduplicated: number;
    staled: number;
    archived: number;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.graph_edge_added': {
    edgeId: string;
    from: string;
    to: string;
    relation: string;
    weight?: number | undefined;
    evidence?: string[] | undefined;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  'memory.relationships_rebuilt': {
    examined: number;
    proposed: number;
    added: number;
    sessionId?: string | undefined;
    traceId?: string | undefined;
  };
  // ── Storage events — emitted by DefaultSessionStore, FileSessionWriter, goal-store, plan-store, boot, todos-checkpoint, queue-store, task-store ──
  /**
   * Fired when a store completes a read operation. Carries the session ID
   * and file path so dashboards can correlate storage I/O with agent
   * iterations via the session ID.
   */
  'storage.read': {
    sessionId: string;
    /** Which store was read. */
    store:
      | 'session'
      | 'goal'
      | 'plan'
      | 'project'
      | 'todos'
      | 'queue'
      | 'tasks'
      | 'completed-work'
      | 'memory'
      | 'annotations'
      | 'audit'
      | 'replay'
      | 'config';
    filePath: string;
    /** Session store: load|list|summary|index_read. Goal store: load. Plan store: load. Memory store: readAll. Annotations: list. Audit: verify|load. Replay: load|lookup. Config: read_json|load_sync. Completed-work: load. */
    operation: string;
    outcome: 'success' | 'failure';
    durationMs: number;
    error?: string;
    traceId?: string;
  };
  /**
   * Fired when a store completes a write operation. Covers both individual
   * event appends and batch flushes — check `eventCount` to distinguish.
   */
  'storage.write': {
    sessionId: string;
    store:
      | 'session'
      | 'goal'
      | 'plan'
      | 'project'
      | 'todos'
      | 'queue'
      | 'tasks'
      | 'completed-work'
      | 'memory'
      | 'annotations'
      | 'audit'
      | 'replay'
      | 'config';
    filePath: string;
    /** Session store: create|resume|append|flush|close|index_append|compact|checkpoint.
     * Goal store: save|update|delete. Plan store: save. Project manifest: manifest_write.
     * Todos: save. Queue: write|clear. Tasks: save. Memory: remember|forget|clear|consolidate.
     * Annotations: add|resolve|evict. Audit: record. Replay: record|compact. Config: persist_sync.
     * Completed-work: save. */
    operation: string;
    outcome: 'success' | 'failure';
    durationMs: number;
    eventCount?: number;
    error?: string;
    traceId?: string;
  };
  /**
   * Fired when a store operation fails after best-effort retries.
   * Use this for alert-worthy persistent failures (disk full, permissions).
   */
  'storage.error': {
    sessionId: string;
    store:
      | 'session'
      | 'goal'
      | 'plan'
      | 'project'
      | 'todos'
      | 'queue'
      | 'tasks'
      | 'completed-work'
      | 'memory'
      | 'annotations'
      | 'audit'
      | 'replay'
      | 'config';
    filePath: string;
    operation: string;
    outcome?: 'failure';
    error: string;
    recoverable: boolean;
    durationMs?: number;
    traceId?: string;
  };
}
