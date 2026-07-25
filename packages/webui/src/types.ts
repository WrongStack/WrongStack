import type { SessionMarker, Usage } from '@wrongstack/core/types';
import type {
  KanbanBoard,
  KanbanBoardPresence,
  KanbanBoardSummary,
  KanbanEvent,
  KanbanTask,
} from '@wrongstack/kanban';

// Event types for WebSocket communication
export interface WSMessage {
  type: string;
  payload: unknown;
}

export interface WSSessionStart {
  type: 'session.start';
  payload: {
    sessionId: string;
    model: string;
    provider: string;
    maxContext?: number | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    reset?: boolean | undefined;
    replayMessages?: Array<{ role: string | undefined; content: unknown; ts?: string | undefined }>;
    /** Audit markers (compaction, mode/skill switches, subagent lifecycle,
     *  provider retries, truncation) projected server-side. Replayed alongside
     *  the conversation so a reconnect shows what the live stream showed. */
    replayMarkers?: SessionMarker[] | undefined;
    replayUsage?: Usage | undefined;
    /** True when no provider+model is configured yet — show the setup screen. */
    needsSetup?: boolean | undefined;
    /** Feature negotiation prevents a newer WebUI from sending messages to an older backend. */
    protocolCapabilities?: string[] | undefined;
  };
}

export interface WSSessionEnd {
  type: 'session.end';
  payload: {
    sessionId: string;
    usage: Usage;
    totalCost: number;
  };
}

export interface SessionScopedPayload {
  sessionId?: string | undefined;
}

/** One image attached to a user message. `data` is bare base64 (no data-URL
 *  prefix); `mediaType` travels separately. */
export interface WSUserMessageImage {
  data: string;
  mediaType: string;
  /** Original filename when the image came from a picker or drop. */
  name?: string;
}

export interface WSUserMessage {
  type: 'user_message';
  payload: SessionScopedPayload & {
    id: string;
    content: string;
    timestamp: number;
    stateExpiresAt?: number | undefined;
    /** Images attached in the composer (paste / drop / file picker). The
     *  server converts these to canonical ImageBlocks ahead of the text. */
    images?: WSUserMessageImage[];
    /** @deprecated Legacy single-image field (a full data-URL). Servers
     *  still accept it; new clients send `images` instead. */
    imageBase64?: string;
  };
}

export interface WSTextDelta {
  type: 'provider.text_delta';
  payload: SessionScopedPayload & {
    text: string;
    messageId: string;
  };
}

export interface WSThinkingDelta {
  type: 'provider.thinking_delta';
  payload: SessionScopedPayload & {
    text: string;
  };
}

export interface WSCodeMapFileTarget {
  filePath: string;
  operation: 'read' | 'write' | 'edit' | 'delete' | 'search';
  line?: number | undefined;
  endLine?: number | undefined;
}

export interface WSToolUseStart {
  type: 'tool.started';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
    messageId: string;
  };
}

export interface WSToolProgress {
  type: 'tool.progress';
  payload: SessionScopedPayload & {
    name: string;
    id: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    event: {
      type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
      text?: string | undefined;
      data?: Record<string, unknown>;
      path?: string | undefined;
      operation?: 'write' | 'edit' | 'delete' | 'rename' | undefined;
      line?: number | undefined;
      endLine?: number | undefined;
    };
  };
}

export interface WSToolExecuted {
  type: 'tool.executed';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
    output?: string | undefined;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  };
}

/** Subagent tool lifecycle dedicated to CodeMap; intentionally does not create chat bubbles. */
export interface WSCodeMapToolStarted {
  type: 'codemap.tool_started';
  payload: SessionScopedPayload & {
    parentSessionId?: string | undefined;
    traceId?: string | undefined;
    agentId: string;
    agentName: string;
    id: string;
    name: string;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
    output?: string | undefined;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  };
}

export interface WSCodeMapToolExecuted {
  type: 'codemap.tool_executed';
  payload: SessionScopedPayload & {
    parentSessionId?: string | undefined;
    traceId?: string | undefined;
    agentId: string;
    agentName: string;
    id?: string | undefined;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    fileTargets?: WSCodeMapFileTarget[] | undefined;
  };
}

export interface WSIterationStarted {
  type: 'iteration.started';
  payload: SessionScopedPayload & {
    index: number;
    maxIterations?: number | undefined;
  };
}

export interface WSIterationCompleted {
  type: 'iteration.completed';
  payload: SessionScopedPayload & {
    index: number;
    totalIterations: number;
  };
}

export interface WSIterationLimitReached {
  type: 'iteration.limit_reached';
  payload: SessionScopedPayload & {
    currentIterations: number;
    currentLimit: number;
  };
}

export interface WSProviderResponse {
  type: 'provider.response';
  payload: SessionScopedPayload & {
    content?: unknown;
    usage: Usage;
    stopReason: string;
    messageId: string;
  };
}

export interface WSProviderRetry {
  type: 'provider.retry';
  payload: SessionScopedPayload & {
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
  };
}

export interface WSProviderError {
  type: 'provider.error';
  payload: SessionScopedPayload & {
    providerId: string;
    status: number;
    description: string;
    retryable: boolean;
  };
}

export interface WSProviderFallback {
  type: 'provider.fallback';
  payload: SessionScopedPayload & {
    from: { providerId: string; model: string };
    to: { providerId: string; model: string };
    status: number;
    providerSwitched: boolean;
  };
}

export interface WSProviderStatusChanged {
  type: 'provider.status_changed';
  payload: SessionScopedPayload & {
    providerId: string;
    model: string;
    oldState: 'healthy' | 'degraded' | 'blocked';
    newState: 'healthy' | 'degraded' | 'blocked';
    reason: string;
    timestamp: number;
  };
}

export interface WSProviderActiveBlocked {
  type: 'provider.active_blocked';
  payload: SessionScopedPayload & {
    providerId: string;
    model: string;
    state: 'blocked';
    fallbackProviderId: string;
    fallbackModel: string;
    lastError: string;
    timestamp: number;
  };
}

export interface WSProviderStreamError {
  type: 'provider.stream_error';
  payload: SessionScopedPayload & {
    eventType: string;
    message: string;
  };
}

export interface WSRunResult {
  type: 'run.result';
  payload: SessionScopedPayload & {
    status: 'done' | 'failed' | 'max_iterations' | 'aborted';
    iterations: number;
    finalText?: string | undefined;
    error?: {
      code: string;
      message: string;
      recoverable: boolean;
    };
  };
}

export interface ChronicleEventView {
  schemaVersion: number;
  eventId: string;
  eventType: string;
  occurredAt?: string | undefined;
  observedAt: string;
  persistedAt: string;
  sequence: number;
  hash: string;
  previousHash: string;
  outcome?: string | undefined;
  durationNs?: string | undefined;
  scope: Record<string, string | undefined>;
  correlation: Record<string, string | undefined>;
  runtime?:
    | { providerId?: string; modelId?: string; processId?: number; parentProcessId?: number }
    | undefined;
  resource?:
    | { kind: string; id: string; path?: string; lineStart?: number; lineEnd?: number }
    | undefined;
  attributes?: Record<string, unknown> | undefined;
  tags?: Record<string, string> | undefined;
}

export interface ChronicleQuery {
  eventId?: string;
  eventTypes?: string[];
  outcomes?: string[];
  from?: string;
  to?: string;
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  providerId?: string;
  modelId?: string;
  traceId?: string;
  logicalRequestId?: string;
  attemptId?: string;
  toolCallId?: string;
  resourceKind?: string;
  resourceId?: string;
  path?: string;
  line?: number;
  text?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
}
export type ChronicleFacet =
  | 'eventType'
  | 'outcome'
  | 'projectId'
  | 'sessionId'
  | 'agentId'
  | 'taskId'
  | 'providerId'
  | 'modelId'
  | 'resourceKind'
  | 'resourcePath'
  | 'toolCallId';
export interface ChronicleFacetValue {
  value: string;
  count: number;
}
export interface ChronicleQueryResult {
  events: ChronicleEventView[];
  total: number;
  nextCursor?: string;
  scannedEvents: number;
  sourceFiles: number;
  invalidLines: number;
  summary: ChronicleSummary;
}
export interface ChronicleSummary {
  logicalRequests: number;
  modelAttempts: number;
  completedAttempts: number;
  failedAttempts: number;
  scheduledRetries: number;
  fallbacks: number;
  providers: number;
  models: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  providerAvgDurationMs: number;
  providerP95DurationMs: number;
  toolCalls: number;
  completedTools: number;
  failedTools: number;
  toolAvgDurationMs: number;
  processes: number;
  failedProcesses: number;
  fileEvents: number;
  uniqueFiles: number;
  agentEvents: number;
  uniqueAgents: number;
  decisions: number;
  escalations: number;
  failures: number;
  cancellations: number;
  families: Record<ChronicleSignalFamily, number>;
  failuresByFamily: Record<ChronicleSignalFamily, number>;
}
export type ChronicleSignalFamily =
  | 'llm'
  | 'agent'
  | 'tool'
  | 'file'
  | 'memory'
  | 'task'
  | 'decision'
  | 'runtime';
export interface ChronicleGraphResult {
  nodes: ChronicleEventView[];
  edges: Array<{
    from: string;
    to: string;
    kind: string;
    confidence: 'explicit' | 'correlated' | 'inferred';
  }>;
  truncated: boolean;
}
/** Derived aggregates served from the server-side Chronicle metrics store
 *  (metrics.db) — no raw journal scan on the request path. */
export type ChronicleMetricsView = 'summary' | 'providers' | 'tasks' | 'files';
export interface ChronicleMetricsRefresh {
  ingestedEvents: number;
  ingestedBytes: number;
  sourceFiles: number;
  invalidLines: number;
}
export interface ChronicleProviderDailyRow {
  day: string;
  providerId: string;
  modelId: string;
  attempts: number;
  completed: number;
  failed: number;
  retries: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  avgDurationMs: number;
  maxDurationMs: number;
}
export interface ChronicleTaskOutcomeRow {
  taskId: string;
  runId: string;
  boardId: string;
  sessionId: string;
  agentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  retries: number;
  verificationFailures: number;
  filesTouched: number;
}
export interface ChronicleFileLineageRow {
  path: string;
  operation: string;
  occurredAt: string;
  sessionId: string;
  agentId: string;
  taskId: string;
  boardId: string;
  runId: string;
  toolName: string;
  providerId: string;
  modelId: string;
  source: string;
}
export interface ChronicleMetricsSummaryView {
  providers: { attempts: number; completed: number; failed: number; successRate: number };
  tasks: Record<string, number>;
  files: { mutations: number; uniquePaths: number };
  estimatedCostUsd: number;
}
export type ChronicleMetricsResultPayload =
  | { view: 'summary'; refreshed: ChronicleMetricsRefresh; data: ChronicleMetricsSummaryView }
  | { view: 'providers'; refreshed: ChronicleMetricsRefresh; data: ChronicleProviderDailyRow[] }
  | { view: 'tasks'; refreshed: ChronicleMetricsRefresh; data: ChronicleTaskOutcomeRow[] }
  | { view: 'files'; refreshed: ChronicleMetricsRefresh; data: ChronicleFileLineageRow[] };

export interface WSSessionStats {
  type: 'session.stats';
  payload: {
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cost: number;
    duration: number;
  };
}

export interface WSError {
  type: 'error';
  payload: SessionScopedPayload & {
    phase: string;
    message: string;
  };
}

export interface WSToolConfirmNeeded {
  type: 'tool.confirm_needed';
  payload: SessionScopedPayload & {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    decisionSource?: string | undefined;
    riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
    boundaryReason?: string | undefined;
  };
}

export interface WSToolConfirmResult {
  type: 'tool.confirm_result';
  payload: SessionScopedPayload & {
    id: string;
    decision: 'yes' | 'no' | 'always' | 'deny';
  };
}

export interface WSTrustPersisted {
  type: 'trust.persisted';
  payload: SessionScopedPayload & {
    tool: string;
    pattern: string;
    decision: 'always' | 'deny';
  };
}

export interface WSToolLoopDetected {
  type: 'tool.loop_detected';
  payload: SessionScopedPayload & {
    tools: string;
    repeatCount: number;
    iteration: number;
    kind?: 'tool' | 'message' | 'mixed' | undefined;
    action?: 'steer' | 'cut' | undefined;
    scope?: 'iteration' | 'call' | undefined;
  };
}

export interface WSDelegateStarted {
  type: 'delegate.started';
  payload: SessionScopedPayload & {
    target: string;
    task: string;
  };
}

export interface WSDelegateCompleted {
  type: 'delegate.completed';
  payload: SessionScopedPayload & {
    target: string;
    task: string;
    ok: boolean;
    status?: string | undefined;
    summary: string;
    durationMs: number;
    iterations: number;
    toolCalls: number;
    costUsd?: number | undefined;
    subagentId?: string | undefined;
  };
}

export interface WSModelSwitch {
  type: 'model.switch';
  payload: {
    provider: string;
    model: string;
  };
}

export type MemoryScope = 'project-agents' | 'project-memory' | 'user-memory';

export interface WSContextDebug {
  type: 'context.debug';
  payload: SessionScopedPayload & {
    total: number;
    mode?: string | undefined;
    policy?: unknown | undefined;
    systemPrompt: number;
    tools: {
      total: number;
      count: number;
      breakdown: Array<{ name: string; tokens: number }>;
    };
    messages: {
      total: number;
      count: number;
      breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
    };
  };
}

export interface WSContextCompacted {
  type: 'context.compacted';
  payload: SessionScopedPayload & {
    before: number;
    after: number;
    saved: number;
    reductions: Array<{ phase: string; saved: number }>;
    repaired?: {
      removedToolUses: string[];
      removedToolResults: string[];
      removedMessages: number;
    };
  };
}

export interface WSCompactionFailed {
  type: 'compaction.failed';
  payload: SessionScopedPayload & {
    message: string;
    aggressive: boolean;
    level: 'warn' | 'soft' | 'hard';
    tokens: number;
    maxContext: number;
    load: number;
    fatal: boolean;
  };
}

export interface WSContextRepaired {
  type: 'context.repaired';
  payload: SessionScopedPayload & {
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
    beforeMessages?: number | undefined;
    afterMessages?: number | undefined;
  };
}

export interface WSContextPct {
  type: 'ctx.pct';
  payload: SessionScopedPayload & {
    load: number;
    rawLoad?: number | undefined;
    tokens: number;
    maxContext: number;
  };
}

export interface WSContextMaxContext {
  type: 'ctx.max_context';
  payload: SessionScopedPayload & {
    providerId: string;
    modelId: string;
    maxContext: number;
  };
}

export interface WSTokenThreshold {
  type: 'token.threshold';
  payload: SessionScopedPayload & {
    used: number;
    limit: number;
  };
}

export interface WSTokenCostEstimateUnavailable {
  type: 'token.cost_estimate_unavailable';
  payload: SessionScopedPayload & {
    model: string;
  };
}

export interface WSContextModesList {
  type: 'context.modes.list';
  payload: SessionScopedPayload & {
    activeId: string;
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
      thresholds: { warn: number; soft: number; hard: number };
      preserveK: number;
      eliseThreshold: number;
    }>;
  };
}

export interface WSContextModeChanged {
  type: 'context.mode.changed';
  payload: SessionScopedPayload & {
    id: string;
    name: string;
    policy: unknown;
  };
}

export interface WSToolsList {
  type: 'tools.list';
  payload: {
    tools: Array<{
      name: string;
      owner: string;
      description: string;
      params: string[];
      disabled: boolean;
      mutating: boolean;
      permission: string;
    }>;
  };
}

export interface WSMemoryList {
  type: 'memory.list';
  payload: {
    text: string;
    error?: string | undefined;
  };
}

// ── SAGE response types ───────────────────────────────────────

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
}

// ── Memory backfill recoverable (PR #3) ───────────────────────────────
export interface WSMemorySageBackfillRecoverable {
  type: 'memory.sage.backfillRecoverable';
  payload: {
    /** Records that were backfilled into a fresh active version (dryRun=false). */
    recoveredRecords?:
      | Array<{
          originalId: string;
          newActiveId: string;
          kind: string;
          scope: string;
          textPreview: string;
          deletedAt: string;
          persistence: string;
        }>
      | undefined;
    /** Total count of records recovered in this run. */
    recovered?: number | undefined;
    /** Total count examined. */
    examined?: number | undefined;
    /** True when the request was a dry-run (no writes). */
    dryRun?: boolean | undefined;
    error?: string | undefined;
  };
}

export interface WSSkillsList {
  type: 'skills.list';
  payload: {
    enabled: boolean;
    error?: string | undefined;
    skills: Array<{
      name: string;
      description: string;
      version: string;
      source: string;
      sourceUrl: string;
      ref: string;
      path: string;
      trigger: string;
      scope: string[];
    }>;
  };
}

export interface WSSkillContent {
  type: 'skills.content';
  payload: {
    name: string;
    body: string;
    path: string;
    source: string;
    relatedFiles: string[];
    references: string[];
    error?: string | undefined;
    sourceUrl?: string;
  };
}

export interface WSDesignKitSummary {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: string[];
  tags: string[];
  light: Record<string, string>;
  dark: Record<string, string>;
}

export interface WSDesignList {
  type: 'design.list';
  payload: {
    kits: WSDesignKitSummary[];
    activeKit: string | null;
    stack: string | null;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignUse {
  type: 'design.use';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    name?: string | undefined;
    aesthetic?: string | undefined;
    stack?: string | undefined;
    body?: string | undefined;
    overrides?: Record<string, string> | undefined;
    light?: Record<string, string> | undefined;
    dark?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignState {
  type: 'design.state';
  payload: {
    activeKit: string | null;
    stack: string | null;
    overrides?: Record<string, string> | undefined;
  };
}

export interface WSDesignSet {
  type: 'design.set';
  payload: {
    ok: boolean;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignTune {
  type: 'design.tune';
  payload: {
    ok: boolean;
    /** The concrete token overrides the knobs resolved to. */
    resolved?: Record<string, string> | undefined;
    overrides?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignSwap {
  type: 'design.swap';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    name?: string | undefined;
    aesthetic?: string | undefined;
    stack?: string | undefined;
    body?: string | undefined;
    overrides?: Record<string, string> | undefined;
    light?: Record<string, string> | undefined;
    dark?: Record<string, string> | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignMaterialize {
  type: 'design.materialize';
  payload: {
    ok: boolean;
    path?: string | undefined;
    format?: string | undefined;
    stack?: string | undefined;
    error?: string | undefined;
  };
}

export interface WSDesignVerify {
  type: 'design.verify';
  payload: {
    ok: boolean;
    kit?: string | undefined;
    filesScanned?: number | undefined;
    score?: number | undefined;
    violationCount?: number | undefined;
    violations?: { file: string; line: number; snippet: string; reason: string }[] | undefined;
    error?: string | undefined;
  };
}

export interface WSSkillsInstalled {
  type: 'skills.installed';
  payload: {
    success: boolean;
    error: string | null;
    results?: Array<{
      name: string;
      path: string;
      scope: 'project' | 'user';
      source: string;
      ref: string;
      skillCount: number;
    }>;
  };
}

export interface WSSkillsUninstalled {
  type: 'skills.uninstalled';
  payload: {
    success: boolean;
    error: string | null;
  };
}

export interface WSSkillsUpdated {
  type: 'skills.updated';
  payload: {
    success: boolean;
    error: string | null;
    updated?: Array<{ name: string; oldRef: string; newRef: string }>;
    unchanged?: string[];
    errors?: Array<{ name: string; error: string }>;
  };
}

export interface WSSkillsCreated {
  type: 'skills.created';
  payload: {
    success: boolean;
    error: string | null;
    skill?: {
      name: string;
      path: string;
      scope: 'project' | 'user';
    };
  };
}

export interface WSSkillsEdited {
  type: 'skills.edited';
  payload: {
    success: boolean;
    error: string | null;
  };
}

export interface WSSkillsExported {
  type: 'skills.exported';
  payload: {
    /** Base64-encoded ZIP buffer containing all skills as SKILL.md files */
    zipBase64: string;
    skillCount: number;
    error?: string | undefined;
  };
}

export interface WSDiagGet {
  type: 'diag.get';
  payload: SessionScopedPayload & {
    provider: string;
    model: string;
    cwd: string;
    sessionId: string;
    tools: { count: number; names: string[] };
    features: { memory: boolean; skills: boolean; modelsRegistry: boolean };
    mode: string;
    usage: { input: number; output: number; cacheRead?: number | undefined };
    messages: number;
    todos: number;
  };
}

export interface WSStatsGet {
  type: 'stats.get';
  payload: SessionScopedPayload & {
    sessionId: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    };
    cache: { readTokens: number; writeTokens: number; hitRatio: number } | null;
    cost: number;
    messages: number;
    readFiles: number;
    tools: number;
    sideEffectCount?: number | undefined;
    elapsedMs: number;
  };
}

export interface WSSideEffects {
  type: 'side_effects';
  payload: SessionScopedPayload & {
    sideEffects: Array<{
      toolUseId: string;
      toolName: string;
      ts: string;
      input: Record<string, unknown>;
      outcome?: string | undefined;
      risk: string;
    }>;
  };
}

export interface WSSessionsList {
  type: 'sessions.list';
  payload: {
    sessions: Array<{
      id: string;
      title: string;
      name?: string | undefined;
      startedAt: string;
      endedAt?: string | undefined;
      model: string;
      provider: string;
      tokenTotal: number;
      iterationCount?: number | undefined;
      toolCallCount?: number | undefined;
      toolErrorCount?: number | undefined;
      fileChangeCount?: number | undefined;
      toolBreakdown?: Record<string, number> | undefined;
      compactionCount?: number | undefined;
      outcome?: 'completed' | 'error' | 'timeout' | 'aborted' | undefined;
      isCurrent: boolean;
    }>;
    error?: string | undefined;
  };
}

// --- Provider/Model/Key management (mirrors TUI/CLI auth-menu experience) ---

export interface WSProviderCatalog {
  type: 'provider.catalog';
  payload: {
    providers: Array<{
      id: string;
      name: string;
      family: string;
      apiBase?: string | undefined;
      envVars: string[];
      modelCount: number;
      hasApiKey: boolean;
    }>;
  };
}

export interface WSProviderModels {
  type: 'provider.models';
  payload: {
    provider: string;
    models: Array<{
      id: string;
      name: string;
      description?: string | undefined;
      releaseDate?: string | undefined;
      contextWindow?: number | undefined;
      inputCost?: number | undefined;
      outputCost?: number | undefined;
      capabilities: string[];
    }>;
  };
}

export interface WSSavedProviders {
  type: 'providers.saved';
  payload: {
    providers: Array<{
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      /** Saved model allowlist, in the order the user pinned them. */
      models?: string[] | undefined;
      /** First entry of `models`, surfaced for the panel's "Using" line. */
      pickedModelId?: string | undefined;
      apiKeys: Array<{
        label: string;
        maskedKey: string;
        isActive: boolean;
        createdAt: string;
      }>;
    }>;
  };
}

/**
 * Health-probe result for a single provider, broadcast in reply to a
 * `provider.probe` client message. Mirrors the `ProbeResult` shape
 * from `@wrongstack/runtime/probe`, plus the `providerId` so panels
 * can route the reply to the right card.
 */
export interface WSProviderProbe {
  type: 'provider.probe';
  payload: {
    providerId: string;
    ok: boolean;
    status: string;
    httpStatus?: number | undefined;
    elapsedMs?: number | undefined;
    modelCount?: number | undefined;
    modelIds?: string[] | undefined;
    detail?: string | undefined;
  };
}

export interface WSKeyOperationResult {
  type: 'key.operation_result';
  payload: {
    success: boolean;
    message: string;
  };
}

/** Which subscription OAuth login a flow is running. */
export type OAuthKind = 'chatgpt' | 'claude' | 'copilot';

/**
 * Progress for an in-flight subscription OAuth login, broadcast in reply to
 * `auth.oauth.start` / `auth.oauth.code`. `phase` drives the UI:
 *  - `awaiting_browser` — loopback flows: open `authorizeUrl` in a new tab.
 *  - `awaiting_code` — copilot device flow: show `userCode` + `verificationUri`.
 *  - `exchanging` / `fetching_models` — spinner states.
 *  - `success` — `providerId` is now saved (the `providers.saved` broadcast follows).
 *  - `error` — `message` carries the reason.
 */
export interface WSAuthOAuthStatus {
  type: 'auth.oauth.status';
  payload: {
    kind: OAuthKind;
    phase:
      | 'awaiting_browser'
      | 'awaiting_code'
      | 'exchanging'
      | 'fetching_models'
      | 'success'
      | 'error';
    providerId?: string | undefined;
    authorizeUrl?: string | undefined;
    verificationUri?: string | undefined;
    userCode?: string | undefined;
    /** True when a loopback listener bound (false → manual paste needed). */
    bound?: boolean | undefined;
    message?: string | undefined;
  };
}

export interface WSFilesList {
  type: 'files.list';
  payload: {
    files: string[];
  };
}

export type CompletionItemKind =
  | 'text'
  | 'method'
  | 'function'
  | 'constructor'
  | 'field'
  | 'variable'
  | 'class'
  | 'interface'
  | 'module'
  | 'property'
  | 'unit'
  | 'value'
  | 'enum'
  | 'keyword'
  | 'snippet'
  | 'file'
  | 'reference';

export interface WSCompletionRequest {
  type: 'completion.request';
  payload: {
    requestId: string;
    filePath: string;
    language: string;
    lineNumber: number;
    column: number;
    content?: string | undefined;
    prefix: string;
    suffix?: string | undefined;
    triggerCharacter?: string | undefined;
    triggerKind?: number | undefined;
    allowLlm?: boolean | undefined;
  };
}

export interface WSCompletionResult {
  type: 'completion.result';
  payload: {
    requestId: string;
    filePath: string;
    items: Array<{
      label: string;
      insertText: string;
      kind?: CompletionItemKind | undefined;
      detail?: string | undefined;
      documentation?: string | undefined;
      sortText?: string | undefined;
      source?: 'llm' | 'index' | 'lsp' | undefined;
    }>;
    error?: string | undefined;
  };
}

export interface WSTodosUpdated {
  type: 'todos.updated';
  payload: SessionScopedPayload & {
    todos: Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm?: string | undefined;
    }>;
  };
}

export interface WSTodosCleared {
  type: 'todos.cleared';
  payload?: Record<string, never>;
}

export interface WSModesList {
  type: 'modes.list';
  payload: {
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
    }>;
    activeId: string;
  };
}

/** Goal live state broadcast (see server/goal-ws-handler.ts). */
export interface WSGoalState {
  type: 'goal.state';
  payload: Record<string, unknown>;
}

export interface WSGoalProgress {
  type: 'goal.progress';
  payload: Record<string, unknown>;
}

export interface WSGoalLifecycle {
  type:
    | 'goal.paused'
    | 'goal.resumed'
    | 'goal.stopped'
    | 'goal.saved'
    | 'goal.completed'
    | 'goal.failed'
    | 'goal.error'
    | 'goal.cleared'
    | 'goal.reverted';
  payload: Record<string, unknown>;
}

export interface WSGoalList {
  type: 'goal.list';
  payload: { graphs: unknown[] };
}

export interface WSEternalIteration {
  type: 'eternal.iteration';
  payload: { entry: Record<string, unknown> };
}

export interface WSAgentTimelineMessage {
  type: 'agent.timeline.message';
  payload: SessionScopedPayload & {
    subagentId: string;
    agentName: string;
    content: string;
    kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'status' | 'system';
    iteration: number;
    ts: string;
    toolName?: string | undefined;
    toolOk?: boolean | undefined;
    costUsd?: number | undefined;
  };
}

export interface WSAgentStatusChanged {
  type: 'agent.status_changed';
  payload: SessionScopedPayload & {
    subagentId: string;
    agentName: string;
    status:
      | 'spawned'
      | 'running'
      | 'completed'
      | 'failed'
      | 'timeout'
      | 'stopped'
      | 'budget_exhausted';
    ts: string;
    summary?: string | undefined;
    task?: string | undefined;
  };
}

export interface WSKanbanResult {
  type: `kanban.${string}`;
  payload: {
    success: boolean;
    data?:
      | KanbanBoard
      | KanbanBoardSummary[]
      | KanbanTask
      | KanbanTask[]
      | KanbanEvent[]
      | Record<string, unknown>
      | null;
    error?: string | undefined;
  };
}

export interface WSKanbanTaskActivity {
  type: 'kanban.task.activity';
  payload: {
    success: boolean;
    data?:
      | {
          boardId: string;
          taskId: string;
          events: KanbanEvent[];
          presence?: KanbanBoardPresence[] | undefined;
        }
      | undefined;
    error?: string | undefined;
  };
}

/** One worktree lane in the swim-lane / DAG view. */
export interface WorktreeHandleView {
  handleId: string;
  ownerId: string;
  ownerLabel: string;
  /** Absolute checkout path (for open-in-terminal / remove). */
  dir?: string | undefined;
  branch: string;
  baseBranch: string;
  status: 'allocating' | 'active' | 'committing' | 'merging' | 'merged' | 'needs-review' | 'failed';
  insertions: number;
  deletions: number;
  files: number;
  conflictFiles?: string[] | undefined;
  allocatedAt: number;
  lastEventAt: number;
  recentActivity: Array<{ kind: string; text: string; at: number }>;
}

/** Full worktree snapshot (broadcast on a timer, see worktree-ws-handler.ts). */
export interface WSWorktreeState {
  type: 'worktree.state';
  payload: { worktrees: WorktreeHandleView[]; baseBranch: string };
}

/** Incremental worktree lifecycle event — drives the flowing activity strip. */
export interface WSWorktreeEvent {
  type: 'worktree.event';
  payload: { kind: string; handleId: string; text: string; at: number };
}

/** One orphaned git artifact left by a previous/crashed run. */
export interface WorktreeOrphanView {
  /** Absolute checkout path (omitted for a branch-only orphan). */
  dir?: string | undefined;
  /** Branch name (`wstack/ap/*`), when known. */
  branch?: string | undefined;
  kind: 'worktree' | 'branch';
}

/** Disk-scanned orphan inventory + whether it is safe to clean right now. */
export interface WSWorktreeOrphans {
  type: 'worktree.orphans';
  payload: {
    orphans: WorktreeOrphanView[];
    /** False while a run is live (in this session or another process). */
    canClean: boolean;
    /** Why cleaning is blocked, when canClean is false. */
    reason?: string | undefined;
  };
}

/** Outcome of a worktree-panel orphan cleanup (bulk or single remove). */
export interface WSWorktreeCleanupResult {
  type: 'worktree.cleanup_result';
  payload: { ok: boolean; removed: number; reason?: string | undefined };
}

/** Compact per-worktree change summary. */
export interface WorktreeDiffSummary {
  files: Array<{ path: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
  commits: number;
}

/** Outcome of a per-worktree squash-merge into base. */
export interface WSWorktreeMergeResult {
  type: 'worktree.merge_result';
  payload: {
    ok: boolean;
    branch: string;
    conflict?: boolean | undefined;
    conflictFiles?: string[] | undefined;
    reason?: string | undefined;
  };
}

/** Result of a per-worktree "View changes" request. */
export interface WSWorktreeDiffResult {
  type: 'worktree.diff_result';
  payload: { dir: string; summary: WorktreeDiffSummary | null };
}

/** One Brain pool/judge model entry on the wire ("provider/model" grammar when a string). */
export interface BrainModelEntryWire {
  provider?: string | undefined;
  model: string;
}

/** One Brain council voting seat on the wire. */
export interface BrainCouncilVoterWire extends BrainModelEntryWire {
  persona?: string | undefined;
  weight?: number | undefined;
  veto?: boolean | undefined;
}

/** Predicate half of a deterministic Brain rule on the wire (mirrors BrainRuleMatch). */
export interface BrainRuleMatchWire {
  source?: string | string[] | undefined;
  risk?: string | string[] | undefined;
  minRisk?: string | undefined;
  maxRisk?: string | undefined;
  fallback?: string | string[] | undefined;
  hasOptions?: boolean | undefined;
  offersOption?: string | undefined;
  question?: string | undefined;
  context?: string | undefined;
  notQuestion?: string | undefined;
  notContext?: string | undefined;
}

/** Action half of a deterministic Brain rule on the wire (mirrors BrainRuleAction). */
export type BrainRuleActionWire =
  | {
      action: 'answer';
      optionId?: string | undefined;
      text?: string | undefined;
      rationale?: string | undefined;
    }
  | { action: 'deny'; reason?: string | undefined }
  | { action: 'escalate'; prompt?: string | undefined }
  | { action: 'defer' };

/** One deterministic Brain rule on the wire (mirrors core's BrainRule). */
export interface BrainRuleWire {
  id: string;
  enabled?: boolean | undefined;
  description?: string | undefined;
  when: BrainRuleMatchWire;
  then: BrainRuleActionWire;
}

/** Built-in pattern-heuristic toggles on the wire (mirrors BrainHeuristicsConfig). */
export interface BrainHeuristicsWire {
  lowRiskAutoAnswer: boolean;
  blockedResolved: boolean;
  deadlockSkip: boolean;
  retryExhausted: boolean;
  continuePing: boolean;
  blockedResolvedMarkers?: string[] | undefined;
}

/** Writable form of the heuristic toggles (every field optional, `null` clears the block). */
export interface BrainHeuristicsPatchWire {
  lowRiskAutoAnswer?: boolean | undefined;
  blockedResolved?: boolean | undefined;
  deadlockSkip?: boolean | undefined;
  retryExhausted?: boolean | undefined;
  continuePing?: boolean | undefined;
  blockedResolvedMarkers?: string[] | undefined;
}

/** Effective single-LLM tier quality gate. */
export interface BrainLlmWire {
  maxTokens: number;
  rejectUncertain: boolean;
  minConfidence: number;
  denyIsTerminal: 'never' | 'when-decided' | 'always';
}

/** Writable single-LLM tier quality gate. */
export interface BrainLlmPatchWire {
  maxTokens?: number | undefined;
  rejectUncertain?: boolean | undefined;
  minConfidence?: number | undefined;
  denyIsTerminal?: 'never' | 'when-decided' | 'always' | undefined;
  circuitBreaker?:
    | {
        failureThreshold?: number | undefined;
        cooldownMs?: number | undefined;
      }
    | undefined;
}

/** Effective replay-trace settings. */
export interface BrainTraceWire {
  enabled: boolean;
  content: 'none' | 'redacted' | 'full';
  path?: string | undefined;
}

/** Writable replay-trace settings. */
export interface BrainTracePatchWire {
  enabled?: boolean | undefined;
  content?: 'none' | 'redacted' | 'full' | undefined;
  path?: string | undefined;
  maxOpenRecords?: number | undefined;
}

/** BrainMonitor distress-signal settings (same shape read + written). */
export interface BrainMonitorWire {
  enabled?: boolean | undefined;
  policy?: 'llm' | 'steer' | 'observe' | undefined;
  signals?:
    | {
        toolFailureStreak?: boolean | undefined;
        errorStorm?: boolean | undefined;
        agentStall?: boolean | undefined;
        fileChurn?: boolean | undefined;
      }
    | undefined;
  toolFailureStreak?: number | undefined;
  errorStormCount?: number | undefined;
  errorStormWindowMs?: number | undefined;
  stallMs?: number | undefined;
  stallCheckIntervalMs?: number | undefined;
  fileChurnThreshold?: number | undefined;
  fileChurnWindowMs?: number | undefined;
  fileEditTools?: string[] | undefined;
  cooldownMs?: number | undefined;
}

/** Effective decision-cache settings plus live counters (`hits`/`misses`/`size` are read-only). */
export interface BrainCacheWire {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  hits: number;
  misses: number;
  size: number;
}

/** Writable decision-cache settings. */
export interface BrainCachePatchWire {
  enabled?: boolean | undefined;
  ttlMs?: number | undefined;
  maxEntries?: number | undefined;
}

/** One council seat template on the wire. */
export interface BrainCouncilSeatWire {
  persona: string;
  veto?: boolean | undefined;
}

/** Headless escalation variant. */
export type BrainTerminalPolicyWire = 'conservative' | 'deny-all' | 'continue-on-recommended';

/** JSON-safe snapshot of the live Brain config (mirrors core's BrainConfigSnapshot). */
export interface BrainConfigWire {
  mode: 'headless' | 'interactive';
  maxAutoRisk: 'off' | 'low' | 'medium' | 'high' | 'all';
  models: BrainModelEntryWire[];
  strategy: 'fallback' | 'round-robin';
  decisionTimeoutMs?: number | undefined;
  humanTimeoutMs?: number | undefined;
  council: {
    /** EFFECTIVE enablement (voters>=2 default rule applied). */
    enabled: boolean;
    configured?: boolean | undefined;
    minRisk: 'medium' | 'high' | 'critical';
    voters: BrainCouncilVoterWire[];
    quorum?: number | undefined;
    approval?: number | undefined;
    judge?: BrainModelEntryWire | undefined;
    perCallTimeoutMs?: number | undefined;
    maxConcurrency?: number | undefined;
    distinctness: 'none' | 'model' | 'provider';
    judgeMaxTokens?: number | undefined;
    seats: BrainCouncilSeatWire[];
  };
  ledger: {
    enabled: boolean;
    autoDenyAfterFailures?: number | undefined;
    path?: string | undefined;
    /** Writable via the patch; core's snapshot does not echo these back yet. */
    maxMemoryEntries?: number | undefined;
    interventionRetryWindowMs?: number | undefined;
  };
  /** Configured deterministic rules, in evaluation order (read-only here). */
  rules: BrainRuleWire[];
  /** Compile diagnostics from the last assembly — one per dropped rule. */
  ruleErrors: string[];
  heuristics: BrainHeuristicsWire;
  llm: BrainLlmWire;
  trace: BrainTraceWire;
  monitor: BrainMonitorWire;
  terminalPolicy: BrainTerminalPolicyWire;
  decisionLogMaxEntries: number;
  /** Live LLM circuit-breaker state, when a breaker is wired (read-only). */
  circuit?: { state: string; consecutiveFailures: number } | undefined;
  cache: BrainCacheWire;
  poolLabels: string[];
  councilLabels: string[];
  /**
   * EFFECTIVE council judge, undefined when no council is wired. Distinct from
   * `council.judge` (the CONFIGURED one, usually absent): the derived judge is
   * the one that can silently also be a seated voter.
   */
  judgeLabel?: string | undefined;
  /**
   * True when the effective judge is also a seated voter. Resolved server-side
   * — do not re-derive it from the `councilLabels` display strings.
   */
  judgeIsVoter?: boolean | undefined;
  usingSessionModel: boolean;
}

/** Partial Brain config update: omitted = untouched, null = clear, arrays replace. */
export interface BrainConfigPatchWire {
  mode?: 'headless' | 'interactive' | undefined;
  maxAutoRisk?: 'off' | 'low' | 'medium' | 'high' | 'all' | undefined;
  models?: Array<string | BrainModelEntryWire> | null | undefined;
  strategy?: 'fallback' | 'round-robin' | null | undefined;
  decisionTimeoutMs?: number | null | undefined;
  humanTimeoutMs?: number | null | undefined;
  council?:
    | {
        enabled?: boolean | null | undefined;
        minRisk?: 'medium' | 'high' | 'critical' | null | undefined;
        voters?: Array<string | BrainCouncilVoterWire> | null | undefined;
        quorum?: number | null | undefined;
        approval?: number | null | undefined;
        judge?: string | BrainModelEntryWire | null | undefined;
        perCallTimeoutMs?: number | null | undefined;
        maxConcurrency?: number | null | undefined;
        distinctness?: 'none' | 'model' | 'provider' | null | undefined;
        judgeMaxTokens?: number | null | undefined;
        seats?: BrainCouncilSeatWire[] | null | undefined;
      }
    | null
    | undefined;
  ledger?:
    | {
        enabled?: boolean | undefined;
        autoDenyAfterFailures?: number | null | undefined;
        maxMemoryEntries?: number | null | undefined;
        interventionRetryWindowMs?: number | null | undefined;
      }
    | null
    | undefined;
  /** Replaces the whole rule table; `null` clears it. */
  rules?: BrainRuleWire[] | null | undefined;
  /** Merged field-by-field; `null` clears the block back to all-defaults. */
  heuristics?: BrainHeuristicsPatchWire | null | undefined;
  llm?: BrainLlmPatchWire | null | undefined;
  trace?: BrainTracePatchWire | null | undefined;
  monitor?: BrainMonitorWire | null | undefined;
  terminalPolicy?: BrainTerminalPolicyWire | null | undefined;
  decisionLogMaxEntries?: number | null | undefined;
  cache?: BrainCachePatchWire | null | undefined;
}

export type WSClientMessageCore =
  | WSUserMessage
  | WSToolConfirmResult
  | { type: 'side_effects.list'; payload?: Record<string, never> }
  | {
      type: 'goal.start';
      payload: {
        title: string;
        phases?: unknown[] | undefined;
        autonomous?: boolean | undefined;
        /** Per-run override of git-worktree isolation. Omitted → env default
         *  (WRONGSTACK_GOAL_WORKTREES). false → run on the current branch. */
        worktrees?: boolean | undefined;
      };
    }
  | { type: 'goal.pause'; payload: Record<string, never> }
  | { type: 'goal.resume'; payload: Record<string, never> }
  | { type: 'goal.stop'; payload: Record<string, never> }
  | { type: 'goal.clear'; payload?: Record<string, never> }
  | { type: 'goal.revert'; payload?: Record<string, never> }
  | { type: 'goal.status'; payload?: Record<string, never> }
  | { type: 'goal.state'; payload?: Record<string, never> }
  | { type: 'goal.save'; payload?: Record<string, never> }
  | { type: 'goal.list'; payload?: Record<string, never> }
  | { type: 'goal.load'; payload: { graphId: string } }
  | { type: 'goal.toggleAutonomous'; payload: { autonomous?: boolean | undefined } }
  | { type: 'goal.selectPhase'; payload: { phaseId: string } }
  | { type: 'goal.taskStatus'; payload: { taskId: string; status: string } }
  | { type: 'goal.moveTask'; payload: { taskId: string; toPhaseId: string } }
  | {
      type: 'goal.assignTask';
      payload: { taskId: string; agentId?: string | undefined; agentName?: string | undefined };
    }
  | {
      type: 'goal.addTask';
      payload: {
        phaseId: string;
        title: string;
        description?: string | undefined;
        type?: string | undefined;
        priority?: string | undefined;
      };
    }
  | { type: 'goal.retryTask'; payload: { taskId: string } }
  | { type: 'goal.runTask'; payload: { taskId: string } }
  | { type: 'specs.list'; payload?: Record<string, never> }
  | { type: 'specs.get'; payload: { specId: string } }
  | {
      type: 'specs.taskStatus';
      payload: { graphId: string; taskId: string; status: string };
    }
  | { type: 'sdd.board.get'; payload?: Record<string, never> }
  | { type: 'sdd.board.list'; payload?: Record<string, never> }
  | { type: 'sdd.board.pause'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.resume'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.stop'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.retry'; payload: { taskId: string; runId?: string | undefined } }
  | { type: 'sdd.board.retry_all_failed'; payload?: { runId?: string | undefined } }
  | {
      type: 'sdd.board.reassign';
      payload: { taskId: string; agentName: string; runId?: string | undefined };
    }
  | {
      type: 'sdd.board.set_task_model';
      payload: {
        taskId: string;
        model?: string | undefined;
        provider?: string | undefined;
        runId?: string | undefined;
      };
    }
  | {
      type: 'sdd.board.set_task_fallbacks';
      payload: {
        taskId: string;
        fallbackModels?: string[] | undefined;
        runId?: string | undefined;
      };
    }
  | {
      type: 'sdd.board.set_task_verification';
      payload: {
        taskId: string;
        verificationCommand?: string | undefined;
        runId?: string | undefined;
      };
    }
  | { type: 'sdd.board.cancel_task'; payload: { taskId: string; runId?: string | undefined } }
  | { type: 'sdd.board.delete_task'; payload: { taskId: string; runId?: string | undefined } }
  | {
      type: 'sdd.board.split_task';
      payload: {
        taskId: string;
        subtasks: Array<{ title: string; description: string }>;
        runId?: string | undefined;
      };
    }
  | { type: 'sdd.board.cleanup_worktrees'; payload?: { runId?: string | undefined } }
  | { type: 'sdd.board.rollback'; payload?: { runId?: string | undefined } }
  | {
      type: 'sdd.board.destroy';
      payload?: { runId?: string | undefined; revertMerged?: boolean | undefined };
    }
  | { type: 'worktree.scan'; payload?: Record<string, never> }
  | { type: 'worktree.cleanup'; payload?: Record<string, never> }
  | { type: 'worktree.remove'; payload: { dir?: string | undefined; branch?: string | undefined } }
  | { type: 'worktree.merge'; payload: { branch: string } }
  | { type: 'worktree.diff'; payload: { dir: string; baseBranch?: string | undefined } }
  | { type: 'sdd.spec.start'; payload: { goal: string } }
  | { type: 'sdd.spec.message'; payload: { text: string } }
  | { type: 'sdd.spec.approve'; payload?: Record<string, never> }
  | { type: 'sdd.spec.get'; payload?: Record<string, never> }
  | {
      type: 'sdd.run.start';
      payload?: {
        parallelSlots?: number | undefined;
        model?: string | undefined;
        provider?: string | undefined;
        fallbackModels?: string[] | undefined;
        /** Per-run override of git-worktree isolation. Omitted → env default
         *  (WRONGSTACK_SDD_WORKTREES). false → run on the current branch. */
        worktrees?: boolean | undefined;
      };
    }
  | { type: 'abort'; payload: SessionScopedPayload }
  | { type: 'session.resume'; payload: { id: string } & SessionScopedPayload }
  | { type: 'session.new'; payload?: SessionScopedPayload }
  | { type: 'session.checkpoints'; payload?: SessionScopedPayload }
  | { type: 'session.rewind'; payload: { checkpointIndex: number } & SessionScopedPayload }
  | { type: 'context.clear'; payload?: SessionScopedPayload }
  | { type: 'context.compact'; payload: { aggressive: boolean } & SessionScopedPayload }
  | { type: 'context.repair'; payload?: SessionScopedPayload }
  | { type: 'context.debug'; payload?: SessionScopedPayload }
  | { type: 'context.modes.list'; payload?: SessionScopedPayload }
  | { type: 'context.mode.switch'; payload: { id: string } & SessionScopedPayload }
  | {
      type: 'context.mode.create';
      payload: {
        id: string;
        name: string;
        description: string;
        thresholds: { warn: number; soft: number; hard: number };
        preserveK: number;
        eliseThreshold: number;
      } & SessionScopedPayload;
    }
  | {
      type: 'context.mode.update';
      payload: {
        id: string;
        name?: string | undefined;
        description?: string | undefined;
        thresholds?:
          | { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined }
          | undefined;
        preserveK?: number | undefined;
        eliseThreshold?: number | undefined;
      } & SessionScopedPayload;
    }
  | { type: 'context.mode.delete'; payload: { id: string } & SessionScopedPayload }
  | WSModelSwitch
  | { type: 'providers.list' }
  | { type: 'provider.models'; payload: { providerId: string } }
  | { type: 'providers.saved' }
  | { type: 'key.add'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.update'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.delete'; payload: { providerId: string; label: string } }
  | { type: 'key.set_active'; payload: { providerId: string; label: string } }
  | {
      type: 'provider.add';
      payload: {
        id: string;
        family: string;
        baseUrl?: string | undefined;
        apiKey?: string | undefined;
      };
    }
  | { type: 'provider.remove'; payload: { providerId: string } }
  | { type: 'provider.clear_models'; payload: { providerId: string } }
  | { type: 'provider.undo_clear'; payload: { providerId: string; previousModels: string[] } }
  | {
      type: 'provider.update';
      payload: {
        id: string;
        family?: string | undefined;
        baseUrl?: string | undefined;
        envVars?: string[] | undefined;
        models?: string[] | undefined;
      };
    }
  | { type: 'provider.probe'; payload: { providerId: string; timeoutMs?: number | undefined } }
  | { type: 'auth.oauth.start'; payload: { kind: OAuthKind; providerId?: string | undefined } }
  | { type: 'auth.oauth.code'; payload: { kind: OAuthKind; input: string } }
  | { type: 'auth.oauth.cancel'; payload: { kind: OAuthKind } }
  | { type: 'tools.list' }
  | { type: 'memory.list' }
  | { type: `agent-roster.${string}`; payload?: Record<string, unknown> | undefined }
  // ── Sage send types ──
  | { type: 'memory.sage.list' }
  | {
      type: 'memory.sage.listPage';
      payload: {
        statuses?: string[] | undefined;
        kind?: string | undefined;
        query?: string | undefined;
        limit?: number | undefined;
        cursor?: string | undefined;
      };
    }
  | { type: 'memory.sage.get'; payload: { id: string } }
  | { type: 'memory.sage.graph'; payload: { query: string; maxDepth?: number; limit?: number } }
  | {
      type: 'memory.sage.update';
      payload: {
        id: string;
        text?: string | undefined;
        tags?: string[] | undefined;
        kind?: string | undefined;
        status?: SageStatus | undefined;
        importance?: number | undefined;
        confidence?: number | undefined;
        freshness?: number | undefined;
        anchors?: SageAnchor[] | undefined;
        audience?: { roles?: string[]; taskTypes?: string[]; modes?: string[] } | undefined;
        supersedes?: string[] | undefined;
        contradicts?: string[] | undefined;
      };
    }
  | {
      type: 'memory.sage.delete';
      payload: { id: string; reason?: string | undefined; neverInject?: boolean | undefined };
    }
  | {
      type: 'memory.sage.recover';
      payload: { id: string; reason?: string | undefined };
    }
  | {
      type: 'memory.sage.candidateResolve';
      payload: {
        candidateId: string;
        action: 'accept' | 'reject';
        reason?: string | undefined;
      };
    }
  | {
      type: 'memory.sage.backfillRecoverable';
      payload: {
        apply: boolean;
        kinds?: string[] | undefined;
        scopes?: string[] | undefined;
        updatedAfter?: string | undefined;
        updatedBefore?: string | undefined;
      };
    }
  | {
      type: 'memory.sage.forFile';
      payload: WSMemorySageForFileRequest;
    }
  | {
      type: 'memory.sage.remember';
      payload: {
        text: string;
        kind?: string | undefined;
        scope?: SageScope | undefined;
        tags?: string[] | undefined;
        importance?: number | undefined;
        confidence?: number | undefined;
        freshness?: number | undefined;
        anchors?: SageAnchor[] | undefined;
        audience?: { roles?: string[]; taskTypes?: string[]; modes?: string[] } | undefined;
        supersedes?: string[] | undefined;
        contradicts?: string[] | undefined;
      };
    }
  | { type: 'skills.list' }
  | { type: 'skills.content'; payload: { name: string; source: string } }
  | { type: 'prompts.list' }
  | {
      type: 'prompts.search';
      payload: { query?: string | undefined; category?: string | undefined };
    }
  | { type: 'prompts.content'; payload: { slug: string } }
  | { type: 'prompts.favorite'; payload: { slug: string; favorite: boolean } }
  | { type: 'prompts.used'; payload: { slug: string } }
  | { type: 'prompts.recent' }
  | {
      type: 'prompts.create';
      payload: {
        title: string;
        content: string;
        description?: string | undefined;
        category?: string | undefined;
        tags?: string[] | undefined;
        variables?:
          | {
              name: string;
              description?: string | undefined;
              required?: boolean | undefined;
              multiline?: boolean | undefined;
              enum?: string[] | undefined;
            }[]
          | undefined;
      };
    }
  | { type: 'diag.get'; payload?: SessionScopedPayload }
  | { type: 'stats.get'; payload?: SessionScopedPayload }
  | { type: 'chronicle.query'; payload: { query?: ChronicleQuery | undefined } }
  | {
      type: 'chronicle.facet';
      payload: {
        field: ChronicleFacet;
        query?: ChronicleQuery | undefined;
        limit?: number | undefined;
      };
    }
  | {
      type: 'chronicle.facets';
      payload: {
        fields: ChronicleFacet[];
        query?: ChronicleQuery | undefined;
        limit?: number | undefined;
      };
    }
  | { type: 'chronicle.graph'; payload: { seed: ChronicleQuery; hops?: number; maxNodes?: number } }
  | {
      type: 'chronicle.metrics';
      payload: {
        view?: ChronicleMetricsView | undefined;
        from?: string | undefined;
        to?: string | undefined;
        path?: string | undefined;
        taskId?: string | undefined;
        boardId?: string | undefined;
        sessionId?: string | undefined;
        status?: string | undefined;
        limit?: number | undefined;
      };
    }
  | { type: 'session.save'; payload?: SessionScopedPayload }
  | { type: 'sessions.list'; payload: { limit: number } & SessionScopedPayload }
  | { type: 'session.delete'; payload: { id: string } }
  | { type: 'session.rename'; payload: { id: string; name: string } }
  | { type: 'modes.list' }
  | { type: 'mode.switch'; payload: { id: string } }
  | {
      type: 'files.list';
      payload: {
        query?: string | undefined;
        limit?: number | undefined;
        path?: string | undefined;
      };
    }
  | { type: 'files.tree'; payload: { path?: string | undefined } | Record<string, never> }
  | { type: 'files.read'; payload: { filePath: string } }
  | { type: 'files.write'; payload: { filePath: string; content: string } }
  | WSCompletionRequest
  | { type: 'todos.get'; payload?: SessionScopedPayload }
  | { type: 'todos.clear'; payload?: SessionScopedPayload }
  | {
      type: 'todos.remove';
      payload: { id?: string | undefined; index?: number | undefined } & SessionScopedPayload;
    }
  | {
      type: 'todo.update';
      payload: {
        id: string;
        status?: 'pending' | 'in_progress' | 'completed' | undefined;
        activeForm?: string | undefined;
      } & SessionScopedPayload;
    }
  | { type: 'tasks.get'; payload?: SessionScopedPayload }
  | { type: 'task.update'; payload: { id: string; status: string } & SessionScopedPayload }
  | { type: 'plan.get'; payload?: SessionScopedPayload }
  | {
      type: 'plan.item.update';
      payload: { target: string; status: 'open' | 'in_progress' | 'done' } & SessionScopedPayload;
    }
  | { type: 'ping' }
  | { type: 'process.list' }
  | { type: 'process.kill'; payload: { pid: number } }
  | { type: 'process.killAll' }
  | { type: 'git.info' }
  | { type: 'git.changes' }
  | { type: 'git.diff'; payload: { path: string } }
  | { type: 'goal.get' }
  | { type: 'goal-state.get' }
  | { type: 'autonomy.switch'; payload: { mode: string } }
  | { type: 'prefs.update'; payload: Record<string, unknown> }
  | { type: 'prefs.get' }
  | { type: 'projects.list' }
  | { type: 'projects.add'; payload: { root: string; name?: string | undefined } }
  | { type: 'projects.select'; payload: { root: string; name?: string | undefined } }
  | { type: 'working_dir.set'; payload: { path: string } }
  | { type: 'shell.open'; payload: { path: string; target: 'terminal' | 'file-manager' } }
  | WSCollabJoin
  | WSCollabLeave
  | WSCollabAnnotate
  | WSCollabResolve
  | WSCollabRequestPause
  | WSCollabResume
  | WSCollabGrantControl
  | WSCollabInjectTool
  | {
      type: 'mailbox.send';
      payload: {
        requestId: string;
        to: string;
        type:
          | 'note'
          | 'ask'
          | 'assign'
          | 'steer'
          | 'btw'
          | 'broadcast'
          | 'status'
          | 'result'
          | 'review';
        audience: 'all' | 'leaders';
        subject: string;
        body: string;
        priority: 'low' | 'normal' | 'high';
        replyTo?: string | undefined;
      };
    }
  | {
      type: 'mailbox.messages';
      payload: {
        limit?: number | undefined;
        agentId?: string | undefined;
        unreadOnly?: boolean | undefined;
        incompleteOnly?: boolean | undefined;
      };
    }
  | {
      type: 'mailbox.agents';
      payload: { onlineOnly?: boolean | undefined } | Record<string, never>;
    }
  | { type: 'mailbox.clear' }
  | {
      type: 'mailbox.purge';
      payload?: { completedMaxAgeMs?: number; incompleteMaxAgeMs?: number } | undefined;
    }
  | {
      type: 'mailbox.compact';
      payload?: { readMaxAgeMs?: number; defaultTtlMs?: number } | undefined;
    }
  | { type: 'brain.status' }
  | { type: 'brain.risk'; payload: { level: string } }
  | { type: 'brain.ask'; payload: { question: string } }
  | { type: 'brain.config.get' }
  | { type: 'brain.config.set'; payload: { patch: BrainConfigPatchWire } }
  | {
      type: 'model.refine';
      payload: {
        text: string;
        /** Retry window override (ms). Set on the auto-retry after a timeout. */
        timeoutMs?: number | undefined;
        /** Refine on this provider/model instead of the session's — ephemeral, no session switch. */
        provider?: string | undefined;
        model?: string | undefined;
        /** Previous refinement when the user asks the preview to try again better. */
        previousRefined?: string | undefined;
        previousEnglish?: string | undefined;
        retryFeedback?: string | undefined;
      };
    }
  | { type: 'skills.list' }
  | { type: 'skills.content'; payload: { name: string; source: string } }
  | { type: 'skills.install'; payload: { ref: string; global?: boolean } }
  | { type: 'skills.uninstall'; payload: { name: string; global?: boolean } }
  | { type: 'skills.update'; payload: { name?: string; global?: boolean } }
  | {
      type: 'skills.create';
      payload: { name: string; description: string; scope: 'project' | 'global' };
    }
  | { type: 'skills.export'; payload?: Record<string, unknown> }
  | { type: 'skills.edit'; payload: { name: string; body: string } }
  // ── Design Studio client messages ────────────────────────────────────────────
  | { type: 'design.list' }
  | {
      type: 'design.use';
      payload: {
        kit: string;
        stack?: string | undefined;
        overrides?: Record<string, string> | undefined;
      };
    }
  | { type: 'design.state' }
  | { type: 'design.set'; payload: { overrides: Record<string, string> } }
  | {
      type: 'design.tune';
      payload: {
        tune: {
          radius?: string | undefined;
          density?: string | undefined;
          font?: string | undefined;
          motion?: string | undefined;
        };
      };
    }
  | {
      type: 'design.swap';
      payload: { kit: string; stack?: string | undefined };
    }
  | {
      type: 'design.materialize';
      payload?: { stack?: string | undefined; out?: string | undefined } | undefined;
    }
  | { type: 'design.verify' }
  | { type: 'config.doctor'; payload?: { apply?: boolean } | undefined }
  // ── MCP client messages (requests to server) ─────────────────────────────────
  | { type: 'mcp.list' }
  | {
      type: 'mcp.add';
      payload: {
        name: string;
        transport: string;
        description?: string;
        enabled?: boolean;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        allowedTools?: string[];
        url?: string;
        headers?: Record<string, string>;
        lazy?: boolean;
      };
    }
  | { type: 'mcp.remove'; payload: { name: string } }
  | {
      type: 'mcp.update';
      payload: {
        name: string;
        transport?: string;
        description?: string;
        enabled?: boolean;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        allowedTools?: string[];
        url?: string;
        headers?: Record<string, string>;
        lazy?: boolean;
      };
    }
  | { type: 'mcp.wake'; payload: { name: string } }
  | { type: 'mcp.sleep'; payload: { name: string } }
  | { type: 'mcp.discover'; payload: { name: string } }
  | { type: 'mcp.enable'; payload: { name: string } }
  | { type: 'mcp.disable'; payload: { name: string } }
  | { type: 'mcp.restart'; payload: { name: string } }
  | { type: 'mcp.resources'; payload: { name: string; refresh?: boolean } }
  | { type: 'mcp.prompts'; payload: { name: string; refresh?: boolean } }
  | { type: 'mcp.resource.read'; payload: { name: string; uri: string } }
  | {
      type: 'mcp.prompt.get';
      payload: { name: string; prompt: string; arguments?: Record<string, string> };
    }
  // ── Integrated terminal (node-pty) client messages ───────────────────────────
  | {
      type: 'terminal.create';
      payload: { id: string; cols?: number | undefined; rows?: number | undefined };
    }
  | { type: 'terminal.input'; payload: { id: string; data: string } }
  | { type: 'terminal.resize'; payload: { id: string; cols: number; rows: number } }
  | { type: 'terminal.close'; payload: { id: string } }
  // ── Tool management client messages ─────────────────────────────────────────
  | { type: 'tools.list' }
  | { type: 'tool.enable'; payload: { name: string } }
  | { type: 'tool.disable'; payload: { name: string } }
  | { type: `kanban.${string}`; payload?: Record<string, unknown> | undefined }
  // ── Misc client messages ─────────────────────────────────────────────────────
  | { type: 'plan.template_use'; payload: { template: string } }
  | { type: 'webui.shutdown' };

export type WSClientMessage = WSClientMessageCore;

export type WSServerMessage =
  | WSSessionStart
  | WSSessionEnd
  | WSTextDelta
  | WSThinkingDelta
  | WSToolUseStart
  | WSToolProgress
  | WSToolExecuted
  | WSCodeMapToolStarted
  | WSCodeMapToolExecuted
  | WSIterationStarted
  | WSIterationCompleted
  | WSIterationLimitReached
  | WSProviderResponse
  | WSProviderRetry
  | WSProviderError
  | WSProviderFallback
  | WSProviderStatusChanged
  | WSProviderActiveBlocked
  | WSProviderStreamError
  | WSRunResult
  | WSSessionStats
  | WSError
  | WSToolConfirmNeeded
  | WSTrustPersisted
  | WSToolLoopDetected
  | WSDelegateStarted
  | WSDelegateCompleted
  | WSContextDebug
  | WSContextCompacted
  | WSCompactionFailed
  | WSContextRepaired
  | WSContextPct
  | WSContextMaxContext
  | WSTokenThreshold
  | WSTokenCostEstimateUnavailable
  | WSContextModesList
  | WSContextModeChanged
  | WSToolsList
  | WSMemoryList
  | WSMemorySageList
  | WSMemorySageListPage
  | WSMemorySageGet
  | WSMemorySageGraph
  | WSMemorySageUpdate
  | WSMemorySageRemember
  | WSMemorySageDelete
  | WSMemorySageRecover
  | WSMemorySageCandidateResolve
  | WSMemorySageBackfillRecoverable
  | WSMemorySageForFile
  | WSSkillsList
  | WSSkillContent
  | WSDesignList
  | WSDesignUse
  | WSDesignState
  | WSDesignSet
  | WSDesignTune
  | WSDesignSwap
  | WSDesignMaterialize
  | WSDesignVerify
  | WSSkillsInstalled
  | WSSkillsUninstalled
  | WSSkillsUpdated
  | WSSkillsCreated
  | WSSkillsEdited
  | WSSkillsExported
  | WSDiagGet
  | WSStatsGet
  | { type: 'chronicle.query_result'; payload: ChronicleQueryResult }
  | {
      type: 'chronicle.facet_result';
      payload: {
        field: ChronicleFacet;
        values: ChronicleFacetValue[];
        diagnostics: { sourceFiles: number; invalidLines: number };
      };
    }
  | {
      type: 'chronicle.facets_result';
      payload: {
        values: Partial<Record<ChronicleFacet, ChronicleFacetValue[]>>;
        diagnostics: { sourceFiles: number; invalidLines: number };
      };
    }
  | { type: 'chronicle.graph_result'; payload: ChronicleGraphResult }
  | { type: 'chronicle.metrics_result'; payload: ChronicleMetricsResultPayload }
  | { type: 'chronicle.error'; payload: { message: string } }
  | WSSessionsList
  | WSProviderCatalog
  | WSProviderModels
  | WSSavedProviders
  | WSProviderProbe
  | WSKeyOperationResult
  | WSAuthOAuthStatus
  | WSFilesList
  | { type: 'files.tree'; payload: { root: string; tree: unknown[]; error?: string | undefined } }
  | {
      type: 'files.read';
      payload: { filePath: string; content: string; error?: string | undefined };
    }
  | {
      type: 'files.written';
      payload: { filePath: string; success: boolean; error?: string | undefined };
    }
  | WSCompletionResult
  | WSTodosUpdated
  | WSTodosCleared
  | { type: 'tasks.updated'; payload: { tasks: unknown[]; error?: string | undefined } }
  | { type: 'plan.updated'; payload: { plan: unknown | null; error?: string | undefined } }
  | WSModesList
  | WSGoalState
  | WSGoalProgress
  | WSGoalLifecycle
  | WSGoalList
  | { type: 'specs.list'; payload: { specs: unknown[] } }
  | { type: 'specs.detail'; payload: Record<string, unknown> }
  | { type: 'sdd.board.snapshot'; payload: Record<string, unknown> | null }
  | { type: 'sdd.board.list'; payload: { boards: unknown[] } }
  | {
      type: 'sdd.board.lifecycle_result';
      payload: {
        op: 'cleanup_worktrees' | 'rollback' | 'destroy';
        ok: boolean;
        removed?: number;
        reverted?: number;
        deleted?: string[];
        reason?: string;
      };
    }
  | { type: 'sdd.spec.snapshot'; payload: Record<string, unknown> }
  | { type: 'sdd.spec.agent_text'; payload: { text: string } }
  | { type: 'sdd.spec.error'; payload: { message: string } }
  | { type: 'sdd.run.started'; payload: { runId: string } }
  | WSEternalIteration
  | WSAgentTimelineMessage
  | WSAgentStatusChanged
  | WSKanbanResult
  | WSKanbanTaskActivity
  | {
      type: 'subagent.event';
      payload: SessionScopedPayload & Record<string, unknown> & { kind: string };
    }
  | WSWorktreeState
  | WSWorktreeEvent
  | WSWorktreeOrphans
  | WSWorktreeCleanupResult
  | WSWorktreeMergeResult
  | WSWorktreeDiffResult
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabEvent
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | {
      type: 'session.checkpoints';
      payload: {
        checkpoints: Array<{
          index: number;
          iteration: number;
          timestamp: string;
          label: string;
          messageCount: number;
          tokens: number;
        }>;
      };
    }
  | { type: 'goal-state.updated'; payload: Record<string, unknown> | null }
  | { type: 'prefs.updated'; payload: Record<string, unknown> }
  | { type: 'techstack.job.started'; payload: { jobId: string; kind: 'inventory' | 'analyze' } }
  | {
      type: 'techstack.job.progress';
      payload: { jobId: string; phase: string; completed: number; total: number };
    }
  | {
      type: 'techstack.workspace.completed';
      payload: { jobId: string; workspaceId: string; ecosystem: string; dependencyCount: number };
    }
  | {
      type: 'techstack.snapshot.updated';
      payload: {
        snapshot: import('@/stores/techstack-store').TechStackSnapshot;
        stale?: boolean | undefined;
      };
    }
  | { type: 'techstack.report.ready'; payload: { reportId: string; summary?: string | undefined } }
  | { type: 'techstack.report.delivered'; payload: { deliveryId: string; sessionId: string } }
  | { type: 'techstack.job.failed'; payload: { jobId: string; error: string } }
  | { type: 'techstack.job.cancelled'; payload: { jobId: string } }
  | { type: 'client.status_update'; payload: Record<string, unknown> }
  | { type: 'sessions.status_update'; payload: { sessions: unknown[] } }
  | { type: 'mailbox.event'; payload: Record<string, unknown> & { event: string } }
  | { type: 'mailbox.received'; payload: Record<string, unknown> }
  | { type: 'mailbox.agent_registered'; payload: Record<string, unknown> }
  // Server replies to the client's mailbox.messages / mailbox.agents
  // requests. Handled via the string-keyed dispatch map today, but they must
  // be in this union so typed `.on()` / useWsHandlers narrowing can express
  // them (a typed migration would otherwise silently drop mailbox data).
  | {
      type: 'mailbox.messages';
      payload: { messages: Array<Record<string, unknown>>; error?: string | undefined };
    }
  | {
      type: 'mailbox.agents';
      payload: { agents: Array<Record<string, unknown>>; error?: string | undefined };
    }
  | {
      type: 'mailbox.sent';
      payload: {
        requestId: string;
        success: boolean;
        messageId?: string | undefined;
        to?: string | undefined;
        audience?: 'all' | 'leaders' | undefined;
        error?: string | undefined;
      };
    }
  // Reply to a client `ping` (liveness probe). The payload is absent on the
  // wire; typed as optional so union-wide `msg.payload` access keeps
  // compiling.
  | { type: 'pong'; payload?: Record<string, unknown> | undefined }
  | {
      type: 'process.list';
      payload: {
        processes: Array<{
          pid: number;
          command: string;
          tool: string;
          startedAt: number;
          status: 'running' | 'exited' | 'killed';
          protected?: boolean | undefined;
          background?: boolean | undefined;
        }>;
      };
    }
  | WSSideEffects
  | {
      type: 'git.info';
      payload: {
        branch: string;
        added: number;
        deleted: number;
        untracked: number;
        behind: number;
        ahead: number;
      };
    }
  | {
      type: 'git.changes';
      payload: {
        files: Array<{
          path: string;
          status: string;
          added: number;
          deleted: number;
          staged: boolean;
        }>;
        error?: string | undefined;
      };
    }
  | {
      type: 'git.diff';
      payload: {
        path: string;
        oldText?: string | undefined;
        newText?: string | undefined;
        binary?: boolean | undefined;
        tooLarge?: boolean | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'projects.list';
      payload: {
        projects: Array<{
          name: string;
          root: string;
          slug: string;
          lastSeen?: string | undefined;
        }>;
      };
    }
  | {
      type: 'projects.added';
      payload: { name: string; root: string; slug: string; message: string };
    }
  | { type: 'projects.selected'; payload: { root: string; name: string; message: string } }
  | { type: 'working_dir.changed'; payload: { cwd: string; projectRoot: string } }
  | {
      type: 'brain.status';
      payload: {
        maxAutoRisk: string;
        log: Array<{ at: number; kind: string; question: string; outcome: string }>;
        /** Enrichment fields — present when the server wires a BrainRuntime. */
        mode?: 'headless' | 'interactive' | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
        /** EFFECTIVE council judge — undefined when no council is wired. */
        judgeLabel?: string | undefined;
        /** True when that judge is also a seated voter (correlated tie-break). */
        judgeIsVoter?: boolean | undefined;
        ledgerPath?: string | undefined;
      };
    }
  | {
      type: 'brain.config';
      payload: {
        config: BrainConfigWire;
        persisted: boolean;
        error?: string | undefined;
      };
    }
  | {
      type: 'brain.answer';
      payload: SessionScopedPayload & {
        question: string;
        decision: {
          type: string;
          optionId?: string | undefined;
          text?: string | undefined;
          rationale?: string | undefined;
          reason?: string | undefined;
          prompt?: string | undefined;
        };
      };
    }
  | {
      type: 'brain.event';
      payload: SessionScopedPayload & Record<string, unknown> & { event: string };
    }
  | {
      type: 'memory.event';
      payload: SessionScopedPayload & Record<string, unknown> & { event: string };
    }
  | { type: 'file.saved'; payload: SessionScopedPayload & { filePath: string } }
  | {
      type: 'codemap.file_event';
      payload: SessionScopedPayload & {
        filePath: string;
        operation: 'read' | 'write' | 'edit' | 'delete' | 'rename';
        phase: 'started' | 'completed' | 'changed';
        source: 'tool' | 'editor' | 'deterministic' | 'watcher' | 'external';
        at: number;
        traceId?: string | undefined;
        agentId?: string | undefined;
        agentName?: string | undefined;
        toolUseId?: string | undefined;
        toolName?: string | undefined;
        line?: number | undefined;
        endLine?: number | undefined;
      };
    }
  | {
      type: 'codemap.index_updated';
      payload: {
        at: number;
        ready: boolean;
        reason: 'index_complete';
      };
    }
  | { type: 'session.damaged'; payload: { sessionId: string; detail: string } }
  | {
      type: 'session.rewound';
      payload: SessionScopedPayload & {
        toPromptIndex: number;
        revertedFiles: string[];
        removedEvents: number;
      };
    }
  | {
      type: 'checkpoint.written';
      payload: SessionScopedPayload & {
        promptIndex: number;
        promptPreview: string;
        ts: string;
        fileCount: number;
      };
    }
  | { type: 'in_flight.started'; payload: SessionScopedPayload & { context: string; ts: string } }
  | {
      type: 'in_flight.ended';
      payload: SessionScopedPayload & { reason: 'clean' | 'aborted' | 'recovered'; ts: string };
    }
  | {
      type: 'model.refine_result';
      payload: {
        refined: string;
        english: string;
        error?: string | undefined;
        /** Machine-readable failure class driving client recovery (undefined on success). */
        errorKind?: 'timeout' | 'empty' | 'provider_error' | undefined;
        /** Suggested window (ms) for a retry after a timeout. */
        retryTimeoutMs?: number | undefined;
        /** One-key "retry with another model" offer (provider/model), if any. */
        fallbackRef?: string | undefined;
        /** The provider/model that produced this result (echoes an ephemeral retry). */
        refinedWith?: { provider: string; model: string } | undefined;
      };
    }
  // ── Coordinator / autonomous fleet events ──────────────────────────────
  | {
      type: 'coordinator.status';
      payload: {
        status: 'idle' | 'running' | 'draining' | 'stopped';
        mode?: string;
        subagentCount?: number;
        taskQueue?: { pending: number; running: number; completed: number; failed: number };
      };
    }
  | {
      type: 'coordinator.stats';
      payload: SessionScopedPayload & {
        total: number;
        running: number;
        idle: number;
        stopped: number;
        inFlight: number;
        pending: number;
        completed: number;
        subagentStatuses?: Array<{
          id: string;
          name: string;
          status: string;
          currentTask?: string;
        }>;
      };
    }
  | {
      type: 'fleet.concurrency_update';
      payload: SessionScopedPayload & { fleetConcurrency: number; fleetConcurrencyMax: number };
    }
  | {
      type: 'budget.threshold_reached';
      payload: SessionScopedPayload & {
        subagentId: string;
        taskId?: string;
        ts: number;
        kind: string;
        used: number;
        limit: number;
        timeoutMs: number;
      };
    }
  | {
      type: 'budget.decision';
      payload: {
        subagentId: string;
        kind: string;
        decision: 'extend' | 'deny';
        extended?: { timeoutMs?: number; maxIterations?: number; maxToolCalls?: number };
      };
    }
  | {
      type: 'subagent.budget_extended';
      payload: { subagentId: string; kind: string; extendedMs?: number; extendedTo?: number };
    }
  | {
      type: 'consensus.vote_initiated';
      payload: {
        changeId: string;
        title: string;
        eligible: Array<{ agentId: string; agentName: string }>;
      };
    }
  | {
      type: 'consensus.vote_cast';
      payload: { changeId: string; voterId: string; value: 'approve' | 'reject' | 'abstain' };
    }
  | {
      type: 'consensus.vote_resolved';
      payload: {
        changeId: string;
        result: 'approved' | 'rejected' | 'vetoed' | 'quorum_not_met';
        approveCount: number;
        rejectCount: number;
      };
    }
  | { type: 'task.pending'; payload: { taskId: string; description: string; priority?: number } }
  | { type: 'task.started'; payload: { taskId: string; subagentId: string } }
  | {
      type: 'task.completed';
      payload: { taskId: string; subagentId: string; status: string; durationMs: number };
    }
  | { type: 'task.failed'; payload: { taskId: string; subagentId: string; error: string } }
  | { type: 'tool.disabled'; payload: { name: string; ok: boolean } }
  | { type: 'tool.enabled'; payload: { name: string; ok: boolean } }
  // ── MCP server events ───────────────────────────────────────────────────────
  | {
      type: 'config.doctor.result';
      payload: {
        success: boolean;
        applied: boolean;
        changed: boolean;
        changes: Array<{ path: string; action: 'added' | 'replaced' }>;
        configPath: string;
        backupPath?: string;
        error?: string;
      };
    }
  | {
      type: 'mcp.list';
      payload: {
        servers: Array<{
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          error?: string;
          pid?: number;
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          health?: {
            healthState: 'disabled' | 'dormant' | 'connecting' | 'healthy' | 'degraded' | 'failed';
            consecutiveFailures: number;
            failures: { transport: number; protocol: number; tool: number };
            reconnectCount: number;
            wakeCount: number;
            sleepCount: number;
            restartCount: number;
            inFlightCalls: number;
            peakInFlightCalls: number;
            callLatency: { count: number; lastMs?: number; p50Ms?: number; p95Ms?: number };
          };
        }>;
      };
    }
  | {
      type: 'mcp.server.added';
      payload: {
        server: {
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
        };
      };
    }
  | { type: 'mcp.server.removed'; payload: { name: string } }
  | {
      type: 'mcp.server.updated';
      payload: {
        server: {
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
        };
      };
    }
  | { type: 'mcp.server.discovered'; payload: { name: string; tools: string[] } }
  | { type: 'mcp.server.sleeping'; payload: { name: string } }
  | { type: 'mcp.server.waking'; payload: { name: string } }
  | { type: 'mcp.server.connected'; payload: { name: string; pid?: number; toolCount?: number } }
  | { type: 'mcp.server.reconnected'; payload: { name: string; toolCount: number } }
  | { type: 'mcp.server.disconnected'; payload: { name: string; reason: string } }
  | { type: 'mcp.server.error'; payload: { name: string; error: string } }
  | { type: 'mcp.operation_result'; payload: { success: boolean; message: string } }
  | {
      type: 'mcp.resources';
      payload: {
        name: string;
        resources: Array<{
          uri: string;
          name: string;
          description?: string;
          mimeType?: string;
          size?: number;
        }>;
        resourceTemplates: Array<{
          uriTemplate: string;
          name: string;
          description?: string;
          mimeType?: string;
        }>;
      };
    }
  | {
      type: 'mcp.prompts';
      payload: {
        name: string;
        prompts: Array<{
          name: string;
          description?: string;
          arguments?: Array<{ name: string; description?: string; required?: boolean }>;
        }>;
      };
    }
  | {
      type: 'mcp.content.selected';
      payload: {
        kind: 'resource' | 'prompt';
        untrusted: true;
        byteSize: number;
        provenance: {
          origin: 'mcp';
          serverName: string;
          capability: 'resource' | 'prompt';
          resourceUri?: string;
          promptName?: string;
          promptArgumentNames?: string[];
        };
        contents?: unknown[];
        messages?: unknown[];
        description?: string;
      };
    }
  | {
      type: 'mcp.content.error';
      payload: { action: string; name: string; error: string };
    }
  | { type: 'mailbox.cleared'; payload: { error?: string | undefined } }
  | { type: 'mailbox.purged'; payload: Record<string, unknown> & { error?: string | undefined } }
  // ── Cron plugin events — state snapshots and job lifecycle ──────────────────
  | {
      type: 'cron.snapshot';
      payload: {
        count: number;
        maxConcurrent: number;
        jobs: Array<{
          name: string;
          intervalMs: number;
          action: string;
          enabled: boolean;
          lastRun: string | null;
          nextRun: string;
          runCount: number;
          overdue: boolean;
        }>;
      };
    }
  | {
      type: 'cron.job_fired';
      payload: { name: string; action: string; runCount: number; ts: string };
    }
  // ── Integrated terminal (node-pty) server events ──────────────────────────────
  | { type: 'terminal.output'; payload: { id: string; data: string } }
  | {
      type: 'terminal.exit';
      payload: { id: string; exitCode: number; signal?: number | undefined };
    };

// Helper to broadcast to all clients
export type BroadcastFn = (msg: WSServerMessage) => void;

/** Narrow type for CollabPanel event handlers — only collab-related messages + errors. */
export type CollabPanelMessage =
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | WSError;

// ── Collaboration (Phase 1 of idea #13) ────────────────────────────────────
// Passive read-only session observer: a second client can join an active
// agent run and watch a live mirror of the kernel's iteration / tool /
// subagent events. Annotation and control hand-off land in Phase 2/3.

/**
 * Roles a collaboration participant can hold. The string union is the
 * wire contract — adding new roles (e.g. `controller`) in later phases
 * is a backward-compatible widening of this type as long as the server
 * gracefully rejects roles it does not yet implement.
 */
export type CollabRole = 'observer' | 'annotator' | 'controller';

// ── Client → Server ───────────────────────────────────────────────────────

export interface WSCollabJoin {
  type: 'collab.join';
  payload: { sessionId: string; role: CollabRole };
}

export interface WSCollabLeave {
  type: 'collab.leave';
  payload: { sessionId: string };
}

/**
 * Annotate a specific event in the session log. The `atEventIndex`
 * is a stable pointer the UI can scroll to / highlight. The server
 * persists the annotation and broadcasts it to every participant
 * in the same session, including the author.
 */
export interface WSCollabAnnotate {
  type: 'collab.annotate';
  payload: { sessionId: string; atEventIndex: number; text: string };
}

/** Mark an existing annotation as resolved. */
export interface WSCollabResolve {
  type: 'collab.resolve';
  payload: { sessionId: string; annotationId: string };
}

// ── Server → Client ───────────────────────────────────────────────────────

/** Sent on connect and every 2s while at least one participant is watching. */
export interface WSCollabState {
  type: 'collab.state';
  payload: {
    sessionId: string;
    participants: Array<{
      participantId: string;
      role: CollabRole;
      joinedAt: string;
    }>;
  };
}

/** Broadcast when a new participant joins the session. */
export interface WSCollabParticipantJoined {
  type: 'collab.participant.joined';
  payload: {
    participantId: string;
    sessionId: string;
    role: CollabRole;
    joinedAt: string;
  };
}

/** Broadcast when a participant leaves (explicit leave or WS close/error). */
export interface WSCollabParticipantLeft {
  type: 'collab.participant.left';
  payload: { participantId: string; sessionId: string };
}

/** Broadcast when a new annotation is added. Sent to all participants. */
export interface WSCollabAnnotationAdded {
  type: 'collab.annotation.added';
  payload: {
    sessionId: string;
    annotation: {
      id: string;
      atEventIndex: number;
      authorId: string;
      authorRole: 'annotator';
      text: string;
      createdAt: string;
      resolved: boolean;
    };
  };
}

/** Broadcast when an annotation is resolved. Sent to all participants. */
export interface WSCollabAnnotationResolved {
  type: 'collab.annotation.resolved';
  payload: {
    sessionId: string;
    annotationId: string;
    resolvedBy: string;
    resolvedAt: string;
  };
}

// ── Controller (Phase 3) ───────────────────────────────────────────────────
// The `controller` role can request a pause on the agent loop, resume
// it, and (later) inject manual tool calls. The pause/resume state is
// process-wide (single agent run per webui); the bus carries it.

/** Client → server: controller asks the agent loop to pause before the next tool call. */
export interface WSCollabRequestPause {
  type: 'collab.request_pause';
  payload: { sessionId: string };
}

/** Client → server: controller (or owner) clears the pause. */
export interface WSCollabResume {
  type: 'collab.resume';
  payload: { sessionId: string };
}

/**
 * Client → server: owner hands the controller role to a different
 * participant. The current implementation is metadata-only — the
 * existing controller's effective permissions don't change yet;
 * the wire is reserved for a future iteration where per-participant
 * RBAC becomes dynamic.
 */
export interface WSCollabGrantControl {
  type: 'collab.grant_control';
  payload: { sessionId: string; toParticipant: string };
}

/** Server → client: the bus transitioned to paused (controller's pause took effect). */
export interface WSCollabPauseGranted {
  type: 'collab.pause.granted';
  payload: {
    sessionId: string;
    pausedBy: string;
    pausedAt: string;
    /**
     * How long until the middleware auto-resumes (in ms). Clients
     * can render a countdown. Defaults to 60_000 on the server.
     */
    autoResumeInMs: number;
  };
}

/** Server → client: the bus transitioned back to running. */
export interface WSCollabPauseReleased {
  type: 'collab.pause.released';
  payload: {
    sessionId: string;
    /** 'controller' when a participant asked; 'timeout' when the middleware fired auto-resume. */
    reason: 'controller' | 'timeout';
    at: string;
  };
}

/**
 * Generic envelope wrapping a kernel event mirrored to observers.
 * `kind` matches the original kernel event name (e.g. `tool.started`),
 * `payload` is the original event payload (best-effort serialized),
 * `at` is the broadcast timestamp.
 *
 * `replay` is true when the event was sent from the on-disk session
 * log to a late-joining observer (Phase 1.5). Live events leave it
 * undefined. Clients use the flag to render a "history" affordance
 * (e.g. dim the styling or annotate the timestamp as "[joined late]").
 */
export interface WSCollabEvent {
  type: 'collab.event';
  payload: { kind: string; payload: unknown; at: string; replay?: boolean | undefined };
}

// ── Phase 4: manual tool-call injection (controller only) ───────────────────

/**
 * Client → server: a controller injects a synthetic tool_result for
 * the given tool_use_id. The next time the agent's toolCall pipeline
 * sees that id, the real tool is skipped and the injected content
 * is used. The injection is one-shot — consumed on first match.
 */
export interface WSCollabInjectTool {
  type: 'collab.inject_tool';
  payload: {
    sessionId: string;
    toolUseId: string;
    /** String or JSON-serializable value. */
    content: unknown;
    isError: boolean;
    /** Free-form context surfaced in the broadcast and audit log. */
    reason: string;
  };
}

/**
 * Server → client: an injection was queued or consumed. Sent to
 * every participant so observers can show "the controller just
 * replaced the tool result for tool X".
 */
export interface WSCollabInjectionGranted {
  type: 'collab.injection.granted';
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    authorId: string;
    reason: string;
    isError: boolean;
    /** 'queued' or 'consumed' — the bus does both. */
    phase: 'queued' | 'consumed';
    at: string;
  };
}
