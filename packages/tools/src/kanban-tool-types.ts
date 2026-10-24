import type { SerializedTaskGraph } from '@wrongstack/contracts/types';
import type {
  AssignKanbanTaskInput,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanBoardHistoryEntry,
  KanbanBoardSummary,
  KanbanCompletionGateEnforcement,
  KanbanContractEdgeType,
  KanbanContractEnforcement,
  KanbanContractGraph,
  KanbanContractGraphEnforcement,
  KanbanContractGraphEvaluation,
  KanbanContractNodeKind,
  KanbanContractNodeState,
  KanbanDecompositionSubtask,
  KanbanEvent,
  KanbanLifecycleStage,
  KanbanManualActivityKind,
  KanbanManualActivityOutcome,
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
  | 'stats'
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
  | 'board_history'
  | 'record_activity'
  | 'queue_health'
  | 'add_dependency'
  | 'add_goal_metric'
  | 'update_goal_metric'
  | 'add_check'
  | 'update_check'
  | 'remove_check'
  | 'add_note'
  | 'review_task'
  | 'add_link'
  | 'verify_completion'
  | 'split_atomic'
  | 'assess_atomicity'
  | 'propose_decomposition'
  | 'approve_decomposition'
  | 'reject_decomposition'
  | 'get_contract_graph'
  | 'configure_contract_graph'
  | 'upsert_contract_node'
  | 'remove_contract_node'
  | 'add_contract_edge'
  | 'remove_contract_edge';

/**
 * Actions that never write board state. Presence tracking (itself a write)
 * is skipped for these. Keep in sync with the kanban-mcp read tier, which
 * asserts equality with this list.
 */
export const KANBAN_READ_ONLY_ACTIONS = [
  'list_boards',
  'get_board',
  'export_markdown',
  'export_task_graph',
  'search_tasks',
  'ready_tasks',
  'snapshot',
  'workbench',
  'stats',
  'get_task',
  'get_chain',
  'events',
  'board_history',
  'queue_health',
  'get_contract_graph',
] as const satisfies readonly KanbanAction[];

export interface KanbanToolInput extends Omit<AssignKanbanTaskInput, 'status'> {
  action: KanbanAction;
  boardId?: string | undefined;
  taskId?: string | undefined;
  columnId?: string | undefined;
  targetBoardId?: string | undefined;
  taskIds?: string[] | undefined;
  chainId?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  dueDate?: string | undefined;
  tags?: string[] | undefined;
  labels?: string[] | undefined;
  /** Singular label filter — takes precedence over the first entry of `labels`. */
  label?: string | undefined;
  priority?: KanbanTaskPriority | undefined;
  taskType?: KanbanTaskType | undefined;
  status?: KanbanTaskStatus | undefined;
  order?: number | undefined;
  targetColumnId?: string | undefined;
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
  /** Comparison direction for the goal metric: `at_least` (default) or `at_most`. */
  metricDirection?: 'at_least' | 'at_most' | undefined;
  metricUnit?: string | undefined;
  metricStatus?: 'pending' | 'met' | 'missed' | 'waived' | undefined;
  metricNotes?: string | undefined;
  checkId?: string | undefined;
  reviewDisposition?: 'adequate' | 'enriched' | 'needs_leader' | undefined;
  checkDescription?: string | undefined;
  checkStatus?: 'pending' | 'passed' | 'failed' | 'skipped' | undefined;
  /**
   * Verifier type for an acceptance criterion. Narrower than `KanbanCheckType`
   * on purpose: only the types the default deterministic registry can actually
   * run are offered, so a criterion this tool creates never reports
   * `skipped — no verifier plugin registered`.
   */
  checkType?:
    | 'manual'
    | 'command'
    | 'test'
    | 'file_exists'
    | 'file_matches'
    | 'git_diff'
    | 'metric'
    | undefined;
  /** Executable body for a non-manual `checkType`; plugins read it before the description. */
  checkNotes?: string | undefined;
  contractEnforcement?: KanbanContractGraphEnforcement | undefined;
  contractNodeId?: string | undefined;
  contractNodeKind?: KanbanContractNodeKind | undefined;
  contractNodeTitle?: string | undefined;
  contractNodeDescription?: string | undefined;
  contractNodeState?: KanbanContractNodeState | undefined;
  contractNodeEnforcement?: KanbanContractEnforcement | undefined;
  contractCheckId?: string | undefined;
  contractMetricId?: string | undefined;
  contractWaiverReason?: string | undefined;
  contractEdgeId?: string | undefined;
  contractEdgeFrom?: string | undefined;
  contractEdgeTo?: string | undefined;
  contractEdgeType?: KanbanContractEdgeType | undefined;
  contractEdgeRationale?: string | undefined;
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
  /** `transition_task`: flip one or more manual criteria to `passed` before the gate fires. */
  tickChecks?: { checkId: string; checkStatus: 'passed' | 'failed' | 'skipped' }[] | undefined;
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
  /** `update_task`: an explicit `[]` clears every dependency. */
  dependsOn?: string[] | undefined;
  /** `update_task`: mark a card a composite parent, or `false` to make it a leaf again. */
  atomic?: boolean | undefined;
  /** `update_task`: an explicit `[]` detaches every child from a composite parent. */
  childTaskIds?: string[] | undefined;
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
  /**
   * propose_decomposition: 2+ proposed subtasks.
   * approve_decomposition: optional edits replacing the proposed subtasks.
   */
  subtasks?: KanbanDecompositionSubtask[] | undefined;
  /** approve_decomposition / reject_decomposition: the proposal to resolve. */
  proposalId?: string | undefined;
  /** record_activity: what kind of activity this was. */
  activityKind?: KanbanManualActivityKind | undefined;
  /** record_activity: how it turned out. */
  activityOutcome?: KanbanManualActivityOutcome | undefined;
  /** record_activity: optional longer detail behind the summary. */
  activityDetails?: string | undefined;
}

/** stats: whole-project (or one-board) totals in one small payload. */
export interface KanbanStats {
  boards: number;
  boardsByKind: Record<string, number>;
  columns: number;
  cards: number;
  cardsByStatus: Record<string, number>;
  mostRecentlyUpdatedBoard?: { id: string; title: string; updatedAt: string } | undefined;
}

export interface KanbanToolOutput {
  /** Always `true` on a returned result — failures throw instead. Kept for shape stability. */
  ok: boolean;
  /** claim_task: `false` when no ready task matched (a data outcome, not a failure). */
  claimed?: boolean | undefined;
  /** import_session_tasks: number of session tasks imported (0 when there were none). */
  imported?: number | undefined;
  /** Per-field truncation applied to large collections: `{ field: { shown, total } }`. */
  truncated?: Record<string, { shown: number; total: number }> | undefined;
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
  stats?: KanbanStats | undefined;
  task?: KanbanTask | undefined;
  tasks?: KanbanSearchResult[] | undefined;
  recoveredTasks?: KanbanTask[] | undefined;
  events?: KanbanEvent[] | undefined;
  /** board_history: global board-lifecycle log, which outlives deleted boards. */
  history?: KanbanBoardHistoryEntry[] | undefined;
  queueHealth?: KanbanQueueHealth | undefined;
  children?: KanbanTask[] | undefined;
  chain?: KanbanTask[] | undefined;
  snapshot?: KanbanOrchestrationSnapshot | undefined;
  workbench?: KanbanWorkbenchSnapshot | undefined;
  taskGraph?: SerializedTaskGraph | undefined;
  markdown?: string | undefined;
  contractGraph?: KanbanContractGraph | null | undefined;
  contractEvaluation?: KanbanContractGraphEvaluation | undefined;
}
