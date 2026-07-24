// Kanban data model + manager moved from @wrongstack/core to the standalone
// @wrongstack/kanban package; only the Tool contract and the task-graph
// serialization types still come from core.
import { randomUUID } from 'node:crypto';
import { deserializeTaskGraph, serializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializableTaskGraph, SerializedTaskGraph, Tool } from '@wrongstack/core/types';
import { loadTasks } from '@wrongstack/core/storage';
import type {
  AssignKanbanTaskInput,
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanBoardSummary,
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
} from '@wrongstack/kanban';
import {
  addCheckToTask,
  addColumn,
  addDependency,
  addGoalMetricToTask,
  addLinkToTask,
  addNoteToTask,
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  duplicateBoard,
  exportBoardAsMarkdown,
  exportBoardToTaskGraph,
  createBoardFromText,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  getTask,
  getTaskChain,
  heartbeatTaskAssignment,
  listBoards,
  listKanbanEvents,
  listReadyTasks,
  mergeTasks,
  moveTask,
  parseLinesIntoTasks,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeBoard,
  removeColumn,
  removeTask,
  searchKanban,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transitionTask,
  transferTaskToBoard,
  touchKanbanPresence,
  updateBoard,
  updateCheckOnTask,
  updateColumn,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
  verifyTaskCompletion,
  finalizeTaskCompletion,
  assessTaskAtomicity,
  proposeTaskDecomposition,
} from '@wrongstack/kanban';
import type {
  KanbanCompletionGateEnforcement,
  KanbanDecompositionSubtask,
} from '@wrongstack/kanban';
import { recordKanbanVerificationEvidence } from './kanban-evidence-bridge.js';
import { taskFileToSerializedGraph } from './session-kanban.js';

type KanbanAction =
  | 'list_boards'
  | 'get_board'
  | 'create_board'
  | 'duplicate_board'
  | 'update_board'
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
  | 'add_column'
  | 'update_column'
  | 'delete_column'
  | 'add_task'
  | 'split_task'
  | 'merge_tasks'
  | 'copy_task'
  | 'transfer_task'
  | 'get_task'
  | 'update_task'
  | 'transition_task'
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

interface KanbanToolInput extends Omit<AssignKanbanTaskInput, 'status'> {
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
  /**
   * Ownership fence. When set on `mark_assignment` / `heartbeat_assignment`,
   * the assignment is only mutated if `task.assignment.leaseId` still matches
   * this value (checked atomically inside the board mutation lock). This lets
   * a worker prove it still owns the lease before renewing or finalizing, and
   * makes a stale worker that was recovered+reassigned a safe no-op rather
   * than a TOCTOU gap that overwrites the successor's state. Omit for legacy
   * unconditional behavior.
   */
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
  attachmentType?: 'issue' | 'pr' | 'doc' | 'commit' | 'design' | 'file' | 'url' | 'other' | undefined;
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

interface KanbanToolOutput {
  ok: boolean;
  verdict?: KanbanVerificationReport['verdict'] | undefined;
  /** Completion-gate outcome when a completion path ran the universal gate. */
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
  taskGraph?: SerializedTaskGraph | undefined;
  markdown?: string | undefined;
}

export const kanbanTool: Tool<KanbanToolInput, KanbanToolOutput> = {
  name: 'kanban',
  category: 'Project',
  description:
    'Manage and audit project-scoped multi-kanban boards stored under .wrongstack/kanbans. Managed cards enforce fully specified details and adjacent Backlog → Todo → Running → Review → Done transitions with persistent comments and evidence. Successful board access records live agent/session presence. Use verify_completion to validate a task against its success criteria and persist the verification report. Use split_atomic to split a task into child tasks with parent.atomic=true in a single atomic board mutation, enforcing subtree verification before the parent can complete.',
  usageHint:
    'Use this for durable project kanban state. Reassess with get_board whenever evidence changes; agents may add, update, split, merge, reprioritize, or remove tasks so the board remains a live plan. Presence includes active/last-seen session and agent metadata. For managed boards, fully fill card details, use transition_task after every material step, attach truthful evidence, and never use update_task/move_task to bypass lifecycle guards. Worker completion enters Review; only passed acceptance criteria plus review evidence allow Done. Use verify_completion to generate a verification report (persisted automatically) and split_atomic to atomically create child subtasks with the atomic flag pre-set.',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'task',
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list_boards',
          'get_board',
          'create_board',
          'duplicate_board',
          'update_board',
          'delete_board',
          'generate_board',
          'export_markdown',
          'export_task_graph',
          'sync_task_graph',
          'create_from_graph',
          'import_session_tasks',
          'search_tasks',
          'ready_tasks',
          'snapshot',
          'add_column',
          'update_column',
          'delete_column',
          'add_task',
          'split_task',
          'merge_tasks',
          'copy_task',
          'transfer_task',
          'get_task',
          'update_task',
          'transition_task',
          'move_task',
          'delete_task',
          'set_chain',
          'get_chain',
          'claim_task',
          'release_task',
          'assign_task',
          'mark_assignment',
          'heartbeat_assignment',
          'recover_stale',
          'events',
          'queue_health',
          'add_dependency',
          'add_goal_metric',
          'update_goal_metric',
          'add_check',
          'update_check',
          'add_note',
          'add_link',
          'verify_completion',
          'split_atomic',
          'assess_atomicity',
          'propose_decomposition',
        ],
      },
      boardId: { type: 'string' },
      taskId: { type: 'string' },
      taskIds: { type: 'array', items: { type: 'string' } },
      chainId: { type: 'string' },
      columnId: { type: 'string' },
      targetBoardId: { type: 'string' },
      targetColumnId: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      dueDate: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      labels: { type: 'array', items: { type: 'string' } },
      priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      taskType: {
        type: 'string',
        enum: ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'],
      },
      status: {
        type: 'string',
        enum: [
          'pending',
          'ready',
          'in_progress',
          'blocked',
          'review',
          'completed',
          'failed',
          'archived',
        ],
      },
      order: { type: 'number' },
      query: { type: 'string' },
      limit: { type: 'number' },
      agentId: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      fallbackProfile: { type: 'string' },
      fallbackModels: { type: 'array', items: { type: 'string' } },
      tools: { type: 'array', items: { type: 'string' } },
      allowedCapabilities: { type: 'array', items: { type: 'string' } },
      leaseId: { type: 'string' },
      claimedAt: { type: 'string' },
      heartbeatAt: { type: 'string' },
      leaseExpiresAt: { type: 'string' },
      attempt: { type: 'number' },
      maxAttempts: { type: 'number' },
      subagentId: { type: 'string' },
      runTaskId: { type: 'string' },
      lastResult: { type: 'string' },
      error: { type: 'string' },
      expectedLeaseId: { type: 'string' },
      assignmentStatus: {
        type: 'string',
        enum: ['assigned', 'queued', 'running', 'completed', 'failed', 'cancelled'],
      },
      lifecycleStage: {
        type: 'string',
        enum: ['backlog', 'todo', 'running', 'review', 'done'],
      },
      transitionAction: { type: 'string' },
      transitionComment: { type: 'string' },
      attachmentUrl: { type: 'string' },
      attachmentTitle: { type: 'string' },
      attachmentType: {
        type: 'string',
        enum: ['issue', 'pr', 'doc', 'commit', 'design', 'file', 'url', 'other'],
      },
      releaseStatus: { type: 'string', enum: ['pending', 'ready', 'blocked'] },
      releaseReason: { type: 'string' },
      clearAssignee: { type: 'boolean' },
      recoveryMode: { type: 'string', enum: ['auto', 'release', 'retry', 'fail'] },
      recoveryNow: { type: 'string' },
      recoveryPolicyFailOnCostCeiling: { type: 'boolean' },
      recoveryPolicyReleaseOnFailureKinds: { type: 'array', items: { type: 'string' } },
      recoveryPolicyReleaseOnHeartbeatDue: { type: 'boolean' },
      recoveryPolicyRetryPolicyOverride: {
        type: 'string',
        enum: ['off', 'incremental', 'exponential'],
      },
      assignee: { type: 'string' },
      costCeilingUsd: { type: 'number' },
      retryPolicy: { type: 'string', enum: ['off', 'incremental', 'exponential'] },
      lastFailureKind: { type: 'string' },
      dependsOn: { type: 'array', items: { type: 'string' } },
      estimatedHours: { type: 'number' },
      actualHours: { type: 'number' },
      taskGraph: { type: 'object' },
      graphId: { type: 'string' },
      specId: { type: 'string' },
      sourceSystem: { type: 'string' },
      phaseId: { type: 'string' },
      preserveOriginTaskIds: { type: 'boolean' },
      includeArchived: { type: 'boolean' },
      archiveMissingTasks: { type: 'boolean' },
      preserveManualDependencies: { type: 'boolean' },
      dependencyTaskId: { type: 'string' },
      enforceDependencies: { type: 'boolean' },
      childTitles: { type: 'array', items: { type: 'string' } },
      inheritAssignment: { type: 'boolean' },
      inheritLabels: { type: 'boolean' },
      inheritSuccessCriteria: { type: 'boolean' },
      inheritGoalMetrics: { type: 'boolean' },
      inheritDependencies: { type: 'boolean' },
      chainChildren: { type: 'boolean' },
      rewireDependents: { type: 'boolean' },
      closeSourceTasks: { type: 'boolean' },
      metricId: { type: 'string' },
      metricName: { type: 'string' },
      metricTarget: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      metricCurrent: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      metricUnit: { type: 'string' },
      metricStatus: { type: 'string', enum: ['pending', 'met', 'missed', 'waived'] },
      metricNotes: { type: 'string' },
      checkId: { type: 'string' },
      checkDescription: { type: 'string' },
      checkStatus: { type: 'string', enum: ['pending', 'passed', 'failed', 'skipped'] },
      note: { type: 'string' },
      author: { type: 'string' },
      url: { type: 'string' },
      linkTitle: { type: 'string' },
      linkType: {
        type: 'string',
        enum: ['issue', 'pr', 'doc', 'commit', 'design', 'file', 'url', 'other'],
      },
      context: { type: 'string' },
      columns: { type: 'array', items: { type: 'string' } },
      generatedBy: { type: 'string' },
      includeTasks: { type: 'boolean' },
      includeCompletedTasks: { type: 'boolean' },
      preserveAssignment: { type: 'boolean' },
      preserveDependencies: { type: 'boolean' },
      moveTasksToColumnId: { type: 'string' },
      atomicityMode: { type: 'string', enum: ['off', 'assess', 'enforce'] },
      atomicityDecomposition: { type: 'string', enum: ['auto', 'propose'] },
      gateEnforcement: { type: 'string', enum: ['strict', 'soft', 'off'] },
      subtasks: {
        type: 'array',
        minItems: 2,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            successCriteria: { type: 'array', items: { type: 'string' } },
            dependsOnIndex: { type: 'array', items: { type: 'number' } },
          },
          required: ['title'],
        },
      },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot;
    if (!projectRoot) return fail('No project root is available.');

    const withPresence = async (result: KanbanToolOutput): Promise<KanbanToolOutput> => {
      const boardId = result.board?.id ?? input.boardId;
      if (!result.ok || !boardId || !ctx.session?.id || !ctx.agentId) return result;
      try {
        const board = await touchKanbanPresence(projectRoot, boardId, {
          sessionId: ctx.session.id,
          agentId: ctx.agentId,
          agentName: ctx.agentName,
          taskId: input.taskId ?? result.task?.id,
          runTaskId: input.runTaskId,
        });
        return board ? { ...result, board } : result;
      } catch {
        // Presence is observational. A failed heartbeat must not turn a
        // successful board mutation into an apparent task failure.
        return result;
      }
    };

    try {
      const result = await (async (): Promise<KanbanToolOutput> => {
        switch (input.action) {
        case 'list_boards': {
          const boards = await listBoards(projectRoot);
          return { ok: true, message: `${boards.length} board(s).`, boards };
        }
        case 'get_board': {
          const board = await requireBoard(projectRoot, input.boardId);
          return board ? okBoard(board) : fail('Board not found.');
        }
        case 'create_board': {
          if (!input.title) return fail('create_board requires title.');
          const board = await createBoard(projectRoot, {
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.atomicityMode !== undefined
              ? {
                  atomicity: {
                    mode: input.atomicityMode,
                    decomposition: input.atomicityDecomposition ?? 'propose',
                  },
                }
              : {}),
            ...(input.gateEnforcement !== undefined
              ? { completionGate: { enforcement: input.gateEnforcement } }
              : {}),
          });
          return { ok: true, message: `Board created: ${board.title}`, board };
        }
        case 'update_board': {
          if (!input.boardId) return fail('update_board requires boardId.');
          const board = await updateBoard(projectRoot, input.boardId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.atomicityMode !== undefined
              ? {
                  atomicity: {
                    mode: input.atomicityMode,
                    decomposition: input.atomicityDecomposition ?? 'propose',
                  },
                }
              : {}),
            ...(input.gateEnforcement !== undefined
              ? { completionGate: { enforcement: input.gateEnforcement } }
              : {}),
          });
          return board ? okBoard(board, 'Board updated.') : fail('Board not found.');
        }
        case 'duplicate_board': {
          if (!input.boardId) return fail('duplicate_board requires boardId.');
          const board = await duplicateBoard(projectRoot, input.boardId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.includeTasks !== undefined ? { includeTasks: input.includeTasks } : {}),
            ...(input.includeCompletedTasks !== undefined
              ? { includeCompletedTasks: input.includeCompletedTasks }
              : {}),
            ...(input.preserveAssignment !== undefined
              ? { preserveAssignment: input.preserveAssignment }
              : {}),
          });
          return board ? okBoard(board, 'Board duplicated.') : fail('Board not found.');
        }
        case 'delete_board': {
          if (!input.boardId) return fail('delete_board requires boardId.');
          const removed = await removeBoard(projectRoot, input.boardId);
          return { ok: removed, message: removed ? 'Board deleted.' : 'Board not found.' };
        }
        case 'generate_board': {
          if (!input.description) return fail('generate_board requires description.');
          const boardInput = createBoardFromText({
            description: input.description,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.context !== undefined ? { context: input.context } : {}),
            ...(input.columns !== undefined ? { columns: input.columns } : {}),
          });
          const board = await createBoard(projectRoot, boardInput);
          for (const taskInput of parseLinesIntoTasks(
            input.description,
            board.columns[0]?.id ?? 'backlog',
          )) {
            await addTask(projectRoot, board.id, taskInput);
          }
          return okBoard((await getBoard(projectRoot, board.id)) ?? board, 'Board generated.');
        }
        case 'export_markdown': {
          const board = await requireBoard(projectRoot, input.boardId);
          if (!board) return fail('Board not found.');
          return {
            ok: true,
            message: 'Board exported.',
            board,
            markdown: exportBoardAsMarkdown(board),
          };
        }
        case 'export_task_graph': {
          if (!input.boardId) return fail('export_task_graph requires boardId.');
          const exported = await exportBoardToTaskGraph(projectRoot, input.boardId, {
            ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
            ...(input.specId !== undefined ? { specId: input.specId } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.preserveOriginTaskIds !== undefined
              ? { preserveOriginTaskIds: input.preserveOriginTaskIds }
              : {}),
            ...(input.includeArchived !== undefined
              ? { includeArchived: input.includeArchived }
              : {}),
          });
          if (!exported) return fail('Board not found.');
          return {
            ok: true,
            message: `Task graph exported with ${exported.graph.nodes.size} node(s).`,
            board: exported.board,
            taskGraph: serializeTaskGraph(exported.graph),
          };
        }
        case 'sync_task_graph': {
          if (!input.boardId || !input.taskGraph) {
            return fail('sync_task_graph requires boardId and taskGraph.');
          }
          const graph = deserializeTaskGraph(input.taskGraph as SerializableTaskGraph);
          const result = await syncBoardFromTaskGraph(projectRoot, input.boardId, graph, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.sourceSystem !== undefined ? { sourceSystem: input.sourceSystem } : {}),
            ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
            ...(input.includeCompletedTasks !== undefined
              ? { includeCompletedTasks: input.includeCompletedTasks }
              : {}),
            ...(input.archiveMissingTasks !== undefined
              ? { archiveMissingTasks: input.archiveMissingTasks }
              : {}),
            ...(input.preserveManualDependencies !== undefined
              ? { preserveManualDependencies: input.preserveManualDependencies }
              : {}),
          });
          return result
            ? {
                ok: true,
                message: `Task graph synced: ${result.createdTaskIds.length} created, ${result.updatedTaskIds.length} updated, ${result.archivedTaskIds.length} archived.`,
                board: result.board,
              }
            : fail('Board not found.');
        }
        case 'create_from_graph': {
          if (!input.taskGraph) return fail('create_from_graph requires taskGraph.');
          const graph = deserializeTaskGraph(input.taskGraph as SerializableTaskGraph);
          const { board } = await createBoardFromTaskGraph(projectRoot, graph, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
            ...(input.sourceSystem !== undefined ? { sourceSystem: input.sourceSystem } : {}),
            ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
            ...(input.includeCompletedTasks !== undefined
              ? { includeCompletedTasks: input.includeCompletedTasks }
              : {}),
          });
          return {
            ok: true,
            message: `Created board "${board.title}" from task graph with ${board.tasks.length} tasks.`,
            board,
          };
        }
        case 'import_session_tasks': {
          // One-way projection: mirror this session's `.tasks.json` (the `task`
          // tool's list) into a kanban board so session work shows up on a board
          // without swapping the task tool's storage. Origin-keyed + re-runnable.
          const taskPath = (ctx.meta as Record<string, unknown>)?.['task.path'] as
            | string
            | undefined;
          if (!taskPath) return fail('No session task file for this session.');
          const file = await loadTasks(taskPath);
          if (!file || file.tasks.length === 0) return fail('No session tasks to import.');
          const sessionId = ctx.session?.id ?? file.sessionId ?? 'session';
          const graph = deserializeTaskGraph(taskFileToSerializedGraph(file.tasks, sessionId));
          const tags = ['session', `session:${sessionId}`];
          const existing = (await listBoards(projectRoot)).find((b) =>
            b.tags?.includes(`session:${sessionId}`),
          );
          if (existing) {
            const result = await syncBoardFromTaskGraph(projectRoot, existing.id, graph, {
              sourceSystem: 'session',
              tags,
              archiveMissingTasks: true,
              includeCompletedTasks: true,
            });
            return result
              ? {
                  ok: true,
                  message: `Synced ${file.tasks.length} session tasks into board "${result.board.title}".`,
                  board: result.board,
                }
              : fail('Session board vanished mid-sync.');
          }
          const { board } = await createBoardFromTaskGraph(projectRoot, graph, {
            title: `Session tasks (${sessionId.slice(0, 8)})`,
            sourceSystem: 'session',
            tags,
          });
          return {
            ok: true,
            message: `Imported ${file.tasks.length} session tasks into new board "${board.title}".`,
            board,
          };
        }
        case 'search_tasks': {
          const tasks = await searchKanban(projectRoot, {
            query: input.query,
            boardId: input.boardId,
            assignedAgent: input.agentId,
            status: input.status,
            priority: input.priority,
            label: input.labels?.[0],
            chainId: input.chainId,
          });
          return { ok: true, message: `${tasks.length} task(s) matched.`, tasks };
        }
        case 'ready_tasks': {
          const tasks = await listReadyTasks(projectRoot, {
            query: input.query,
            boardId: input.boardId,
            assignedAgent: input.agentId,
            priority: input.priority,
            label: input.labels?.[0],
            chainId: input.chainId,
            limit: input.limit,
          });
          return { ok: true, message: `${tasks.length} ready task(s).`, tasks };
        }
        case 'snapshot': {
          const snapshot = await getKanbanOrchestrationSnapshot(projectRoot, {
            query: input.query,
            boardId: input.boardId,
            assignedAgent: input.agentId,
            status: input.status,
            priority: input.priority,
            label: input.labels?.[0],
            chainId: input.chainId,
          });
          return {
            ok: true,
            message: `${snapshot.ready.length} ready, ${snapshot.running.length} running, ${snapshot.blocked.length} blocked.`,
            snapshot,
          };
        }
        case 'add_column': {
          if (!input.boardId || !input.title) return fail('add_column requires boardId and title.');
          const result = await addColumn(projectRoot, input.boardId, {
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
          });
          return result ? okBoard(result.board, 'Column added.') : fail('Board not found.');
        }
        case 'update_column': {
          if (!input.boardId || !input.columnId)
            return fail('update_column requires boardId and columnId.');
          const board = await updateColumn(projectRoot, input.boardId, input.columnId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.order !== undefined ? { order: input.order } : {}),
          });
          return board ? okBoard(board, 'Column updated.') : fail('Column not found.');
        }
        case 'delete_column': {
          if (!input.boardId || !input.columnId)
            return fail('delete_column requires boardId and columnId.');
          const board = await removeColumn(projectRoot, input.boardId, input.columnId, {
            moveTasksToColumnId: input.moveTasksToColumnId,
          });
          return board ? okBoard(board, 'Column deleted.') : fail('Column not found.');
        }
        case 'add_task': {
          if (!input.boardId || !input.title) return fail('add_task requires boardId and title.');
          const result = await addTask(projectRoot, input.boardId, taskInput(input));
          if (!result) return fail('Board not found.');
          return okTask(
            result.board,
            result.task,
            `Task added.${atomicityNudge(result.task)}`,
          );
        }
        case 'split_task': {
          if (!input.boardId || !input.taskId || !input.childTitles?.length) {
            return fail('split_task requires boardId, taskId, and childTitles.');
          }
          return handleSplitTask(projectRoot, input, {});
        }
        case 'merge_tasks': {
          if (!input.boardId || !input.taskIds?.length || !input.title) {
            return fail('merge_tasks requires boardId, taskIds, and title.');
          }
          const result = await mergeTasks(projectRoot, input.boardId, {
            taskIds: input.taskIds,
            title: input.title,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.targetColumnId !== undefined ? { targetColumnId: input.targetColumnId } : {}),
            ...(input.preserveAssignment !== undefined
              ? { preserveAssignment: input.preserveAssignment }
              : {}),
            ...(input.closeSourceTasks !== undefined
              ? { closeSourceTasks: input.closeSourceTasks }
              : {}),
          });
          return result
            ? okTask(result.board, result.task, 'Tasks merged.')
            : fail('Board or task not found.');
        }
        case 'copy_task': {
          if (!input.boardId || !input.taskId || !input.targetBoardId) {
            return fail('copy_task requires boardId, taskId, and targetBoardId.');
          }
          const result = await copyTaskToBoard(
            projectRoot,
            input.boardId,
            input.taskId,
            input.targetBoardId,
            {
              ...(input.targetColumnId !== undefined
                ? { targetColumnId: input.targetColumnId }
                : {}),
              ...(input.order !== undefined ? { targetOrder: input.order } : {}),
              ...(input.preserveAssignment !== undefined
                ? { preserveAssignment: input.preserveAssignment }
                : {}),
              ...(input.preserveDependencies !== undefined
                ? { preserveDependencies: input.preserveDependencies }
                : {}),
            },
          );
          return result
            ? okTask(result.targetBoard, result.task, 'Task copied to target board.')
            : fail('Board or task not found.');
        }
        case 'transfer_task': {
          if (!input.boardId || !input.taskId || !input.targetBoardId) {
            return fail('transfer_task requires boardId, taskId, and targetBoardId.');
          }
          const result = await transferTaskToBoard(
            projectRoot,
            input.boardId,
            input.taskId,
            input.targetBoardId,
            {
              ...(input.targetColumnId !== undefined
                ? { targetColumnId: input.targetColumnId }
                : {}),
              ...(input.order !== undefined ? { targetOrder: input.order } : {}),
              ...(input.preserveAssignment !== undefined
                ? { preserveAssignment: input.preserveAssignment }
                : {}),
              ...(input.preserveDependencies !== undefined
                ? { preserveDependencies: input.preserveDependencies }
                : {}),
            },
          );
          return result
            ? okTask(result.targetBoard, result.task, 'Task transferred to target board.')
            : fail('Board or task not found.');
        }
        case 'get_task': {
          if (!input.boardId || !input.taskId) return fail('get_task requires boardId and taskId.');
          const task = await getTask(projectRoot, input.boardId, input.taskId);
          return task ? { ok: true, message: 'Task loaded.', task } : fail('Task not found.');
        }
        case 'update_task': {
          if (!input.boardId || !input.taskId)
            return fail('update_task requires boardId and taskId.');
          const board = await updateTask(
            projectRoot,
            input.boardId,
            input.taskId,
            taskPatch(input),
          );
          return board ? okBoard(board, 'Task updated.') : fail('Task not found.');
        }
        case 'transition_task': {
          if (
            !input.boardId ||
            !input.taskId ||
            !input.lifecycleStage ||
            !input.author ||
            !input.transitionComment
          ) {
            return fail(
              'transition_task requires boardId, taskId, lifecycleStage, author, and transitionComment.',
            );
          }
          // Pre-gate for Done: transitionTask's validateDoneEvidence trusts a
          // persisted verificationReport but never runs the verifier itself.
          // When the target is done and the task lacks a report, run the
          // verifier and persist report + refreshed criteria first so the
          // transition is judged on fresh evidence.
          if (input.lifecycleStage === 'done') {
            const boardBefore = await getBoard(projectRoot, input.boardId);
            const taskBefore = boardBefore
              ? await getTask(projectRoot, input.boardId, input.taskId)
              : null;
            if (
              boardBefore &&
              taskBefore &&
              !taskBefore.verificationReport &&
              (taskBefore.atomic || Boolean(taskBefore.successCriteria?.length))
            ) {
              const preGate = await verifyTaskCompletion(projectRoot, input.boardId, taskBefore.id, {
                persist: false,
              });
              await updateTask(projectRoot, input.boardId, taskBefore.id, {
                verificationReport: preGate.report,
                successCriteria: preGate.task.successCriteria,
              });
            }
          }
          const result = await transitionTask(projectRoot, input.boardId, input.taskId, {
            to: input.lifecycleStage,
            actor: input.author,
            comment: input.transitionComment,
            ...(input.transitionAction !== undefined
              ? { action: input.transitionAction }
              : {}),
            ...(input.attachmentUrl !== undefined
              ? {
                  attachment: {
                    url: input.attachmentUrl,
                    type: input.attachmentType ?? 'url',
                    ...(input.attachmentTitle !== undefined
                      ? { title: input.attachmentTitle }
                      : {}),
                  },
                }
              : {}),
            patch: taskPatch(input),
          });
          if (result && input.lifecycleStage === 'done' && result.task.verificationReport) {
            recordKanbanVerificationEvidence(ctx, result.task.verificationReport);
          }
          return result
            ? okTask(result.board, result.task, `Task advanced to ${result.transition.to}.`)
            : fail('Board or task not found.');
        }
        case 'move_task': {
          if (!input.boardId || !input.taskId || !input.targetColumnId) {
            return fail('move_task requires boardId, taskId, and targetColumnId.');
          }
          const board = await moveTask(
            projectRoot,
            input.boardId,
            input.taskId,
            input.targetColumnId,
            input.order,
          );
          return board ? okBoard(board, 'Task moved.') : fail('Move failed.');
        }
        case 'delete_task': {
          if (!input.boardId || !input.taskId)
            return fail('delete_task requires boardId and taskId.');
          const board = await removeTask(projectRoot, input.boardId, input.taskId);
          return board ? okBoard(board, 'Task deleted.') : fail('Task not found.');
        }
        case 'set_chain': {
          if (!input.boardId || !input.taskIds?.length) {
            return fail('set_chain requires boardId and taskIds.');
          }
          const result = await setTaskChain(projectRoot, input.boardId, {
            taskIds: input.taskIds,
            ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
            ...(input.enforceDependencies !== undefined
              ? { enforceDependencies: input.enforceDependencies }
              : {}),
          });
          return result
            ? {
                ok: true,
                message: `Chain set: ${result.chainId}`,
                board: result.board,
                chain: result.tasks,
              }
            : fail('Board or task not found.');
        }
        case 'get_chain': {
          if (!input.boardId || !(input.taskId || input.chainId)) {
            return fail('get_chain requires boardId and taskId or chainId.');
          }
          const result = await getTaskChain(
            projectRoot,
            input.boardId,
            input.taskId ?? input.chainId ?? '',
          );
          return result
            ? {
                ok: true,
                message: `Chain loaded: ${result.chainId}`,
                board: result.board,
                chain: result.tasks,
              }
            : fail('Chain not found.');
        }
        case 'claim_task': {
          const result = await claimReadyTask(projectRoot, {
            ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
            ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
            ...assignmentInput(input),
            status: input.assignmentStatus ?? 'queued',
          });
          return result
            ? okTask(result.board, result.task, 'Task claimed.')
            : fail('No ready kanban task matched the claim.');
        }
        case 'release_task': {
          if (!input.boardId || !input.taskId) {
            return fail('release_task requires boardId and taskId.');
          }
          const board = await releaseTaskClaim(projectRoot, input.boardId, input.taskId, {
            ...(input.releaseStatus !== undefined ? { status: input.releaseStatus } : {}),
            ...(input.releaseReason !== undefined ? { reason: input.releaseReason } : {}),
            ...(input.clearAssignee !== undefined ? { clearAssignee: input.clearAssignee } : {}),
          });
          return board ? okBoard(board, 'Task claim released.') : fail('Task not found.');
        }
        case 'assign_task': {
          if (!input.boardId || !input.taskId)
            return fail('assign_task requires boardId and taskId.');
          const board = await assignTask(
            projectRoot,
            input.boardId,
            input.taskId,
            assignmentInput(input),
          );
          return board ? okBoard(board, 'Task assigned.') : fail('Task not found.');
        }
        case 'mark_assignment': {
          if (!input.boardId || !input.taskId)
            return fail('mark_assignment requires boardId and taskId.');
          const assignmentStatus =
            input.assignmentStatus ??
            (input.status === 'completed' ? 'completed' : input.error ? 'failed' : undefined);
          const board = await updateTaskAssignment(
            projectRoot,
            input.boardId,
            input.taskId,
            {
              ...(assignmentStatus !== undefined ? { status: assignmentStatus } : {}),
              ...(input.subagentId !== undefined ? { subagentId: input.subagentId } : {}),
              ...(input.runTaskId !== undefined ? { runTaskId: input.runTaskId } : {}),
              ...(input.lastResult !== undefined ? { lastResult: input.lastResult } : {}),
              ...(input.error !== undefined ? { error: input.error } : {}),
              ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
              ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
              ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
              ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
              ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
              ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
              ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
            },
            // Ownership fence: when expectedLeaseId is supplied, the write is
            // applied only if the current assignment still holds this lease.
            // This prevents a recovered+reassigned stale worker's terminal
            // mark_assignment from overwriting the successor's state. The check
            // is atomic inside updateTaskAssignment's mutateBoard lock.
            input.expectedLeaseId !== undefined
              ? { expectedLeaseId: input.expectedLeaseId }
              : {},
          );
          if (!board) return fail('Task not found.');
          // Universal completion gate: a completed assignment was parked in
          // review by updateTaskAssignment; finalize runs the verifier and
          // applies the final status (async — cannot happen inside the board
          // mutation). Env fallback applies only when the board carries no
          // explicit completionGate policy; the kanban package never reads env.
          if (assignmentStatus === 'completed') {
            const envGate = readEnvGateEnforcement();
            const finalized = await finalizeTaskCompletion(projectRoot, board.id, input.taskId, {
              ...(board.completionGate === undefined && envGate !== undefined
                ? { enforcement: envGate }
                : {}),
              ...(ctx.agentId !== undefined ? { eventContext: { actor: ctx.agentId } } : {}),
            });
            if (finalized) {
              if (finalized.gate.report) {
                recordKanbanVerificationEvidence(ctx, finalized.gate.report);
              }
              const gateSummary = {
                enforcement: finalized.gate.enforcement,
                allowed: finalized.gate.allowed,
                verdict: finalized.gate.verdict,
                issues: finalized.gate.issues.map((issue) => issue.message),
              };
              const gateMessage = finalized.gate.allowed
                ? `Completion gate ${finalized.gate.verdict === 'skipped' ? 'skipped' : 'passed'}; task completed.`
                : finalized.gate.enforcement === 'strict'
                  ? `Completion gate BLOCKED (verdict: ${finalized.gate.verdict}); task parked in review. Issues: ${gateSummary.issues.join(' | ')}`
                  : `Completion gate failed softly (verdict: ${finalized.gate.verdict}); task completed with warnings. Issues: ${gateSummary.issues.join(' | ')}`;
              return {
                ...okTask(finalized.board, finalized.task, `Assignment updated. ${gateMessage}`),
                gate: gateSummary,
              };
            }
          }
          return okBoard(board, 'Assignment updated.');
        }
        case 'heartbeat_assignment': {
          if (!input.boardId || !input.taskId) {
            return fail('heartbeat_assignment requires boardId and taskId.');
          }
          const board = await heartbeatTaskAssignment(projectRoot, input.boardId, input.taskId, {
            ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
            ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
            // Ownership fence: when expectedLeaseId is supplied, the renewal
            // is applied only if the current assignment still holds this lease.
            // This prevents a recovered+reassigned stale worker's heartbeat
            // from renewing the successor's lease. The check is atomic inside
            // heartbeatTaskAssignment's mutateBoard lock.
            ...(input.expectedLeaseId !== undefined
              ? { expectedLeaseId: input.expectedLeaseId }
              : {}),
          });
          return board
            ? okBoard(board, 'Assignment heartbeat updated.')
            : fail('Task assignment not found.');
        }
        case 'recover_stale': {
          if (!input.boardId) return fail('recover_stale requires boardId.');
          const policyFields = [
            input.recoveryPolicyFailOnCostCeiling !== undefined,
            input.recoveryPolicyReleaseOnFailureKinds !== undefined,
            input.recoveryPolicyReleaseOnHeartbeatDue !== undefined,
            input.recoveryPolicyRetryPolicyOverride !== undefined,
          ].some(Boolean);
          const result = await recoverStaleTaskAssignments(projectRoot, input.boardId, {
            ...(input.recoveryMode !== undefined ? { mode: input.recoveryMode } : {}),
            ...(input.recoveryNow !== undefined ? { now: input.recoveryNow } : {}),
            ...(input.releaseReason !== undefined ? { reason: input.releaseReason } : {}),
            ...(input.clearAssignee !== undefined ? { clearAssignee: input.clearAssignee } : {}),
            ...(policyFields
              ? {
                  policy: {
                    ...(input.recoveryPolicyFailOnCostCeiling !== undefined
                      ? { failWhenCostCeilingSet: input.recoveryPolicyFailOnCostCeiling }
                      : {}),
                    ...(input.recoveryPolicyReleaseOnFailureKinds !== undefined
                      ? {
                          releaseOnFailureKinds: input.recoveryPolicyReleaseOnFailureKinds,
                        }
                      : {}),
                    ...(input.recoveryPolicyReleaseOnHeartbeatDue !== undefined
                      ? {
                          releaseOnHeartbeatDue: input.recoveryPolicyReleaseOnHeartbeatDue,
                        }
                      : {}),
                    ...(input.recoveryPolicyRetryPolicyOverride !== undefined
                      ? {
                          retryPolicyOverride: input.recoveryPolicyRetryPolicyOverride,
                        }
                      : {}),
                  },
                }
              : {}),
          });
          return result
            ? {
                ok: true,
                message: `Recovered ${result.tasks.length} stale assignment(s).`,
                board: result.board,
                recoveredTasks: result.tasks,
              }
            : { ok: true, message: 'No stale assignment matched.', recoveredTasks: [] };
        }
        case 'events': {
          if (!input.boardId) return fail('events requires boardId.');
          const eventList = await listKanbanEvents(projectRoot, input.boardId);
          return {
            ok: true,
            message: `${eventList.length} event(s).`,
            events: eventList,
          };
        }
        case 'queue_health': {
          const health = await getKanbanQueueHealth(projectRoot, {
            ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          });
          return {
            ok: true,
            message: `Counts: ready=${health.counts.ready}, running=${health.counts.running}, stale=${health.staleAssignments.count}.`,
            queueHealth: health,
          };
        }
        case 'add_dependency': {
          if (!input.boardId || !input.taskId || !input.dependencyTaskId) {
            return fail('add_dependency requires boardId, taskId, and dependencyTaskId.');
          }
          const board = await addDependency(
            projectRoot,
            input.boardId,
            input.taskId,
            input.dependencyTaskId,
          );
          return board ? okBoard(board, 'Dependency added.') : fail('Task not found.');
        }
        case 'add_goal_metric': {
          if (!input.boardId || !input.taskId || !input.metricName) {
            return fail('add_goal_metric requires boardId, taskId, and metricName.');
          }
          const board = await addGoalMetricToTask(projectRoot, input.boardId, input.taskId, {
            name: input.metricName,
            ...(input.metricStatus !== undefined ? { status: input.metricStatus } : {}),
            ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
            ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
            ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
            ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
          });
          return board ? okBoard(board, 'Goal metric added.') : fail('Task not found.');
        }
        case 'update_goal_metric': {
          if (!input.boardId || !input.taskId || !input.metricId) {
            return fail('update_goal_metric requires boardId, taskId, and metricId.');
          }
          const board = await updateGoalMetricOnTask(
            projectRoot,
            input.boardId,
            input.taskId,
            input.metricId,
            {
              ...(input.metricName !== undefined ? { name: input.metricName } : {}),
              ...(input.metricStatus !== undefined ? { status: input.metricStatus } : {}),
              ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
              ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
              ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
              ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
            },
          );
          return board ? okBoard(board, 'Goal metric updated.') : fail('Metric not found.');
        }
        case 'add_check': {
          if (!input.boardId || !input.taskId || !input.checkDescription) {
            return fail('add_check requires boardId, taskId, and checkDescription.');
          }
          const board = await addCheckToTask(projectRoot, input.boardId, input.taskId, {
            description: input.checkDescription,
            type: 'manual',
            status: input.checkStatus,
          });
          return board ? okBoard(board, 'Check added.') : fail('Task not found.');
        }
        case 'update_check': {
          if (!input.boardId || !input.taskId || !input.checkId) {
            return fail('update_check requires boardId, taskId, and checkId.');
          }
          const board = await updateCheckOnTask(
            projectRoot,
            input.boardId,
            input.taskId,
            input.checkId,
            {
              ...(input.checkDescription !== undefined
                ? { description: input.checkDescription }
                : {}),
              ...(input.checkStatus !== undefined ? { status: input.checkStatus } : {}),
            },
          );
          return board ? okBoard(board, 'Check updated.') : fail('Check not found.');
        }
        case 'add_note': {
          if (!input.boardId || !input.taskId || !input.note)
            return fail('add_note requires boardId, taskId, and note.');
          const board = await addNoteToTask(projectRoot, input.boardId, input.taskId, {
            author: input.author ?? 'agent',
            content: input.note,
          });
          return board ? okBoard(board, 'Note added.') : fail('Task not found.');
        }
        case 'add_link': {
          if (!input.boardId || !input.taskId || !input.url)
            return fail('add_link requires boardId, taskId, and url.');
          const board = await addLinkToTask(projectRoot, input.boardId, input.taskId, {
            url: input.url,
            type: input.linkType ?? 'url',
            ...(input.linkTitle !== undefined ? { title: input.linkTitle } : {}),
          });
          return board ? okBoard(board, 'Link added.') : fail('Task not found.');
        }
        case 'assess_atomicity': {
          if (!input.boardId || !input.taskId) {
            return fail('assess_atomicity requires boardId and taskId.');
          }
          const result = await assessTaskAtomicity(projectRoot, input.boardId, input.taskId, {
            assessedBy: 'agent',
            ...(ctx.agentId !== undefined ? { eventContext: { actor: ctx.agentId } } : {}),
          });
          if (!result) return fail('Task not found.');
          const failing = result.assessment.criteria
            .filter((entry) => entry.score < 1)
            .map((entry) => entry.reason);
          const guidance =
            result.assessment.verdict === 'needs_decomposition'
              ? ` This task should be split before dispatch — call propose_decomposition with 2+ subtasks (each with one verifiable success criterion). Reasons: ${failing.join(' | ')}`
              : result.assessment.verdict === 'composite'
                ? ' Container task: work happens in its children; it is verified via subtask aggregation.'
                : '';
          return okTask(
            result.board,
            result.task,
            `Atomicity verdict: ${result.assessment.verdict} (score ${result.assessment.score}).${guidance}`,
          );
        }
        case 'propose_decomposition': {
          if (!input.boardId || !input.taskId || !input.subtasks?.length) {
            return fail('propose_decomposition requires boardId, taskId, and subtasks (2+).');
          }
          if (input.subtasks.length < 2) {
            return fail('propose_decomposition requires at least two subtasks.');
          }
          const invalid = input.subtasks.find(
            (subtask) => typeof subtask?.title !== 'string' || !subtask.title.trim(),
          );
          if (invalid) return fail('Every proposed subtask needs a non-blank title.');
          const result = await proposeTaskDecomposition(
            projectRoot,
            input.boardId,
            input.taskId,
            {
              subtasks: input.subtasks,
              ...(input.note !== undefined ? { rationale: input.note } : {}),
              ...(ctx.agentId !== undefined ? { proposedBy: ctx.agentId } : {}),
            },
            ctx.agentId !== undefined ? { actor: ctx.agentId } : {},
          );
          if (!result) return fail('Task not found.');
          const message =
            result.proposal.status === 'applied'
              ? `Decomposition applied: ${result.proposal.appliedChildTaskIds?.length ?? 0} child tasks created (parent marked atomic).`
              : 'Decomposition proposal recorded — awaiting approval (board policy is "propose"). It can be approved from the WebUI or via update_task.';
          return okTask(result.board, result.task, message);
        }
        case 'verify_completion': {
          if (!input.boardId || !input.taskId) {
            return fail('verify_completion requires boardId and taskId.');
          }
          const verResult = await verifyTaskCompletion(projectRoot, input.boardId, input.taskId);
          // Persist verificationReport AND updated successCriteria atomically
          // in a single board mutation so there is no window where the report
          // exists but criteria are stale. Always persist both — the verifier
          // may have updated individual criterion status/checkedBy/checkedAt
          // on the in-memory task, and the comparison would always be false
          // because both references point to the same updated object.
          const persistedBoard = await updateTask(projectRoot, input.boardId, input.taskId, {
            verificationReport: verResult.report,
            successCriteria: verResult.task.successCriteria,
          });
          if (!persistedBoard) {
            // Return structured failure so callers can inspect the
            // verification verdict and report without re-running.
            return {
              ok: false,
              verdict: verResult.report.verdict,
              message:
                `Verification succeeded but persist failed: ${verResult.report.markdownSummary}. ` +
                `Board may be stale — re-run verify_completion.`,
              board: verResult.board,
            };
          }
          recordKanbanVerificationEvidence(ctx, verResult.report);
          const freshTask = persistedBoard.tasks?.find((t: KanbanTask) => t.id === input.taskId);
          // ok is true whenever the verifier produced a deterministic verdict
          // (passed/failed/needs_human/incomplete). Callers should inspect the
          // `verdict` field to distinguish success from human-review-needed;
          // ok: false is reserved for thrown errors that never produced a report.
          const deterministicVerdicts = ['passed', 'failed', 'needs_human', 'incomplete'] as const;
          return {
            ok: deterministicVerdicts.includes(verResult.report.verdict as typeof deterministicVerdicts[number]),
            verdict: verResult.report.verdict,
            message: verResult.report.markdownSummary,
            board: persistedBoard,
            task: freshTask ?? verResult.task,
          };
        }
        case 'split_atomic': {
          if (!input.boardId || !input.taskId || !input.childTitles?.length) {
            return fail('split_atomic requires boardId, taskId, and childTitles (at least one).');
          }
          return handleSplitTask(projectRoot, input, { atomic: true });
        }
        default:
          return fail(`Unknown kanban action: ${(input as { action: string }).action}`);
        }
      })();
      return withPresence(result);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

/** One-line guidance appended when a freshly created task should be split. */
function atomicityNudge(task: KanbanTask): string {
  if (task.atomicityAssessment?.verdict !== 'needs_decomposition') return '';
  const reasons = task.atomicityAssessment.criteria
    .filter((entry) => entry.score < 1)
    .map((entry) => entry.reason)
    .join(' | ');
  return ` Atomicity: needs_decomposition (score ${task.atomicityAssessment.score}) — call propose_decomposition with 2+ subtasks before dispatch. Reasons: ${reasons}`;
}

/**
 * Host-level completion-gate fallback. The kanban package stays env-free;
 * only hosting surfaces (tools, webui-server) read WRONGSTACK_KANBAN_GATE,
 * and only when the board carries no explicit completionGate policy.
 */
function readEnvGateEnforcement(): KanbanCompletionGateEnforcement | undefined {
  const raw = process.env['WRONGSTACK_KANBAN_GATE']?.trim().toLowerCase();
  return raw === 'strict' || raw === 'soft' || raw === 'off' ? raw : undefined;
}

function fail(message: string): KanbanToolOutput {
  return { ok: false, message };
}

function okBoard(board: KanbanBoard, message = 'Board loaded.'): KanbanToolOutput {
  return { ok: true, message, board };
}

function okTask(board: KanbanBoard, task: KanbanTask, message: string): KanbanToolOutput {
  return { ok: true, message, board, task };
}

/** Shared split handler used by both split_task and split_atomic. */
async function handleSplitTask(
  projectRoot: string,
  input: KanbanToolInput,
  extraSplitOptions: Record<string, unknown>,
): Promise<KanbanToolOutput> {
  const boardId = input.boardId;
  const taskId = input.taskId;
  const childTitles = input.childTitles;
  if (!boardId || !taskId || !childTitles?.length) {
    return fail('split requires boardId, taskId, and at least one childTitles.');
  }
  // Destructure the optional SplitKanbanTaskInput fields from the tool input.
  // childTitles→titles and targetColumnId→columnId are the only renames.
  const {
    targetColumnId,
    inheritAssignment,
    inheritLabels,
    inheritSuccessCriteria,
    inheritGoalMetrics,
    inheritDependencies,
    chainChildren,
    rewireDependents,
  } = input;
  const result = await splitTask(projectRoot, boardId, taskId, {
    titles: childTitles,
    ...extraSplitOptions,
    ...(targetColumnId !== undefined ? { columnId: targetColumnId } : {}),
    ...(inheritAssignment !== undefined ? { inheritAssignment } : {}),
    ...(inheritLabels !== undefined ? { inheritLabels } : {}),
    ...(inheritSuccessCriteria !== undefined ? { inheritSuccessCriteria } : {}),
    ...(inheritGoalMetrics !== undefined ? { inheritGoalMetrics } : {}),
    ...(inheritDependencies !== undefined ? { inheritDependencies } : {}),
    ...(chainChildren !== undefined ? { chainChildren } : {}),
    ...(rewireDependents !== undefined ? { rewireDependents } : {}),
  });
  if (!result) return fail('Task not found.');
  const freshParent = result.board.tasks?.find((t: KanbanTask) => t.id === taskId);
  if (!freshParent) {
    return fail(
      `Split succeeded but parent ${taskId} not found in returned board. ` +
      `Children: [${result.children.map((c) => c.id).join(', ')}].`,
    );
  }
  return {
    ok: true,
    message: `${result.children.length} child task(s) created.`,
    board: result.board,
    task: freshParent,
    children: result.children,
  };
}

async function requireBoard(
  projectRoot: string,
  boardId: string | undefined,
): Promise<KanbanBoard | null> {
  return boardId ? getBoard(projectRoot, boardId) : null;
}

function taskInput(input: KanbanToolInput) {
  const assignment = hasAssignmentInput(input) ? assignmentForTaskCreate(input) : undefined;
  return {
    title: input.title ?? '',
    columnId: input.columnId,
    description: input.description,
    dueDate: input.dueDate,
    priority: input.priority,
    ...(input.taskType !== undefined ? { type: input.taskType } : {}),
    status: input.status,
    labels: input.labels,
    ...((assignment?.agentId ?? assignment?.role ?? assignment?.name)
      ? { assignedAgent: assignment.agentId ?? assignment.role ?? assignment.name }
      : {}),
    ...((input.assignee ?? assignment?.name ?? assignment?.agentId)
      ? { assignee: input.assignee ?? assignment?.name ?? assignment?.agentId }
      : {}),
    ...(mergedDependsOn(input) ? { dependsOn: mergedDependsOn(input) } : {}),
    ...(input.estimatedHours !== undefined ? { estimatedHours: input.estimatedHours } : {}),
    ...(input.actualHours !== undefined ? { actualHours: input.actualHours } : {}),
    ...(assignment ? { assignment } : {}),
    ...(input.order !== undefined ? { order: input.order } : {}),
    // Sprint 3 durable task-level fields
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    // Relationships — chainId alone cannot construct a KanbanTaskChainRef,
    // so chain/previousTaskId/nextTaskId must be set via update_task.
    ...(input.childTitles !== undefined ? { childTaskIds: input.childTitles } : {}),
    // Detail objects
    ...(input.checkDescription !== undefined
      ? {
          successCriteria: [
            {
              id: randomUUID(),
              description: input.checkDescription,
              type: 'manual' as const,
              status: input.checkStatus ?? ('pending' as const),
            },
          ],
        }
      : {}),
    ...(input.metricName !== undefined
      ? {
          goalMetrics: [
            {
              id: randomUUID(),
              name: input.metricName,
              status: input.metricStatus ?? ('pending' as const),
              ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
              ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
              ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
              ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
            },
          ],
        }
      : {}),
    ...(input.url !== undefined
      ? {
          links: [
            {
              url: input.url,
              type: input.linkType ?? ('url' as const),
              ...(input.linkTitle !== undefined ? { title: input.linkTitle } : {}),
            },
          ],
        }
      : {}),
    ...(input.note !== undefined
      ? {
          notes: [
            {
              id: randomUUID(),
              author: input.author ?? 'agent',
              content: input.note,
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : {}),
    // Origin tracking
    ...(input.graphId !== undefined
      ? {
          origin: {
            system: input.sourceSystem ?? 'kanban-tool',
            ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
            ...(input.specId !== undefined ? { specId: input.specId } : {}),
            ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
          },
        }
      : {}),
  };
}

/** Union of the single `dependencyTaskId` and the multi `dependsOn[]` inputs. */
function mergedDependsOn(input: KanbanToolInput): string[] | undefined {
  const ids = [
    ...(input.dependsOn ?? []),
    ...(input.dependencyTaskId !== undefined ? [input.dependencyTaskId] : []),
  ].filter((id, i, arr) => id && arr.indexOf(id) === i);
  return ids.length > 0 ? ids : undefined;
}

function taskPatch(input: KanbanToolInput) {
  return {
    title: input.title,
    description: input.description,
    dueDate: input.dueDate,
    columnId: input.columnId,
    order: input.order,
    priority: input.priority,
    ...(input.taskType !== undefined ? { type: input.taskType } : {}),
    status: input.status,
    labels: input.labels,
    assignedAgent: input.agentId,
    ...(mergedDependsOn(input) ? { dependsOn: mergedDependsOn(input) } : {}),
    ...(input.estimatedHours !== undefined ? { estimatedHours: input.estimatedHours } : {}),
    ...(input.actualHours !== undefined ? { actualHours: input.actualHours } : {}),
  };
}

function assignmentInput(input: KanbanToolInput): AssignKanbanTaskInput {
  return {
    agentId: input.agentId,
    name: input.name,
    role: input.role,
    provider: input.provider,
    model: input.model,
    fallbackProfile: input.fallbackProfile,
    fallbackModels: input.fallbackModels,
    tools: input.tools,
    allowedCapabilities: input.allowedCapabilities,
    assignee: input.assignee,
    leaseId: input.leaseId,
    claimedAt: input.claimedAt,
    heartbeatAt: input.heartbeatAt,
    leaseExpiresAt: input.leaseExpiresAt,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    costCeilingUsd: input.costCeilingUsd,
    retryPolicy: input.retryPolicy,
    lastFailureKind: input.lastFailureKind,
  };
}

function hasAssignmentInput(input: KanbanToolInput): boolean {
  return (
    input.agentId !== undefined ||
    input.name !== undefined ||
    input.role !== undefined ||
    input.provider !== undefined ||
    input.model !== undefined ||
    input.fallbackProfile !== undefined ||
    input.fallbackModels !== undefined ||
    input.tools !== undefined ||
    input.allowedCapabilities !== undefined ||
    input.assignee !== undefined ||
    input.leaseId !== undefined ||
    input.claimedAt !== undefined ||
    input.heartbeatAt !== undefined ||
    input.leaseExpiresAt !== undefined ||
    input.attempt !== undefined ||
    input.maxAttempts !== undefined ||
    input.costCeilingUsd !== undefined ||
    input.retryPolicy !== undefined ||
    input.lastFailureKind !== undefined ||
    input.assignmentStatus !== undefined
  );
}

function assignmentForTaskCreate(input: KanbanToolInput): KanbanAgentAssignment {
  return {
    status: input.assignmentStatus ?? 'assigned',
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.fallbackProfile !== undefined ? { fallbackProfile: input.fallbackProfile } : {}),
    ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.allowedCapabilities !== undefined
      ? { allowedCapabilities: input.allowedCapabilities }
      : {}),
    ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
    ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
    ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
    ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
    ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
    ...(input.retryPolicy !== undefined ? { retryPolicy: input.retryPolicy } : {}),
    ...(input.lastFailureKind !== undefined ? { lastFailureKind: input.lastFailureKind } : {}),
  };
}
