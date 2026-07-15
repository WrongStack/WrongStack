// Kanban data model + manager moved from @wrongstack/core to the standalone
// @wrongstack/kanban package; only the Tool contract and the task-graph
// serialization types still come from core.
import type { SerializableTaskGraph, SerializedTaskGraph, Tool } from '@wrongstack/core';
import { deserializeTaskGraph, loadTasks, serializeTaskGraph } from '@wrongstack/core';
import type {
  AssignKanbanTaskInput,
  KanbanAgentAssignment,
  KanbanAgentRunStatus,
  KanbanBoard,
  KanbanBoardSummary,
  KanbanEvent,
  KanbanOrchestrationSnapshot,
  KanbanQueueHealth,
  KanbanSearchResult,
  KanbanTask,
  KanbanTaskPriority,
  KanbanTaskStatus,
  KanbanTaskType,
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
  generateBoardFromDescription,
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
  transferTaskToBoard,
  updateBoard,
  updateCheckOnTask,
  updateColumn,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
} from '@wrongstack/kanban';
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
  | 'add_link';

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
}

interface KanbanToolOutput {
  ok: boolean;
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
    'Manage project-scoped multi-kanban boards stored under .wrongstack/kanbans. Supports board/task/column CRUD, ready-task queues, dependency chains, split/merge, assignment metadata, provider/model/fallback routing hints, goal metrics, success checks, notes, links, and run status updates.',
  usageHint:
    'Use this for durable project kanban state. Agents should call snapshot/ready_tasks, then claim_task before working. Use set_chain for ordered work, split_task/merge_tasks when task scope changes, assign_task with provider/model/fallback hints before spawning, mark_assignment when starting or finishing, and release_task if the claim cannot be worked.',
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
      assignmentStatus: {
        type: 'string',
        enum: ['assigned', 'queued', 'running', 'completed', 'failed', 'cancelled'],
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
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot;
    if (!projectRoot) return fail('No project root is available.');

    try {
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
          });
          return { ok: true, message: `Board created: ${board.title}`, board };
        }
        case 'update_board': {
          if (!input.boardId) return fail('update_board requires boardId.');
          const board = await updateBoard(projectRoot, input.boardId, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
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
          const boardInput = generateBoardFromDescription({
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
          return result
            ? okTask(result.board, result.task, 'Task added.')
            : fail('Board not found.');
        }
        case 'split_task': {
          if (!input.boardId || !input.taskId || !input.childTitles?.length) {
            return fail('split_task requires boardId, taskId, and childTitles.');
          }
          const result = await splitTask(projectRoot, input.boardId, input.taskId, {
            titles: input.childTitles,
            ...(input.targetColumnId !== undefined ? { columnId: input.targetColumnId } : {}),
            ...(input.inheritAssignment !== undefined
              ? { inheritAssignment: input.inheritAssignment }
              : {}),
            ...(input.inheritLabels !== undefined ? { inheritLabels: input.inheritLabels } : {}),
            ...(input.inheritSuccessCriteria !== undefined
              ? { inheritSuccessCriteria: input.inheritSuccessCriteria }
              : {}),
            ...(input.inheritGoalMetrics !== undefined
              ? { inheritGoalMetrics: input.inheritGoalMetrics }
              : {}),
            ...(input.inheritDependencies !== undefined
              ? { inheritDependencies: input.inheritDependencies }
              : {}),
            ...(input.chainChildren !== undefined ? { chainChildren: input.chainChildren } : {}),
            ...(input.rewireDependents !== undefined
              ? { rewireDependents: input.rewireDependents }
              : {}),
          });
          return result
            ? {
                ok: true,
                message: `${result.children.length} child task(s) created.`,
                board: result.board,
                task: result.parent,
                children: result.children,
              }
            : fail('Task not found.');
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
          const board = await updateTaskAssignment(projectRoot, input.boardId, input.taskId, {
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
          });
          return board ? okBoard(board, 'Assignment updated.') : fail('Task not found.');
        }
        case 'heartbeat_assignment': {
          if (!input.boardId || !input.taskId) {
            return fail('heartbeat_assignment requires boardId and taskId.');
          }
          const board = await heartbeatTaskAssignment(projectRoot, input.boardId, input.taskId, {
            ...(input.heartbeatAt !== undefined ? { heartbeatAt: input.heartbeatAt } : {}),
            ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
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
        default:
          return fail(`Unknown kanban action: ${(input as { action: string }).action}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

function fail(message: string): KanbanToolOutput {
  return { ok: false, message };
}

function okBoard(board: KanbanBoard, message = 'Board loaded.'): KanbanToolOutput {
  return { ok: true, message, board };
}

function okTask(board: KanbanBoard, task: KanbanTask, message: string): KanbanToolOutput {
  return { ok: true, message, board, task };
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
    ...(assignment ? { assignment } : {}),
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
    columnId: input.columnId,
    order: input.order,
    priority: input.priority,
    ...(input.taskType !== undefined ? { type: input.taskType } : {}),
    status: input.status,
    labels: input.labels,
    assignedAgent: input.agentId,
    ...(mergedDependsOn(input) ? { dependsOn: mergedDependsOn(input) } : {}),
    ...(input.estimatedHours !== undefined ? { estimatedHours: input.estimatedHours } : {}),
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
