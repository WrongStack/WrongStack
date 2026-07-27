import type {
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanBoardAtomicityPolicy,
  KanbanBoardLifecyclePolicy,
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
  KanbanRecoveryMode,
  KanbanRecoveryPolicy,
  KanbanRetryPolicy,
  KanbanSupervisorConfig,
  KanbanTaskChainRef,
  KanbanTaskLifecycle,
  KanbanTaskOrigin,
  KanbanTask,
  KanbanTaskPriority,
  KanbanTaskStatus,
  KanbanTaskType,
  KanbanVerificationReport,
  KanbanAtomicityAssessment,
} from './types.js';

export type {
  KanbanDecompositionProposal,
  KanbanDecompositionSubtask,
} from './types.js';

export interface CreateKanbanBoardInput {
  title: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  columns?: KanbanColumn[] | undefined;
  tasks?: Array<Partial<KanbanTask> & Pick<KanbanTask, 'title'>> | undefined;
  generatedBy?: string | undefined;
  supervisor?: KanbanSupervisorConfig | undefined;
  lifecycle?: KanbanBoardLifecyclePolicy | undefined;
  boundary?: KanbanBoundaryPolicy | undefined;
  atomicity?: KanbanBoardAtomicityPolicy | undefined;
  completionGate?: KanbanCompletionGatePolicy | undefined;
}

export interface UpdateKanbanBoardInput {
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
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
    | 'acceptance-criteria-incomplete';
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
