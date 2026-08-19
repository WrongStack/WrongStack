import type {
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanAtomicityAssessment,
  KanbanBoard,
  KanbanBoardAtomicityPolicy,
  KanbanBoardKind,
  KanbanBoardLifecyclePolicy,
  KanbanBoardRetentionPolicy,
  KanbanBoardSummary,
  KanbanBoundaryPolicy,
  KanbanCheck,
  KanbanColumn,
  KanbanCompletionGatePolicy,
  KanbanDecompositionProposal,
  KanbanExpectedFileChange,
  KanbanGoalMetric,
  KanbanGoalMetricStatus,
  KanbanLifecycleColumns,
  KanbanLifecycleStage,
  KanbanLifecycleTransition,
  KanbanLink,
  KanbanModelRoutingMode,
  KanbanNote,
  KanbanQueueClassificationSummary,
  KanbanRecoveryMode,
  KanbanRecoveryPolicy,
  KanbanRetryPolicy,
  KanbanSupervisorConfig,
  KanbanTask,
  KanbanTaskChainRef,
  KanbanTaskLifecycle,
  KanbanTaskOrigin,
  KanbanTaskPriority,
  KanbanTaskStatus,
  KanbanTaskType,
  KanbanVerificationReport,
} from './types.js';
import type { KanbanContractGraphEnforcement } from './types-contract-graph.js';

export type {
  KanbanDecompositionProposal,
  KanbanDecompositionSubtask,
} from './types.js';
export * from './types-contract-graph.js';

export interface CreateKanbanBoardInput {
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  /**
   * Ignored — columns are locked to the 5 standard columns (backlog, todo,
   * in-progress, review, done). Kept on the type for source-compatibility so
   * existing callers compile, but normalizeColumns always returns DEFAULT_COLUMNS.
   */
  columns?: KanbanColumn[] | undefined;
  tasks?: Array<Partial<KanbanTask> & Pick<KanbanTask, 'title'>> | undefined;
  generatedBy?: string | undefined;
  supervisor?: KanbanSupervisorConfig | undefined;
  lifecycle?: KanbanBoardLifecyclePolicy | undefined;
  boundary?: KanbanBoundaryPolicy | undefined;
  atomicity?: KanbanBoardAtomicityPolicy | undefined;
  completionGate?: KanbanCompletionGatePolicy | undefined;
  kind?: KanbanBoardKind | undefined;
  retention?: KanbanBoardRetentionPolicy | undefined;
}

export interface UpdateKanbanBoardInput {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  /**
   * Ignored — columns are locked to the 5 standard columns. Kept on the type
   * for source-compatibility; updateBoard no longer acts on it.
   */
  columns?: KanbanColumn[] | undefined;
  completedAt?: string | null | undefined;
  supervisor?: KanbanSupervisorConfig | null | undefined;
  lifecycle?: KanbanBoardLifecyclePolicy | null | undefined;
  boundary?: KanbanBoundaryPolicy | null | undefined;
  atomicity?: KanbanBoardAtomicityPolicy | null | undefined;
  completionGate?: KanbanCompletionGatePolicy | null | undefined;
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
  dueDate?: string | undefined;
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
  lifecycle?: KanbanTaskLifecycle | undefined;
  boundary?: KanbanBoundaryPolicy | undefined;
  atomic?: boolean | undefined;
  expectedFileChanges?: KanbanExpectedFileChange[] | undefined;
  verificationReport?: KanbanVerificationReport | undefined;
  atomicityAssessment?: KanbanAtomicityAssessment | undefined;
  decomposition?: KanbanDecompositionProposal | undefined;
}

export interface UpdateKanbanTaskInput {
  title?: string | undefined;
  description?: string | undefined;
  dueDate?: string | null | undefined;
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
  lifecycle?: KanbanTaskLifecycle | null | undefined;
  boundary?: KanbanBoundaryPolicy | null | undefined;
  atomic?: boolean | null | undefined;
  expectedFileChanges?: KanbanExpectedFileChange[] | null | undefined;
  verificationReport?: KanbanVerificationReport | null | undefined;
  atomicityAssessment?: KanbanAtomicityAssessment | null | undefined;
  decomposition?: KanbanDecompositionProposal | null | undefined;
}

export interface KanbanTaskTransitionInput {
  to: KanbanLifecycleStage;
  actor: string;
  action?: string | undefined;
  comment?: string | undefined;
  attachment?: KanbanLink | undefined;
  /** Detail fields may be filled atomically with the transition. */
  patch?: Omit<UpdateKanbanTaskInput, 'columnId' | 'status' | 'lifecycle'> | undefined;
  /**
   * Atomically tick acceptance criteria `passed` as part of this transition.
   * Each entry maps a criterion id to the new status; only `manual` criteria
   * may be flipped this way (the verifier owns non-manual ones). This is the
   * recommended escape from `acceptance-criteria-incomplete` on Done: instead
   * of having to read ids from kanban get_task, the refusal diagnostic lists
   * the failing ids directly and the caller can re-issue the same
   * transition with `tickChecks` filled in.
   */
  tickChecks?: { checkId: string; checkStatus: 'passed' | 'failed' | 'skipped' }[] | undefined;
}

export interface AdoptManagedLifecycleInput {
  columns: KanbanLifecycleColumns;
  actor: string;
  comment: string;
}

export interface RepairManagedProjectionInput {
  actor: string;
  comment: string;
}

export interface KanbanTaskTransitionResult {
  board: KanbanBoard;
  task: KanbanTask;
  transition: KanbanLifecycleTransition;
}

export interface KanbanLifecycleValidationIssue {
  code:
    | 'managed-policy-invalid'
    | 'stage-mismatch'
    | 'transition-skipped'
    | 'task-detail-missing'
    | 'review-evidence-missing'
    | 'acceptance-criteria-incomplete'
    | 'contract-graph-incomplete'
    | 'parent-child-incomplete'
    | 'dependency-incomplete'
    | 'requirement-coverage-incomplete'
    | 'wip-limit-exceeded'
    | 'tickChecks-unknown-id'
    | 'running-lease-missing'
    | 'atomic-children-unresolved'
    | 'atomic-children-incomplete';
  field?: string | undefined;
  message: string;
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
  /** When true, set `parent.atomic = true` atomically inside the split mutation. */
  atomic?: boolean | undefined;
  /**
   * Optional per-child detail aligned with `titles` by index. Entries may be
   * sparse; each present entry overrides the inherited description and/or adds
   * child-specific success criteria and expected file changes.
   */
  childSpecs?:
    | Array<
        | {
            description?: string | undefined;
            successCriteria?: KanbanCheck[] | undefined;
            expectedFileChanges?: KanbanExpectedFileChange[] | undefined;
          }
        | undefined
      >
    | undefined;
}

/** One proposed subtask inside a decomposition proposal. */
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
  direction?: KanbanGoalMetric['direction'];
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
  /**
   * Fencing token, same contract as the heartbeat input below: when set,
   * the release applies only while the task's current `assignment.leaseId`
   * matches. Without it a zombie agent whose task was recovered and
   * REASSIGNED could unconditionally delete the LIVE owner's claim.
   * Operator-driven manual releases omit it and stay unconditional.
   */
  expectedLeaseId?: string | undefined;
}

export interface HeartbeatKanbanTaskAssignmentInput {
  heartbeatAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
  /**
   * Fencing token: if set, the heartbeat is applied only when the task's
   * current `assignment.leaseId` matches. This makes lease renewal atomic
   * (checked inside the board mutation lock) so a recovered-and-reassigned
   * task whose leaseId changed cannot be renewed by a stale waiter. When
   * omitted, the legacy unconditional behavior is preserved.
   */
  expectedLeaseId?: string | undefined;
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
    /**
     * Cards whose stored `status` field is literally `'ready'`.
     *
     * This is a raw tally of the status column, not an answer to "what can I
     * start?" — no production code path ever writes that status, so on real
     * boards it is always 0. Use {@link KanbanQueueHealth.counts.startable}
     * for the startable count; it agrees with `listReadyTasks`.
     */
    ready: number;
    /**
     * Cards that can be started right now: not running, queued, completed,
     * archived or failed, and with every dependency satisfied.
     *
     * This is the derived readiness that `listReadyTasks` reports. It exists
     * because every surface that displayed `counts.ready` — the kanban tool's
     * own result message, the WebUI health bar, the HQ view, the routes
     * summary and the supervisor line — showed a permanent 0 while
     * `ready_tasks` on the same board returned work.
     */
    startable: number;
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
  /** Canonical queue classifier diagnostics. Counts are diagnostic; existing count buckets stay unchanged. */
  classifications?: KanbanQueueClassificationSummary | undefined;
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

export type KanbanWorkbenchLane = 'now' | 'next' | 'blocked' | 'review';

export interface KanbanWorkbenchItem {
  boardId: string;
  boardTitle: string;
  boardKind: KanbanBoardKind;
  taskId: string;
  title: string;
  lane: KanbanWorkbenchLane;
  status: KanbanTaskStatus;
  priority: KanbanTaskPriority;
  updatedAt: string;
  reason: string;
  source: 'session' | 'managed';
  assignee?: string | undefined;
  blockedBy?: number | undefined;
  childProgress?: { completed: number; total: number } | undefined;
  contractStatus?: KanbanWorkbenchContractStatus | undefined;
}

export interface KanbanWorkbenchContractStatus {
  enforcement: KanbanContractGraphEnforcement;
  startReady: boolean;
  setupGaps: number;
  completionOpen: number;
  closed: boolean;
}

export interface KanbanWorkbenchLaneSnapshot {
  total: number;
  omitted: number;
  items: KanbanWorkbenchItem[];
}

export interface KanbanWorkbenchAlert {
  id: string;
  severity: 'warning' | 'critical';
  kind: 'stale_running' | 'heartbeat_due' | 'failed_retryable' | 'duplicate_active';
  title: string;
  detail: string;
  boardId?: string | undefined;
  taskId?: string | undefined;
  relatedTaskIds?: string[] | undefined;
}

/**
 * Bounded, cross-board projection for human-facing work surfaces. It is a
 * navigation aid over the authoritative boards, never a second task store.
 */
export interface KanbanWorkbenchSnapshot {
  generatedAt: string;
  boardCount: number;
  totals: {
    active: number;
    now: number;
    next: number;
    blocked: number;
    review: number;
    failed: number;
    completed: number;
  };
  flow: Array<{
    id: 'capture' | 'ready' | 'execute' | 'review' | 'verified';
    label: string;
    count: number;
    explanation: string;
  }>;
  lanes: Record<KanbanWorkbenchLane, KanbanWorkbenchLaneSnapshot>;
  alerts: KanbanWorkbenchAlert[];
  alertTotal: number;
  alertsOmitted: number;
}

export interface GetKanbanWorkbenchInput {
  /** Maximum cards returned per lane. Clamped to 1..50; default 8. */
  limitPerLane?: number | undefined;
  /** Maximum alerts returned. Clamped to 1..50; default 8. */
  alertLimit?: number | undefined;
  now?: string | undefined;
  includeBoardKinds?: KanbanBoardKind[] | undefined;
  excludeBoardKinds?: KanbanBoardKind[] | undefined;
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
  /** Filter boards by kind. Session mirrors and archived boards are excluded by default. */
  includeBoardKinds?: KanbanBoardKind[] | undefined;
  excludeBoardKinds?: KanbanBoardKind[] | undefined;
}

export interface KanbanSearchResult {
  board: KanbanBoardSummary;
  task: KanbanTask;
  contractStatus?: KanbanWorkbenchContractStatus | undefined;
}

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0, color: '#64748b' },
  { id: 'todo', title: 'To Do', order: 1, wipLimit: 0, color: '#2563eb' },
  { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 5, color: '#d97706' },
  { id: 'review', title: 'Review', order: 3, wipLimit: 0, color: '#7c3aed' },
  { id: 'done', title: 'Done', order: 4, wipLimit: 0, color: '#16a34a' },
];

export const CURRENT_KANBAN_VERSION = 1;
