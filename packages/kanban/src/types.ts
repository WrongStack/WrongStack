/**
 * Project-scoped multi-kanban data model.
 *
 * Boards are stored as JSON files under `<project>/.wrongstack/kanbans/`.
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

export type KanbanCheckType = 'manual' | 'auto' | 'agent' | 'test' | 'review';

export type KanbanCheckStatus = 'pending' | 'passed' | 'failed' | 'skipped';

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

export type KanbanRetryPolicy = 'off' | 'incremental' | 'exponential';

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

export interface KanbanCheck {
  id: string;
  description: string;
  type: KanbanCheckType;
  status: KanbanCheckStatus;
  checkedBy?: string | undefined;
  checkedAt?: string | undefined;
  notes?: string | undefined;
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
  before?: unknown;
  after?: unknown;
  correlationId?: string | undefined;
  subagentId?: string | undefined;
  runTaskId?: string | undefined;
  note?: string | undefined;
}

export interface KanbanGoalMetric {
  id: string;
  name: string;
  status: KanbanGoalMetricStatus;
  target?: string | number | undefined;
  current?: string | number | undefined;
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
  specId?: string | undefined;
}

export interface KanbanTask {
  id: string;
  title: string;
  description?: string | undefined;
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
}

export interface KanbanColumn {
  id: string;
  title: string;
  description?: string | undefined;
  color?: string | undefined;
  order: number;
  wipLimit?: number | undefined;
}

export interface KanbanBoard {
  id: string;
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  columns: KanbanColumn[];
  tasks: KanbanTask[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  generatedBy?: string | undefined;
  /** Quiet health/reconciliation policy for this board. */
  supervisor?: KanbanSupervisorConfig | undefined;
  version: number;
}

export interface KanbanBoardMeta {
  id: string;
  title: string;
  description?: string | undefined;
  columnCount: number;
  taskCount: number;
  completedTaskCount: number;
  tags?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
  lastActivity?: string | undefined;
}

export type KanbanBoardSummary = Pick<
  KanbanBoard,
  'id' | 'title' | 'description' | 'tags' | 'createdAt' | 'updatedAt'
> & {
  columnCount: number;
  taskCount: number;
  completedTaskCount: number;
  lastActivity?: string | undefined;
};

export interface CreateKanbanBoardInput {
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  columns?: KanbanColumn[] | undefined;
  tasks?: Array<Partial<KanbanTask> & Pick<KanbanTask, 'title'>> | undefined;
  generatedBy?: string | undefined;
  supervisor?: KanbanSupervisorConfig | undefined;
}

export interface UpdateKanbanBoardInput {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  columns?: KanbanColumn[] | undefined;
  completedAt?: string | null | undefined;
  supervisor?: KanbanSupervisorConfig | null | undefined;
}

export interface DuplicateKanbanBoardInput {
  title?: string | undefined;
  includeTasks?: boolean | undefined;
  includeCompletedTasks?: boolean | undefined;
  preserveAssignment?: boolean | undefined;
  generatedBy?: string | undefined;
}

export interface CreateKanbanColumnInput {
  id?: string | undefined;
  title: string;
  description?: string | undefined;
  color?: string | undefined;
  order?: number | undefined;
  wipLimit?: number | undefined;
}

export interface UpdateKanbanColumnInput {
  title?: string | undefined;
  description?: string | undefined;
  color?: string | undefined;
  order?: number | undefined;
  wipLimit?: number | undefined;
}

export interface RemoveKanbanColumnOptions {
  moveTasksToColumnId?: string | undefined;
}

export interface CreateKanbanTaskInput {
  title: string;
  description?: string | undefined;
  columnId?: string | undefined;
  order?: number | undefined;
  priority?: KanbanTaskPriority | undefined;
  type?: KanbanTaskType | undefined;
  status?: KanbanTaskStatus | undefined;
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
  labels?: string[] | undefined;
  estimatedHours?: number | undefined;
  actualHours?: number | undefined;
  retryPolicy?: KanbanRetryPolicy | undefined;
  costCeilingUsd?: number | undefined;
  successCriteria?: KanbanCheck[] | undefined;
  goalMetrics?: KanbanGoalMetric[] | undefined;
  links?: KanbanLink[] | undefined;
  notes?: KanbanNote[] | undefined;
}

export interface UpdateKanbanTaskInput {
  title?: string | undefined;
  description?: string | undefined;
  columnId?: string | undefined;
  order?: number | undefined;
  priority?: KanbanTaskPriority | undefined;
  type?: KanbanTaskType | undefined;
  status?: KanbanTaskStatus | undefined;
  assignedAgent?: string | null | undefined;
  assignee?: string | null | undefined;
  assignment?: KanbanAgentAssignment | null | undefined;
  dependsOn?: string[] | undefined;
  chain?: KanbanTaskChainRef | null | undefined;
  parentTaskId?: string | null | undefined;
  childTaskIds?: string[] | undefined;
  mergedIntoTaskId?: string | null | undefined;
  mergedFromTaskIds?: string[] | undefined;
  origin?: KanbanTaskOrigin | null | undefined;
  labels?: string[] | undefined;
  estimatedHours?: number | undefined;
  actualHours?: number | undefined;
  retryPolicy?: KanbanRetryPolicy | null | undefined;
  costCeilingUsd?: number | null | undefined;
  successCriteria?: KanbanCheck[] | undefined;
  goalMetrics?: KanbanGoalMetric[] | undefined;
  links?: KanbanLink[] | undefined;
}

export interface CopyKanbanTaskOptions {
  targetColumnId?: string | undefined;
  targetOrder?: number | undefined;
  preserveAssignment?: boolean | undefined;
  preserveDependencies?: boolean | undefined;
}

export interface AssignKanbanTaskInput {
  agentId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  modelRouting?: KanbanModelRoutingMode | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  skills?: string[] | undefined;
  tools?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
  assignee?: string | undefined;
  leaseId?: string | undefined;
  claimedAt?: string | undefined;
  heartbeatAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  costCeilingUsd?: number | undefined;
  retryPolicy?: KanbanRetryPolicy | undefined;
  lastFailureKind?: string | undefined;
  status?: KanbanAgentRunStatus | undefined;
}

export interface SplitKanbanTaskInput {
  titles: string[];
  columnId?: string | undefined;
  inheritAssignment?: boolean | undefined;
  inheritLabels?: boolean | undefined;
  inheritSuccessCriteria?: boolean | undefined;
  inheritGoalMetrics?: boolean | undefined;
  inheritDependencies?: boolean | undefined;
  chainChildren?: boolean | undefined;
  rewireDependents?: boolean | undefined;
}

export interface MergeKanbanTasksInput {
  taskIds: string[];
  title: string;
  description?: string | undefined;
  targetColumnId?: string | undefined;
  preserveAssignment?: boolean | undefined;
  closeSourceTasks?: boolean | undefined;
}

export interface SetKanbanTaskChainInput {
  taskIds: string[];
  chainId?: string | undefined;
  enforceDependencies?: boolean | undefined;
}

export interface AddKanbanGoalMetricInput {
  name: string;
  status?: KanbanGoalMetricStatus | undefined;
  target?: string | number | undefined;
  current?: string | number | undefined;
  unit?: string | undefined;
  notes?: string | undefined;
}

export type UpdateKanbanGoalMetricInput = Partial<Omit<KanbanGoalMetric, 'id'>>;

export interface ClaimKanbanTaskInput extends AssignKanbanTaskInput {
  boardId?: string | undefined;
  taskId?: string | undefined;
}

export interface ReleaseKanbanTaskClaimInput {
  status?: 'pending' | 'ready' | 'blocked' | undefined;
  reason?: string | undefined;
  clearAssignee?: boolean | undefined;
}

export interface HeartbeatKanbanTaskAssignmentInput {
  heartbeatAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
}

export type RecoverStaleKanbanAssignmentMode = KanbanRecoveryMode;

export interface RecoverStaleKanbanAssignmentsInput {
  mode?: RecoverStaleKanbanAssignmentMode | undefined;
  now?: string | undefined;
  reason?: string | undefined;
  clearAssignee?: boolean | undefined;
  /** Optional policy biases `'auto'` mode and is ignored for explicit modes. */
  policy?: KanbanRecoveryPolicy | undefined;
}

export interface RecoverStaleKanbanAssignmentsResult {
  board: KanbanBoard;
  tasks: KanbanTask[];
}

export interface ReconcileKanbanBoardResult {
  board: KanbanBoard;
  tasks: KanbanTask[];
}

/**
 * Operational health summary over a Kanban board (or the whole project).
 *
 * This is the single source of truth that recovery loops, dashboards and the
 * `kanban` tool read from before making decisions. Counts are always computed
 * against the *current* board state; signals are derived per-task.
 *
 * `dependencyBlocked` is intentionally separate from `blocked`. A task with
 * `status === 'blocked'` has been explicitly failed or cancelled by a human;
 * a task counted in `dependencyBlocked.tasks` is technically `ready` or
 * `pending` but cannot proceed because of unmet dependencies. WebUI and
 * recovery loops should treat these as distinct queues.
 *
 * `staleAssignments` and `heartbeatDue` are computed against an optional
 * `now` (defaults to real wall clock). `lastDispatchedAt` and
 * `lastStaleRecoveredAt` surface operational slack without requiring callers
 * to scan the append-only event log themselves.
 */
export interface KanbanQueueHealth {
  generatedAt: string;
  boardIds: string[];
  counts: {
    ready: number;
    queued: number;
    running: number;
    review: number;
    failed: number;
    completed: number;
    pending: number;
    archived: number;
    blocked: number;
  };
  /** Tasks that are technically `ready` or `pending` but have unmet dependencies. */
  dependencyBlocked: {
    count: number;
    tasks: KanbanSearchResult[];
  };
  /** Assignments with `leaseExpiresAt <= now` that are still `queued` or `running`. */
  staleAssignments: {
    count: number;
    tasks: KanbanSearchResult[];
  };
  /** `failed` tasks whose `attempt < maxAttempts` and are therefore worth retrying. */
  failedRetryable: {
    count: number;
    tasks: KanbanSearchResult[];
  };
  /** `running` tasks whose lease is about to lapse (within `heartbeatIntervalMs`). */
  heartbeatDue: {
    count: number;
    tasks: KanbanSearchResult[];
  };
  /** Wall-clock timestamps of the most recent dispatch and most recent stale recovery. */
  lastDispatchedAt?: string;
  lastStaleRecoveredAt?: string;
}

export interface KanbanOrchestrationSnapshot {
  generatedAt: string;
  boards: KanbanBoardSummary[];
  ready: KanbanSearchResult[];
  queued: KanbanSearchResult[];
  running: KanbanSearchResult[];
  blocked: KanbanSearchResult[];
  review: KanbanSearchResult[];
  failed: KanbanSearchResult[];
  completed: KanbanSearchResult[];
}

export interface KanbanGenerationInput {
  description: string;
  context?: string | undefined;
  columnCount?: number | undefined;
  columns?: string[] | undefined;
  title?: string | undefined;
}

export interface KanbanSearchInput {
  query?: string | undefined;
  boardId?: string | undefined;
  assignedAgent?: string | undefined;
  status?: KanbanTaskStatus | undefined;
  priority?: KanbanTaskPriority | undefined;
  label?: string | undefined;
  readyOnly?: boolean | undefined;
  chainId?: string | undefined;
}

export interface KanbanSearchResult {
  board: KanbanBoardSummary;
  task: KanbanTask;
}

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0, color: '#64748b' },
  { id: 'todo', title: 'To Do', order: 1, wipLimit: 0, color: '#2563eb' },
  { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 5, color: '#d97706' },
  { id: 'review', title: 'Review', order: 3, wipLimit: 0, color: '#7c3aed' },
  { id: 'done', title: 'Done', order: 4, wipLimit: 0, color: '#16a34a' },
];

export const CURRENT_KANBAN_VERSION = 1;
