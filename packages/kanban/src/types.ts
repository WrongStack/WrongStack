/**
 * Project-scoped multi-kanban data model.
 *
 * Boards are owned by the project Kanban server and persisted in its SQLite
 * database. Client processes access them only through IPC.
 * The model is intentionally provider-free: LLMs can manipulate kanban data
 * through tools, but core CRUD stays deterministic and file-based.
 */
export type KanbanTaskPriority = 'critical' | 'high' | 'medium' | 'low';
/** Kind of work a task represents (mirrors core's TaskType). Optional/persisted;
 *  when unset it is inferred at task-graph export from the title/description. */
export type KanbanTaskType = 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';

export type KanbanTaskStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'completed'
  | 'failed'
  | 'archived';

export type KanbanTaskQueueBucket =
  | 'claimable'
  | 'stage_blocked'
  | 'detail_incomplete'
  | 'dependency_blocked'
  | 'queued'
  | 'queued_expired'
  | 'running_live'
  | 'running_expired'
  | 'running_no_lease'
  | 'review'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'completed'
  | 'archived'
  | 'not_dispatchable';

export interface KanbanTaskQueueClassification {
  bucket: KanbanTaskQueueBucket;
  reasons: string[];
  claimable: boolean;
  managedStage?: KanbanLifecycleStage | undefined;
}

export interface KanbanQueueClassificationSummary {
  counts: Record<KanbanTaskQueueBucket, number>;
  diagnostics: Array<{
    boardId: string;
    taskId: string;
    bucket: KanbanTaskQueueBucket;
    reasons: string[];
    managedStage?: KanbanLifecycleStage | undefined;
  }>;
}

export interface KanbanDecompositionSubtask {
  title: string;
  description?: string | undefined;
  /** Free-text success criteria; mapped to KanbanCheck[] on apply. */
  successCriteria?: string[] | undefined;
  expectedFileChanges?: KanbanExpectedFileChange[] | undefined;
  /** Intra-proposal DAG edges: indexes of proposal subtasks this one depends on. */
  dependsOnIndex?: number[] | undefined;
}

/**
 * Latest decomposition proposal for a task, persisted ON the task so every
 * `{board}` broadcast carries the full approval state for the WebUI.
 */
export interface KanbanDecompositionProposal {
  id: string;
  taskId: string;
  status: 'proposed' | 'approved' | 'rejected' | 'applied';
  mode: 'auto' | 'approval';
  proposedSubtasks: KanbanDecompositionSubtask[];
  rationale?: string | undefined;
  proposedAt: string;
  proposedBy?: string | undefined;
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
  resolutionReason?: string | undefined;
  appliedChildTaskIds?: string[] | undefined;
}

/** How a Kanban scope violation is handled at execution time. */
export type KanbanBoundaryEnforcement = 'confirm' | 'block';

/** Policy for tools whose filesystem effects cannot be proven from structured paths. */
export type KanbanBoundaryShellAccess = 'allow' | 'confirm' | 'block';

/** Human-readable selector kind. All selector paths are project-root relative. */
export type KanbanBoundarySelectorKind = 'file' | 'directory' | 'package' | 'glob';

export type KanbanBoundaryAccess = 'read' | 'write' | 'read_write';

/** A file, directory, workspace package, or glob admitted/denied by a boundary policy. */
export interface KanbanBoundarySelector {
  kind: KanbanBoundarySelectorKind;
  /** Project-root-relative path. `package` is a semantic directory selector. */
  path: string;
  access: KanbanBoundaryAccess;
  note?: string | undefined;
}

/**
 * Board/task filesystem boundary. Board and task policies are both evaluated;
 * a task can narrow its board's scope but cannot silently widen it.
 */
export interface KanbanBoundaryPolicy {
  enabled: boolean;
  enforcement: KanbanBoundaryEnforcement;
  /** Shell and opaque filesystem tools need an explicit policy. */
  shellAccess: KanbanBoundaryShellAccess;
  /** Empty allow means "no allowlist" so deny-only policies remain useful. */
  allow: KanbanBoundarySelector[];
  deny?: KanbanBoundarySelector[] | undefined;
}

export type KanbanCheckType =
  | 'manual'
  | 'auto'
  | 'agent'
  | 'test'
  | 'review'
  | 'command'
  | 'file_exists'
  | 'file_matches'
  | 'git_diff'
  | 'metric'
  | 'council';

export type KanbanCheckStatus = 'pending' | 'passed' | 'failed' | 'skipped';
/**
 * Post-execution check result status.
 * Unlike `KanbanCheckStatus`, 'pending' is inapplicable because this
 * always represents a completed verification run, and 'error' captures
 * runtime failures that did not produce a deterministic outcome.
 */
export type KanbanCheckReportStatus = 'passed' | 'failed' | 'skipped' | 'error';

export type KanbanLinkType =
  | 'issue'
  | 'pr'
  | 'doc'
  | 'commit'
  | 'design'
  | 'file'
  | 'url'
  | 'other';

export type KanbanAgentRunStatus =
  | 'assigned'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type KanbanGoalMetricStatus = 'pending' | 'met' | 'missed' | 'waived';

/**
 * Which way a goal metric counts as "met".
 * - `at_least` (default): met when `current >= target` — coverage, feature count.
 * - `at_most`: met when `current <= target` — error rate, cost ceiling, latency,
 *   open-bug count. Omitting `direction` means `at_least`, so existing boards
 *   are unaffected.
 */
export type KanbanGoalMetricDirection = 'at_least' | 'at_most';

export type KanbanRetryPolicy = 'off' | 'incremental' | 'exponential';

export type KanbanManualActivityKind =
  | 'decision'
  | 'attempt'
  | 'result'
  | 'blocker'
  | 'observation';

export type KanbanManualActivityOutcome =
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'skipped'
  | 'unknown';

export interface RecordKanbanTaskActivityInput {
  kind: KanbanManualActivityKind;
  summary: string;
  outcome?: KanbanManualActivityOutcome | undefined;
  details?: string | undefined;
}

/** How an agent assigned to a task obtains its primary model. */
export type KanbanModelRoutingMode = 'session' | 'fixed' | 'fallback_profile';

/**
 * Persisted, inspectable execution route. Keeping the mode explicit avoids the
 * old ambiguity where an empty provider/model could mean either "use session"
 * or "configuration was forgotten".
 */
export interface KanbanExecutionRouting {
  mode: KanbanModelRoutingMode;
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
}

export type KanbanSupervisorMode = 'deterministic' | 'agentic';

/** Board-level policy for the quiet Kanban supervisor. */
export interface KanbanSupervisorConfig {
  /** Undefined config is treated as enabled deterministic supervision. */
  enabled: boolean;
  /** Deterministic reconciliation is always performed; agentic adds an LLM anomaly review. */
  mode: KanbanSupervisorMode;
  /** Audit cadence. Hosts clamp this to a safe minimum. */
  intervalMs?: number | undefined;
  /** Minimum delay between agentic anomaly reviews. */
  agentCooldownMs?: number | undefined;
  /** What to do with expired assignment leases. */
  recoveryMode?: KanbanRecoveryMode | undefined;
  /** Explicit model source for an agentic review. */
  routing?: KanbanExecutionRouting | undefined;
  /** Agent skills whose instructions must be injected into an agentic review. */
  skills?: string[] | undefined;
}

export type KanbanSupervisorStatus = 'disabled' | 'healthy' | 'attention' | 'running' | 'error';

/** Ephemeral runtime snapshot returned by the hosting surface. */
export interface KanbanSupervisorSnapshot {
  boardId: string;
  status: KanbanSupervisorStatus;
  mode: KanbanSupervisorMode;
  lastAuditAt?: string | undefined;
  lastAgentRunAt?: string | undefined;
  nextAuditAt?: string | undefined;
  reconciledTaskIds: string[];
  staleRecoveredTaskIds: string[];
  anomalyCount: number;
  summary?: string | undefined;
  error?: string | undefined;
}

/**
 * Sprint 2 recovery mode surface. `'auto'` defers per-task mode to
 * `selectRecoveryMode` based on the configured `RecoverStaleKanbanAssignmentsInput.policy`.
 * Explicit modes keep the historical semantics:
 *   - `'release'` clears the assignment and returns the task to ready/blocked.
 *   - `'retry'` increments attempt and re-queues unless `maxAttempts` is exhausted.
 *   - `'fail'` marks the assignment failed (retry budget exhausted).
 */
export type KanbanRecoveryMode = 'auto' | 'release' | 'retry' | 'fail';

/**
 * Optional policy that biases per-task recovery decisions. When present and
 * `RecoverStaleKanbanAssignmentsInput.mode === 'auto'`, each stale task gets
 * a per-task mode derived from its assignment metadata, the queue health
 * signal summary for the task's board, and the policy rules below.
 */
export interface KanbanRecoveryPolicy {
  /** When true, prefer `fail` over `retry` for tasks whose `costCeilingUsd` is set. */
  failWhenCostCeilingSet?: boolean | undefined;
  /** When set, prefer `release` for tasks whose `lastFailureKind` matches any of these. */
  releaseOnFailureKinds?: string[] | undefined;
  /** When true, also `release` if the heartbeat-due signal mentions this task. Default: false. */
  releaseOnHeartbeatDue?: boolean | undefined;
  /** Incremental/exponential/off hint returned for cost boundary diagnostics. */
  retryPolicyOverride?: KanbanRetryPolicy | undefined;
}

export interface KanbanAgentAssignment {
  agentId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** Explicit source used to resolve provider/model for this run. */
  modelRouting?: KanbanModelRoutingMode | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** Agentic skills that are force-loaded into the worker prompt. */
  skills?: string[] | undefined;
  tools?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
  status: KanbanAgentRunStatus;
  dispatchedAt?: string | undefined;
  completedAt?: string | undefined;
  leaseId?: string | undefined;
  claimedAt?: string | undefined;
  heartbeatAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  /** Sprint 2: cost ceiling for this assignment in USD; 0/undefined means unbounded. */
  costCeilingUsd?: number | undefined;
  /** Sprint 2: which retry strategy the recovery router should follow. */
  retryPolicy?: KanbanRetryPolicy | undefined;
  /** Sprint 2: last failure kind observed by the worker, used by routing hints. */
  lastFailureKind?: string | undefined;
  subagentId?: string | undefined;
  runTaskId?: string | undefined;
  lastResult?: string | undefined;
  error?: string | undefined;
}

/** Escalation mode for a single check that cannot be deterministically verified. */
export type KanbanCheckEscalationMode = 'none' | 'agent' | 'council';

export interface KanbanCheck {
  id: string;
  description: string;
  type: KanbanCheckType;
  status: KanbanCheckStatus;
  checkedBy?: string | undefined;
  checkedAt?: string | undefined;
  notes?: string | undefined;
  /**
   * Escalation mode for this check. 'none' (default) means this check's
   * type must have a deterministic verifier. 'agent' or 'council' delegates
   * to an LLM-based verifier that must still produce concrete evidence.
   */
  escalation?: KanbanCheckEscalationMode | undefined;
}

export interface KanbanLink {
  url: string;
  title?: string | undefined;
  type: KanbanLinkType;
}

export interface KanbanNote {
  id: string;
  author: string;
  content: string;
  createdAt: string;
}

export interface KanbanEvent {
  id: string;
  boardId: string;
  type: string;
  ts: string;
  taskId?: string | undefined;
  actor?: string | undefined;
  /** Session that initiated or observed this task mutation, when known. */
  sessionId?: string | undefined;
  before?: unknown;
  after?: unknown;
  correlationId?: string | undefined;
  subagentId?: string | undefined;
  runTaskId?: string | undefined;
  note?: string | undefined;
}

/**
 * Board-level history entry — survives board deletion.
 *
 * Unlike per-board KanbanEvent rows (which live in `<boardId>.events.jsonl` /
 * the `kanban_events` table and are destroyed when the board is deleted), the
 * board history is a global, append-only log. It records the lifecycle of
 * every board in the project: creation, updates, duplication, lifecycle
 * adoption, and deletion. After a board is deleted, its history entries remain
 * so an operator can still see "this board existed, was created on X, deleted
 * on Y."
 */
export interface KanbanBoardHistoryEntry {
  id: string;
  boardId: string;
  /** Snapshot of the board title at the time of the event (boards can be renamed). */
  boardTitle: string;
  type: string;
  ts: string;
  actor?: string | undefined;
  note?: string | undefined;
  /** Structured details about the change (which fields were updated, source/target ids, etc.). */
  after?: unknown;
}

/** Request-scoped identity copied into durable Kanban activity events. */
export interface KanbanEventContext {
  actor?: string | undefined;
  sessionId?: string | undefined;
  correlationId?: string | undefined;
  /** Human or system explanation for why this mutation happened. */
  note?: string | undefined;
  /**
   * Fencing token for ownership-checked writes. When set, the mutation is
   * applied only if the task's current `assignment.leaseId` matches — checked
   * inside the board mutation lock so a recovered-and-reassigned task cannot
   * be overwritten by a stale owner. Omit to preserve legacy unconditional
   * behavior.
   */
  expectedLeaseId?: string | undefined;
}

/** Task-scoped file telemetry folded into the durable Kanban activity ledger. */
export interface KanbanTaskFileActivityInput {
  operation: 'create' | 'read' | 'update' | 'delete' | 'rename';
  filePath: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  provider: string;
  model: string;
  toolName: string;
  toolUseId: string;
  durationMs?: number | undefined;
  fileSize?: number | undefined;
  lines?: number | undefined;
  bytes?: number | undefined;
}

export interface KanbanGoalMetric {
  id: string;
  name: string;
  status: KanbanGoalMetricStatus;
  target?: string | number | undefined;
  current?: string | number | undefined;
  direction?: KanbanGoalMetricDirection | undefined;
  unit?: string | undefined;
  notes?: string | undefined;
  updatedAt?: string | undefined;
}

export interface KanbanTaskChainRef {
  chainId: string;
  order: number;
  previousTaskId?: string | undefined;
  nextTaskId?: string | undefined;
}

export interface KanbanTaskOrigin {
  system: string;
  graphId?: string | undefined;
  phaseId?: string | undefined;
  taskId?: string | undefined;
  /** Requirement within specId implemented by this task (not the spec id itself). */
  specRequirementId?: string | undefined;
  specId?: string | undefined;
}

export interface KanbanRequirementScope {
  graphId: string;
  specId: string;
  sourceSystem: string;
  requirementIds: string[];
  updatedAt: string;
}

export type KanbanLifecycleStage = 'backlog' | 'todo' | 'running' | 'review' | 'done';

export interface KanbanLifecycleColumns {
  backlog: string;
  todo: string;
  running: string;
  review: string;
  done: string;
}

export interface KanbanBoardLifecyclePolicy {
  /** Legacy boards retain unrestricted/custom projection behavior. */
  mode: 'legacy' | 'managed';
  /** Explicit roles avoid unreliable inference from column titles or task status. */
  columns: KanbanLifecycleColumns;
  /** Audit metadata set when a legacy board adopts the managed lifecycle. */
  adoptedAt?: string | undefined;
  adoptedBy?: string | undefined;
  adoptionComment?: string | undefined;
  /** Review cards older than this are surfaced by Kanban Cleaner. */
  staleReviewAfterMs?: number | undefined;
  /**
   * Whether a passing verification accepts the card into Done on its own.
   *
   * `undefined` means enabled — the historical behavior, kept so adopting this
   * field changes nothing for existing boards. Set `false` on a board that
   * wants a human (or a reviewer agent) to make the final call: verification
   * still runs and still persists its report, but the card waits in Review for
   * an explicit `transitionTask`.
   *
   * This never loosens the gate. A failing or missing verdict cannot reach
   * Done regardless of this setting — see `validateDefinitionOfDone`.
   */
  autoAccept?: boolean | undefined;
}

export interface KanbanLifecycleTransition {
  from?: KanbanLifecycleStage | undefined;
  to: KanbanLifecycleStage;
  at: string;
  actor: string;
  action?: string | undefined;
  comment?: string | undefined;
  attachment?: KanbanLink | undefined;
}

export interface KanbanTaskLifecycle {
  currentStage: KanbanLifecycleStage;
  stageEnteredAt: string;
  /** Authoritative board-local ledger; persisted atomically with the card. */
  history: KanbanLifecycleTransition[];
}

export interface KanbanTask {
  id: string;
  title: string;
  description?: string | undefined;
  dueDate?: string | undefined;
  columnId: string;
  order: number;
  priority: KanbanTaskPriority;
  /** Kind of work (feature/bugfix/…); persisted when set, else inferred on export. */
  type?: KanbanTaskType | undefined;
  status: KanbanTaskStatus;
  assignedAgent?: string | undefined;
  assignee?: string | undefined;
  assignment?: KanbanAgentAssignment | undefined;
  dependsOn?: string[] | undefined;
  chain?: KanbanTaskChainRef | undefined;
  parentTaskId?: string | undefined;
  childTaskIds?: string[] | undefined;
  mergedIntoTaskId?: string | undefined;
  mergedFromTaskIds?: string[] | undefined;
  origin?: KanbanTaskOrigin | undefined;
  successCriteria?: KanbanCheck[] | undefined;
  goalMetrics?: KanbanGoalMetric[] | undefined;
  labels?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  estimatedHours?: number | undefined;
  actualHours?: number | undefined;
  /**
   * Sprint 3: durable task-level retry policy that survives claim/release cycles.
   * Set during assignTask, used as fallback when assignment.retryPolicy is absent.
   */
  retryPolicy?: KanbanRetryPolicy | undefined;
  /**
   * Sprint 3: durable task-level cost ceiling that survives claim/release cycles.
   * Set during assignTask, used as fallback when assignment.costCeilingUsd is absent.
   */
  costCeilingUsd?: number | undefined;
  links?: KanbanLink[] | undefined;
  notes?: KanbanNote[] | undefined;
  lifecycle?: KanbanTaskLifecycle | undefined;
  /** Additional task-level boundary; always evaluated together with the board boundary. */
  boundary?: KanbanBoundaryPolicy | undefined;
  /**
   * Verification: when true, this task requires atomic decomposition into child
   * tasks with explicit success criteria, formal verification before completion,
   * and blocks review→done until verifyTaskCompletion() passes.
   * Default false. Only set explicitly via split_atomic or update_task.
   */
  atomic?: boolean | undefined;
  /**
   * Expected file changes for this task. When set, the verifier checks that
   * the actual git diff between start and completion matches these expectations.
   * Each entry declares a path and what operation is expected.
   */
  expectedFileChanges?: KanbanExpectedFileChange[] | undefined;
  /**
   * Immutable verification report written by verifyTaskCompletion().
   * Persisted atomically with the board mutation so it is never partially written.
   * Once populated, it is the single source of truth for this task's verification.
   */
  verificationReport?: KanbanVerificationReport | undefined;
  /**
   * Latest deterministic atomicity assessment. Advisory metadata: it never
   * changes the `atomic` flag's meaning and is only enforced when the board's
   * atomicity policy mode is 'enforce'.
   */
  atomicityAssessment?: KanbanAtomicityAssessment | undefined;
  /** Latest decomposition proposal lifecycle for this task. */
  decomposition?: KanbanDecompositionProposal | undefined;
  /**
   * How many times the completion gate has refused this card, across
   * assignments. Distinct from `assignment.attempt`, which counts worker
   * dispatches: a card can be dispatched once and refused three times, or
   * dispatched three times and refused once. Reset by a passing verification.
   */
  verificationAttempts?: number | undefined;
  /**
   * Set when the refusal budget ran out. Present means "retrying this
   * unchanged is pointless" — see {@link KanbanTaskPark}.
   */
  park?: KanbanTaskPark | undefined;
}

/** Expected file operation for a task's verification scope. */
export interface KanbanExpectedFileChange {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  /** Optional: human-readable note about why this change is expected. */
  note?: string | undefined;
}

/**
 * Immutable snapshot of a completed verification run.
 * Written atomically into the authoritative board record inside the owner transaction.
 */
export interface KanbanVerificationReport {
  taskId: string;
  taskTitle: string;
  boardId: string;
  startedAt: string;
  completedAt: string;
  /** Overall verdict. */
  verdict: 'passed' | 'failed' | 'needs_human' | 'incomplete';
  /** Every check evaluated, in order. */
  checks: KanbanVerificationCheckResult[];
  /** File-scope analysis. */
  fileScope?: KanbanVerificationFileScope | undefined;
  /** Sub-task aggregation (only when task.atomic === true). */
  subtasks?: KanbanVerificationSubtasks | undefined;
  /** Human-readable Markdown summary. */
  markdownSummary: string;
  /** Raw evidence attachments. */
  attachments: KanbanVerificationAttachment[];
  /**
   * Attempt counter from the assignment that produced the verified work.
   * Lets a reviewer tell apart "re-verified attempt 3" from "first attempt
   * that was never run." Optional and backwards-compatible: older reports
   * simply omit it.
   */
  attempt?: number | undefined;
  /**
   * Lease id of the assignment that owned the work. Ties the report to a
   * specific claim so a stale owner's evidence cannot be confused with the
   * current owner's.
   */
  leaseId?: string | undefined;
  /**
   * Board revision at the moment verification ran. Binds the report to a
   * specific version of the task contract so a later edit cannot silently
   * re-frame an old verdict.
   */
  taskRevision?: number | undefined;
  /**
   * Git baseline captured for the file-scope diff. The eventual goal is to
   * capture this at dispatch/claim time (before the worker touches files)
   * rather than at verification time; for now it records whichever snapshot
   * the VerificationContext held when the report was built, preserving the
   * prior behaviour while making the binding explicit and queryable.
   */
  baseline?: KanbanVerificationBaseline | undefined;
  /**
   * Criterion ids the verifier actually exercised with a passing result. Used
   * by `validateDefinitionOfDone` to skip the per-check `passed` gate when
   * the verifier is already authoritative — without this list the agent has
   * to duplicate bookkeeping by calling `update_check` after a successful
   * `verify_completion` run.
   *
   * Backwards-compatible: absent on older reports and on reports produced by
   * the empty-check fast path; both behave exactly as before.
   */
  coveredCheckIds?: string[] | undefined;
}

export interface KanbanVerificationBaseline {
  /** Snapshot id (randomUUID assigned by VerificationContext.captureSnapshot). */
  id: string;
  /** `git rev-parse HEAD` at capture time (empty for an unborn repo). */
  commitHash: string;
  /** `git write-tree` of the full tracked+untracked worktree at capture time. */
  treeHash: string;
  /** ISO timestamp of the capture. */
  capturedAt: string;
}

export interface KanbanBackingRef {
  kind: 'file' | 'test' | 'command' | 'diff';
  path: string;
  summary: string;
}

export interface KanbanVerificationCheckResult {
  checkId: string;
  description: string;
  type: KanbanCheckType;
  /**
   * Post-execution snapshot status. Unlike `KanbanCheckStatus` (which includes
   * 'pending'), this report is always the result of a completed verification
   * run so 'pending' is inapplicable and 'error' captures runtime failures.
   */
  status: 'passed' | 'failed' | 'skipped' | 'error';
  /** Structured evidence payload (depends on check type). */
  evidence: Record<string, unknown>;
  error?: string | undefined;
  /** For agent/council checks: concrete proof references. */
  backingRefs?: KanbanBackingRef[] | undefined;
}

export interface KanbanVerificationFileScope {
  expectedChanges: number;
  actualChanges: number;
  scopeMatches: boolean;
  files: Array<{
    path: string;
    operation: 'create' | 'modify' | 'delete';
    expected: boolean;
    linesChanged: number;
  }>;
}

export interface KanbanVerificationSubtasks {
  total: number;
  completed: number;
  failed: number;
  children: Array<{
    taskId: string;
    title: string;
    verdict: 'passed' | 'failed' | 'needs_human' | 'incomplete';
  }>;
}

export interface KanbanVerificationAttachment {
  kind: 'file' | 'test_output' | 'command_output' | 'diff';
  label: string;
  /** Truncated content or path reference. */
  content: string;
  /** Full path when the attachment references a file on disk. */
  path?: string | undefined;
}

/**
 * Verdict produced by the deterministic atomicity rule set.
 *   - 'atomic': small enough to work directly; no decomposition needed.
 *   - 'borderline': between thresholds; treated as atomic unless enforced.
 *   - 'needs_decomposition': too large/vague; should be split before dispatch.
 *   - 'composite': already has children; verified via subtask aggregation,
 *     never worked directly.
 */
export type AtomicityVerdict = 'atomic' | 'borderline' | 'needs_decomposition' | 'composite';

/** Per-criterion outcome inside an atomicity assessment. Score 1 = fully atomic on this axis. */
export interface KanbanAtomicityCriterionResult {
  id: string;
  score: number;
  weight: number;
  reason: string;
}

/**
 * Result of scoring a task against the atomicity rule set.
 * Stamped by addTask/splitTask (board policy mode !== 'off') and by the
 * assess_atomicity tool action; purely advisory unless board mode is 'enforce'.
 */
export interface KanbanAtomicityAssessment {
  verdict: AtomicityVerdict;
  /** Weighted aggregate in [0, 1]; 1 = clearly atomic. */
  score: number;
  criteria: KanbanAtomicityCriterionResult[];
  assessedAt: string;
  assessedBy: 'rules' | 'agent' | 'human';
  /** Hash of the rule-set config so stale assessments are detectable after config changes. */
  configHash?: string | undefined;
}

/** Thresholds and weights for the deterministic atomicity rule set. */
export interface AtomicityRuleSetConfig {
  /** A task estimated above this is penalized on the effort axis. Default 4. */
  maxEstimatedHours?: number | undefined;
  /** Expected file changes above this count are penalized. Default 5. */
  maxExpectedFileChanges?: number | undefined;
  /** Dependency fan-in above this count is penalized. Default 3. */
  maxDependencies?: number | undefined;
  /** Conjunction/enumeration markers in title+description above this are penalized. Default 2. */
  maxScopeMarkers?: number | undefined;
  /** Aggregate score at or above this is 'atomic'. Default 0.7. */
  atomicThreshold?: number | undefined;
  /** Aggregate score below this is 'needs_decomposition'. Default 0.45. */
  decomposeThreshold?: number | undefined;
  /** Per-criterion weight overrides; unknown ids are ignored. */
  weights?: Partial<Record<string, number>> | undefined;
}

/**
 * Completion-gate enforcement for a board.
 *   - 'strict': completion is blocked unless verification passes (managed default).
 *   - 'soft': verification runs and its report/warning events persist, but
 *     completion is never blocked (legacy default).
 *   - 'off': the gate is skipped entirely (mirror boards whose source system
 *     already verified, e.g. SDD runs).
 */
export type KanbanCompletionGateEnforcement = 'strict' | 'soft' | 'off';

export interface KanbanCompletionGatePolicy {
  enforcement: KanbanCompletionGateEnforcement;
  /**
   * How many times the gate may refuse one card before it is parked.
   * Defaults to `DEFAULT_MAX_VERIFICATION_ATTEMPTS` (2) — the task-level form
   * of "two failures in the same place means the model is wrong". A value
   * below 1 is treated as 1; parking cannot be disabled by setting 0, because
   * a card that can never park is the wedge this policy exists to prevent.
   */
  maxVerificationAttempts?: number | undefined;
}

/**
 * Why a card stopped being retried.
 *
 * A parked card is deliberately NOT a third status: it stays `blocked`, which
 * every existing readiness, queue, and projection path already understands.
 * This record is the part those paths could not express — that the block came
 * from an exhausted verification budget rather than an unmet dependency, so
 * the next reader knows retrying it unchanged is pointless.
 *
 * Parked is honest, durable, and reversible: clearing it is what `update_task`
 * and a passing verification already do. It is never a completion state.
 */
export interface KanbanTaskPark {
  /** One sentence: what the gate refused, in the words the gate used. */
  reason: string;
  parkedAt: string;
  /** Refusals counted when the budget ran out. */
  attempts: number;
  /** The refusal's validation issues, so the card carries its own evidence. */
  issues?: string[] | undefined;
}

/** Board-level atomicity policy: whether/how tasks are assessed and decomposed. */
export interface KanbanBoardAtomicityPolicy {
  /**
   * 'off' = never assess; 'assess' (default) = annotate only;
   * 'enforce' = additionally, childless needs_decomposition leaves are not
   * ready for claim/dispatch until split.
   */
  mode: 'off' | 'assess' | 'enforce';
  /** 'auto' = apply proposed splits immediately; 'propose' = park for approval. */
  decomposition: 'auto' | 'propose';
  config?: AtomicityRuleSetConfig | undefined;
}

export interface KanbanColumn {
  id: string;
  title: string;
  description?: string | undefined;
  color?: string | undefined;
  order: number;
  wipLimit?: number | undefined;
}

export interface KanbanBoardPresence {
  /** Stable identity inside a board: one row per session + agent pair. */
  id: string;
  sessionId: string;
  agentId: string;
  agentName?: string | undefined;
  taskId?: string | undefined;
  runTaskId?: string | undefined;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Presence is considered active until this deadline; readers recompute `active`. */
  activeUntil: string;
  active: boolean;
}

/**
 * Board kind classifies the purpose and lifecycle of a board.
 * - `project`: durable, user-facing planning board (default for legacy boards)
 * - `session_mirror`: ephemeral board auto-created by session-kanban mirror
 * - `sdd_mirror`: board created by an SDD run
 * - `import`: board created from a task-graph import
 * - `archive`: board that has been archived and should be excluded from default queries
 */
export type KanbanBoardKind = 'project' | 'session_mirror' | 'sdd_mirror' | 'import' | 'archive';

/**
 * Retention policy for automatic board cleanup.
 * - `keep`: never auto-archive or delete (default for project boards)
 * - `archive_after_ttl`: hide from default queries after TTL elapses
 * - `delete_after_ttl`: permanently delete after TTL elapses
 */
export interface KanbanBoardRetentionPolicy {
  mode: 'keep' | 'archive_after_ttl' | 'delete_after_ttl';
  ttlMs?: number | undefined;
  /** Set when the board was actually archived by the retention job. */
  archivedAt?: string | undefined;
}

export interface KanbanBoard {
  id: string;
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  /** Board kind — used by queue/health filtering. Defaults to `project` during normalization. */
  kind?: KanbanBoardKind | undefined;
  /** Automatic retention policy. Session mirrors default to `archive_after_ttl`. */
  retention?: KanbanBoardRetentionPolicy | undefined;
  columns: KanbanColumn[];
  tasks: KanbanTask[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  generatedBy?: string | undefined;
  /** Canonical requirement scope declared by the imported task graph. */
  requiredRequirementIds?: string[] | undefined;
  /** Per-graph scope ledger; prevents independent mirrors from overwriting each other. */
  requirementScopes?: KanbanRequirementScope[] | undefined;
  /** Quiet health/reconciliation policy for this board. */
  supervisor?: KanbanSupervisorConfig | undefined;
  /** Opt-in strict Kanban Agent lifecycle policy. */
  lifecycle?: KanbanBoardLifecyclePolicy | undefined;
  /** Project-resource ceiling applied to every task agent on this board. */
  boundary?: KanbanBoundaryPolicy | undefined;
  /** Atomicity assessment/decomposition policy for tasks on this board. */
  atomicity?: KanbanBoardAtomicityPolicy | undefined;
  /** Completion-gate policy; defaults resolved by resolveGateEnforcement(). */
  completionGate?: KanbanCompletionGatePolicy | undefined;
  /** Goodhart-safe objective/impact/guardrail/evidence graph for autonomous work. */
  contractGraph?: import('./types-operations.js').KanbanContractGraph | undefined;
  /** Sessions and agents that recently read or mutated this board. */
  presence?: KanbanBoardPresence[] | undefined;
  version: number;
  /** Per-write mutation counter for optimistic locking.
   *  Incremented atomically inside `mutateBoard` on every successful write.
   *  Unlike `version` (the immutable schema marker), `revision` changes
   *  on every mutation and is used for stale-write detection. */
  revision?: number | undefined;
  /** Wall-clock timestamp of the most recent successful task dispatch.
   *  Set atomically when a task transitions to `running` (via
   *  `updateTaskAssignment` or claim). Cached here so `getKanbanQueueHealth`
   *  can read it without scanning the entire event log. */
  lastDispatchedAt?: string | undefined;
  /** Wall-clock timestamp of the most recent stale-assignment recovery.
   *  Set atomically by `recoverStaleTaskAssignments`. Cached here so
   *  `getKanbanQueueHealth` can read it without scanning the event log. */
  lastStaleRecoveredAt?: string | undefined;
}

export interface KanbanBoardMeta {
  id: string;
  title: string;
  description?: string | undefined;
  columnCount: number;
  taskCount: number;
  completedTaskCount: number;
  tags?: string[] | undefined;
  kind?: KanbanBoardKind | undefined;
  retention?: KanbanBoardRetentionPolicy | undefined;
  presence?: KanbanBoardPresence[] | undefined;
  createdAt: string;
  updatedAt: string;
  lastActivity?: string | undefined;
}

export type KanbanBoardSummary = Pick<
  KanbanBoard,
  | 'id'
  | 'title'
  | 'description'
  | 'tags'
  | 'kind'
  | 'retention'
  | 'createdAt'
  | 'updatedAt'
  | 'presence'
> & {
  columnCount: number;
  taskCount: number;
  completedTaskCount: number;
  lastActivity?: string | undefined;
};

export * from './types-operations.js';
