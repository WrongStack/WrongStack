import type { SerializedTaskGraph } from '@wrongstack/core/types';
import type {
  AssignKanbanTaskInput,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanBoardSummary,
  KanbanCompletionGateEnforcement,
  KanbanDecompositionSubtask,
  KanbanEvent,
  KanbanLifecycleStage,
  KanbanOrchestrationSnapshot,
  KanbanQueueHealth,
  KanbanSearchResult,
  KanbanTask,
  KanbanTaskPriority,
  KanbanTaskStatus,
  KanbanTaskType,
  KanbanVerificationReport,
  KanbanWorkbenchSnapshot,
} from '@wrongstack/kanban';

export type KanbanAction =
  | 'list_boards'
  | 'get_board'
  | 'create_board'
  | 'duplicate_board'
  | 'update_board'
  | 'adopt_managed_lifecycle'
  | 'release_managed_lifecycle'
  | 'delete_board'
  | 'generate_board'
  | 'export_markdown'
  | 'export_task_graph'
  | 'sync_task_graph'
  | 'create_from_graph'
  | 'import_session_tasks'
  | 'search_tasks'
  | 'ready_tasks'
  | 'snapshot'
  | 'workbench'
  | 'add_column'
  | 'update_column'
  | 'delete_column'
  | 'add_task'
  | 'split_task'
  | 'merge_tasks'
  | 'copy_task'
  | 'transfer_task'
  | 'get_task'
  | 'start_task'
  | 'update_task'
  | 'transition_task'
  | 'repair_managed_projection'
  | 'move_task'
  | 'delete_task'
  | 'set_chain'
  | 'get_chain'
  | 'claim_task'
  | 'release_task'
  | 'assign_task'
  | 'mark_assignment'
  | 'heartbeat_assignment'
  | 'recover_stale'
  | 'events'
  | 'queue_health'
  | 'add_dependency'
  | 'add_goal_metric'
  | 'update_goal_metric'
  | 'add_check'
  | 'update_check'
  | 'add_note'
  | 'add_link'
  | 'verify_completion'
  | 'split_atomic'
  | 'assess_atomicity'
  | 'propose_decomposition';

export interface KanbanToolInput extends Omit<AssignKanbanTaskInput, 'status'> {
  action: KanbanAction;
  boardId?: string | undefined;
  taskId?: string | undefined;
  columnId?: string | undefined;
  targetBoardId?: string | undefined;
  taskIds?: string[] | undefined;
  chainId?: string | undefined;
  fromNodeId?: string | undefined;
  toNodeId?: string | undefined;
  baseline?: string | number | undefined;
  threshold?: string | number | undefined;
  title?: string | undefined;
  description?: string | undefined;
  dueDate?: string | undefined;
  tags?: string[] | undefined;
  labels?: string[] | undefined;
  priority?: KanbanTaskPriority | undefined;
  taskType?: KanbanTaskType | undefined;
  status?: KanbanTaskStatus | undefined;
  order?: number | undefined;
  targetColumnId?: string | undefined;
  moveTasksToColumnId?: string | undefined;
  query?: string | undefined;
  limit?: number | undefined;
  dependencyTaskId?: string | undefined;
  enforceDependencies?: boolean | undefined;
  childTitles?: string[] | undefined;
  inheritAssignment?: boolean | undefined;
  inheritLabels?: boolean | undefined;
  inheritSuccessCriteria?: boolean | undefined;
  inheritGoalMetrics?: boolean | undefined;
  inheritDependencies?: boolean | undefined;
  chainChildren?: boolean | undefined;
  rewireDependents?: boolean | undefined;
  closeSourceTasks?: boolean | undefined;
  metricId?: string | undefined;
  metricName?: string | undefined;
  metricTarget?: string | number | undefined;
  metricCurrent?: string | number | undefined;
  metricUnit?: string | undefined;
  metricStatus?: 'pending' | 'met' | 'missed' | 'waived' | undefined;
  metricNotes?: string | undefined;
  checkId?: string | undefined;
  checkDescription?: string | undefined;
  checkStatus?: 'pending' | 'passed' | 'failed' | 'skipped' | undefined;
  note?: string | undefined;
  author?: string | undefined;
  url?: string | undefined;
  linkTitle?: string | undefined;
  linkType?: 'issue' | 'pr' | 'doc' | 'commit' | 'design' | 'file' | 'url' | 'other' | undefined;
  context?: string | undefined;
  columns?: string[] | undefined;
  generatedBy?: string | undefined;
  includeTasks?: boolean | undefined;
  includeCompletedTasks?: boolean | undefined;
  preserveAssignment?: boolean | undefined;
  preserveDependencies?: boolean | undefined;
  leaseId?: string | undefined;
  expectedLeaseId?: string | undefined;
  claimedAt?: string | undefined;
  heartbeatAt?: string | undefined;
  leaseExpiresAt?: string | undefined;
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  costCeilingUsd?: number | undefined;
  retryPolicy?: 'off' | 'incremental' | 'exponential' | undefined;
  lastFailureKind?: string | undefined;
  subagentId?: string | undefined;
  runTaskId?: string | undefined;
  lastResult?: string | undefined;
  error?: string | undefined;
  assignmentStatus?: KanbanAgentRunStatus | undefined;
  lifecycleStage?: KanbanLifecycleStage | undefined;
  transitionAction?: string | undefined;
  transitionComment?: string | undefined;
  attachmentUrl?: string | undefined;
  attachmentTitle?: string | undefined;
  attachmentType?:
    | 'issue'
    | 'pr'
    | 'doc'
    | 'commit'
    | 'design'
    | 'file'
    | 'url'
    | 'other'
    | undefined;
  releaseStatus?: 'pending' | 'ready' | 'blocked' | undefined;
  releaseReason?: string | undefined;
  clearAssignee?: boolean | undefined;
  recoveryMode?: 'auto' | 'release' | 'retry' | 'fail' | undefined;
  recoveryNow?: string | undefined;
  recoveryPolicyFailOnCostCeiling?: boolean | undefined;
  recoveryPolicyReleaseOnFailureKinds?: string[] | undefined;
  recoveryPolicyReleaseOnHeartbeatDue?: boolean | undefined;
  recoveryPolicyRetryPolicyOverride?: 'off' | 'incremental' | 'exponential' | undefined;
  taskGraph?: unknown;
  graphId?: string | undefined;
  specId?: string | undefined;
  specRequirementId?: string | undefined;
  sourceSystem?: string | undefined;
  phaseId?: string | undefined;
  preserveOriginTaskIds?: boolean | undefined;
  includeArchived?: boolean | undefined;
  archiveMissingTasks?: boolean | undefined;
  preserveManualDependencies?: boolean | undefined;
  /** Full dependency id list for add_task/update_task (superset of dependencyTaskId). */
  dependsOn?: string[] | undefined;
  /** Estimated effort in hours for add_task/update_task. */
  estimatedHours?: number | undefined;
  /** Actual effort in hours for add_task/update_task. */
  actualHours?: number | undefined;
  /** create_board/update_board: atomicity policy mode. */
  atomicityMode?: 'off' | 'assess' | 'enforce' | undefined;
  /** create_board/update_board: how proposed decompositions are applied. */
  atomicityDecomposition?: 'auto' | 'propose' | undefined;
  /** create_board/update_board: completion-gate enforcement. */
  gateEnforcement?: KanbanCompletionGateEnforcement | undefined;
  /** propose_decomposition: 2+ proposed subtasks. */
  subtasks?: KanbanDecompositionSubtask[] | undefined;
}

export interface KanbanToolOutput {
  ok: boolean;
  verdict?: KanbanVerificationReport['verdict'] | undefined;
  gate?:
    | {
        enforcement: KanbanCompletionGateEnforcement;
        allowed: boolean;
        verdict: KanbanVerificationReport['verdict'] | 'skipped';
        issues: string[];
      }
    | undefined;
  message: string;
  board?: KanbanBoard | undefined;
  boards?: KanbanBoardSummary[] | undefined;
  task?: KanbanTask | undefined;
  tasks?: KanbanSearchResult[] | undefined;
  recoveredTasks?: KanbanTask[] | undefined;
  events?: KanbanEvent[] | undefined;
  queueHealth?: KanbanQueueHealth | undefined;
  children?: KanbanTask[] | undefined;
  chain?: KanbanTask[] | undefined;
  snapshot?: KanbanOrchestrationSnapshot | undefined;
  workbench?: KanbanWorkbenchSnapshot | undefined;
  taskGraph?: SerializedTaskGraph | undefined;
  markdown?: string | undefined;
}
