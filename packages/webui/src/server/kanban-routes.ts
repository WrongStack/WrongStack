import {
  addColumn,
  addGoalMetricToTask,
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  deserializeTaskGraph,
  duplicateBoard,
  exportBoardToTaskGraph,
  generateBoardFromDescription,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  getTask,
  getTaskChain,
  type KanbanColumn,
  type KanbanTask,
  type KanbanTaskPriority,
  type KanbanTaskStatus,
  listReadyTasks,
  listBoards,
  mergeTasks,
  moveTask,
  parseLinesIntoTasks,
  removeBoard,
  removeColumn,
  removeTask,
  releaseTaskClaim,
  type SerializableTaskGraph,
  serializeTaskGraph,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transferTaskToBoard,
  updateBoard,
  updateGoalMetricOnTask,
  updateTask,
} from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';
import { send } from './ws-utils.js';

export interface KanbanRouteContext {
  projectRoot: string;
}

function ok(ws: WebSocket, type: string, data?: unknown): void {
  send(ws, { type, payload: { success: true, data: data ?? null } });
}

function fail(ws: WebSocket, type: string, message: string): void {
  send(ws, { type, payload: { success: false, error: message } });
}

export async function handleKanbanRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  ctx: KanbanRouteContext,
): Promise<boolean> {
  if (!msg.type.startsWith('kanban.')) return false;
  const payload = msg.payload as Record<string, unknown> | undefined;
  const type = msg.type;

  try {
    switch (type) {
      case 'kanban.list':
        ok(ws, type, await listBoards(ctx.projectRoot));
        return true;
      case 'kanban.get': {
        const boardId = payload?.boardId as string | undefined;
        if (!boardId) {
          fail(ws, type, 'boardId required');
          return true;
        }
        const board = await getBoard(ctx.projectRoot, boardId);
        board ? ok(ws, type, board) : fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      case 'kanban.health': {
        const hBoardId = payload?.boardId as string | undefined;
        if (!hBoardId) {
          fail(ws, type, 'boardId required');
          return true;
        }
        ok(ws, type, await getKanbanQueueHealth(ctx.projectRoot, { boardId: hBoardId }));
        return true;
      }
      case 'kanban.create': {
        const title = payload?.title as string | undefined;
        if (!title) {
          fail(ws, type, 'title required');
          return true;
        }
        ok(
          ws,
          type,
          await createBoard(ctx.projectRoot, {
            title,
            ...(payload?.description ? { description: payload.description as string } : {}),
            ...(payload?.tags ? { tags: payload.tags as string[] } : {}),
            ...(payload?.columns ? { columns: payload.columns as KanbanColumn[] } : {}),
          }),
        );
        return true;
      }
      case 'kanban.update': {
        const boardId = payload?.boardId as string | undefined;
        if (!boardId) {
          fail(ws, type, 'boardId required');
          return true;
        }
        const board = await updateBoard(ctx.projectRoot, boardId, {
          ...(payload?.title ? { title: payload.title as string } : {}),
          ...(payload?.description ? { description: payload.description as string } : {}),
          ...(payload?.tags ? { tags: payload.tags as string[] } : {}),
          ...(payload?.columns ? { columns: payload.columns as KanbanColumn[] } : {}),
        });
        board ? ok(ws, type, board) : fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      case 'kanban.duplicate': {
        const boardId = payload?.boardId as string | undefined;
        if (!boardId) {
          fail(ws, type, 'boardId required');
          return true;
        }
        const board = await duplicateBoard(ctx.projectRoot, boardId, {
          ...(payload?.title ? { title: payload.title as string } : {}),
          ...(typeof payload?.includeTasks === 'boolean'
            ? { includeTasks: payload.includeTasks }
            : {}),
          ...(typeof payload?.includeCompletedTasks === 'boolean'
            ? { includeCompletedTasks: payload.includeCompletedTasks }
            : {}),
          ...(typeof payload?.preserveAssignment === 'boolean'
            ? { preserveAssignment: payload.preserveAssignment }
            : {}),
        });
        board ? ok(ws, type, board) : fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      case 'kanban.delete': {
        const boardId = payload?.boardId as string | undefined;
        if (!boardId) {
          fail(ws, type, 'boardId required');
          return true;
        }
        const board = await getBoard(ctx.projectRoot, boardId);
        ok(ws, type, {
          removed: board ? await removeBoard(ctx.projectRoot, board.id) : false,
          boardId: board?.id ?? boardId,
        });
        return true;
      }
      case 'kanban.generate': {
        const description = payload?.description as string | undefined;
        if (!description) {
          fail(ws, type, 'description required');
          return true;
        }
        const board = await createBoard(
          ctx.projectRoot,
          generateBoardFromDescription({
            description,
            ...(payload?.title ? { title: payload.title as string } : {}),
            ...(payload?.context ? { context: payload.context as string } : {}),
          }),
        );
        for (const taskInput of parseLinesIntoTasks(
          description,
          board.columns[0]?.id ?? 'backlog',
        )) {
          await addTask(ctx.projectRoot, board.id, taskInput);
        }
        ok(ws, type, (await getBoard(ctx.projectRoot, board.id)) ?? board);
        return true;
      }
      case 'kanban.task.ready': {
        ok(
          ws,
          type,
          await listReadyTasks(ctx.projectRoot, {
            ...(payload?.boardId ? { boardId: payload.boardId as string } : {}),
            ...(payload?.query ? { query: payload.query as string } : {}),
            ...(payload?.assignedAgent ? { assignedAgent: payload.assignedAgent as string } : {}),
            ...(payload?.priority ? { priority: payload.priority as KanbanTaskPriority } : {}),
            ...(payload?.label ? { label: payload.label as string } : {}),
            ...(payload?.chainId ? { chainId: payload.chainId as string } : {}),
            ...(typeof payload?.limit === 'number' ? { limit: payload.limit } : {}),
          }),
        );
        return true;
      }
      case 'kanban.snapshot': {
        ok(
          ws,
          type,
          await getKanbanOrchestrationSnapshot(ctx.projectRoot, {
            ...(payload?.boardId ? { boardId: payload.boardId as string } : {}),
            ...(payload?.query ? { query: payload.query as string } : {}),
            ...(payload?.assignedAgent ? { assignedAgent: payload.assignedAgent as string } : {}),
            ...(payload?.priority ? { priority: payload.priority as KanbanTaskPriority } : {}),
            ...(payload?.status ? { status: payload.status as KanbanTaskStatus } : {}),
            ...(payload?.label ? { label: payload.label as string } : {}),
            ...(payload?.chainId ? { chainId: payload.chainId as string } : {}),
          }),
        );
        return true;
      }
      case 'kanban.taskgraph.export': {
        const boardId = payload?.boardId as string | undefined;
        if (!boardId) {
          fail(ws, type, 'boardId required');
          return true;
        }
        const exported = await exportBoardToTaskGraph(ctx.projectRoot, boardId, {
          ...(payload?.graphId ? { graphId: payload.graphId as string } : {}),
          ...(payload?.specId ? { specId: payload.specId as string } : {}),
          ...(payload?.title ? { title: payload.title as string } : {}),
          ...(typeof payload?.preserveOriginTaskIds === 'boolean'
            ? { preserveOriginTaskIds: payload.preserveOriginTaskIds }
            : {}),
          ...(typeof payload?.includeArchived === 'boolean'
            ? { includeArchived: payload.includeArchived }
            : {}),
        });
        exported
          ? ok(ws, type, { board: exported.board, taskGraph: serializeTaskGraph(exported.graph) })
          : fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      case 'kanban.taskgraph.sync': {
        const boardId = payload?.boardId as string | undefined;
        const taskGraph = payload?.taskGraph as SerializableTaskGraph | undefined;
        if (!boardId || !taskGraph) {
          fail(ws, type, 'boardId and taskGraph required');
          return true;
        }
        const result = await syncBoardFromTaskGraph(
          ctx.projectRoot,
          boardId,
          deserializeTaskGraph(taskGraph),
          {
            ...(payload?.title ? { title: payload.title as string } : {}),
            ...(payload?.description ? { description: payload.description as string } : {}),
            ...(payload?.tags ? { tags: payload.tags as string[] } : {}),
            ...(payload?.generatedBy ? { generatedBy: payload.generatedBy as string } : {}),
            ...(payload?.sourceSystem ? { sourceSystem: payload.sourceSystem as string } : {}),
            ...(payload?.phaseId ? { phaseId: payload.phaseId as string } : {}),
            ...(typeof payload?.includeCompletedTasks === 'boolean'
              ? { includeCompletedTasks: payload.includeCompletedTasks }
              : {}),
            ...(typeof payload?.archiveMissingTasks === 'boolean'
              ? { archiveMissingTasks: payload.archiveMissingTasks }
              : {}),
            ...(typeof payload?.preserveManualDependencies === 'boolean'
              ? { preserveManualDependencies: payload.preserveManualDependencies }
              : {}),
          },
        );
        result
          ? ok(ws, type, {
              board: result.board,
              taskIdMap: Object.fromEntries(result.taskIdMap),
              createdTaskIds: result.createdTaskIds,
              updatedTaskIds: result.updatedTaskIds,
              archivedTaskIds: result.archivedTaskIds,
            })
          : fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      case 'kanban.task.add': {
        const boardId = payload?.boardId as string | undefined;
        const title = payload?.title as string | undefined;
        if (!boardId || !title) {
          fail(ws, type, 'boardId and title required');
          return true;
        }
        const result = await addTask(ctx.projectRoot, boardId, {
          title,
          columnId: (payload?.columnId as string | undefined) ?? 'backlog',
          ...(payload?.description ? { description: payload.description as string } : {}),
          ...(payload?.priority ? { priority: payload.priority as KanbanTaskPriority } : {}),
          ...(payload?.assignedAgent ? { assignedAgent: payload.assignedAgent as string } : {}),
          ...(payload?.labels ? { labels: payload.labels as string[] } : {}),
        });
        result ? ok(ws, type, result.task) : fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      case 'kanban.task.split': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        const childTitles = payload?.childTitles as string[] | undefined;
        if (!boardId || !taskId || !childTitles?.length) {
          fail(ws, type, 'boardId, taskId, and childTitles required');
          return true;
        }
        const result = await splitTask(ctx.projectRoot, boardId, taskId, {
          titles: childTitles,
          ...(payload?.targetColumnId ? { columnId: payload.targetColumnId as string } : {}),
          ...(typeof payload?.inheritAssignment === 'boolean'
            ? { inheritAssignment: payload.inheritAssignment }
            : {}),
          ...(typeof payload?.inheritLabels === 'boolean'
            ? { inheritLabels: payload.inheritLabels }
            : {}),
          ...(typeof payload?.inheritSuccessCriteria === 'boolean'
            ? { inheritSuccessCriteria: payload.inheritSuccessCriteria }
            : {}),
          ...(typeof payload?.inheritGoalMetrics === 'boolean'
            ? { inheritGoalMetrics: payload.inheritGoalMetrics }
            : {}),
          ...(typeof payload?.inheritDependencies === 'boolean'
            ? { inheritDependencies: payload.inheritDependencies }
            : {}),
          ...(typeof payload?.chainChildren === 'boolean'
            ? { chainChildren: payload.chainChildren }
            : {}),
          ...(typeof payload?.rewireDependents === 'boolean'
            ? { rewireDependents: payload.rewireDependents }
            : {}),
        });
        result
          ? ok(ws, type, { board: result.board, parent: result.parent, children: result.children })
          : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.merge': {
        const boardId = payload?.boardId as string | undefined;
        const taskIds = payload?.taskIds as string[] | undefined;
        const title = payload?.title as string | undefined;
        if (!boardId || !taskIds?.length || !title) {
          fail(ws, type, 'boardId, taskIds, and title required');
          return true;
        }
        const result = await mergeTasks(ctx.projectRoot, boardId, {
          taskIds,
          title,
          ...(payload?.description ? { description: payload.description as string } : {}),
          ...(payload?.targetColumnId ? { targetColumnId: payload.targetColumnId as string } : {}),
          ...(typeof payload?.preserveAssignment === 'boolean'
            ? { preserveAssignment: payload.preserveAssignment }
            : {}),
          ...(typeof payload?.closeSourceTasks === 'boolean'
            ? { closeSourceTasks: payload.closeSourceTasks }
            : {}),
        });
        result
          ? ok(ws, type, {
              board: result.board,
              task: result.task,
              sourceTasks: result.sourceTasks,
            })
          : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.update': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        if (!boardId || !taskId) {
          fail(ws, type, 'boardId and taskId required');
          return true;
        }
        const board = await updateTask(ctx.projectRoot, boardId, taskId, {
          ...(payload?.title ? { title: payload.title as string } : {}),
          ...(payload?.description ? { description: payload.description as string } : {}),
          ...(payload?.columnId ? { columnId: payload.columnId as string } : {}),
          ...(payload?.priority ? { priority: payload.priority as KanbanTaskPriority } : {}),
          ...(payload?.status ? { status: payload.status as KanbanTaskStatus } : {}),
          ...(payload?.assignedAgent ? { assignedAgent: payload.assignedAgent as string } : {}),
          ...(payload?.labels ? { labels: payload.labels as string[] } : {}),
        });
        board
          ? ok(ws, type, findTask(board.tasks, taskId))
          : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.move': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        const columnId = payload?.columnId as string | undefined;
        if (!boardId || !taskId || !columnId) {
          fail(ws, type, 'boardId, taskId, columnId required');
          return true;
        }
        const board = await moveTask(
          ctx.projectRoot,
          boardId,
          taskId,
          columnId,
          payload?.order as number | undefined,
        );
        board ? ok(ws, type, findTask(board.tasks, taskId)) : fail(ws, type, 'Move failed');
        return true;
      }
      case 'kanban.task.copy':
      case 'kanban.task.transfer': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        const targetBoardId = payload?.targetBoardId as string | undefined;
        if (!boardId || !taskId || !targetBoardId) {
          fail(ws, type, 'boardId, taskId, targetBoardId required');
          return true;
        }
        const result =
          type === 'kanban.task.copy'
            ? await copyTaskToBoard(ctx.projectRoot, boardId, taskId, targetBoardId, {
                ...(payload?.targetColumnId
                  ? { targetColumnId: payload.targetColumnId as string }
                  : {}),
                ...(typeof payload?.preserveAssignment === 'boolean'
                  ? { preserveAssignment: payload.preserveAssignment }
                  : {}),
                ...(typeof payload?.preserveDependencies === 'boolean'
                  ? { preserveDependencies: payload.preserveDependencies }
                  : {}),
              })
            : await transferTaskToBoard(ctx.projectRoot, boardId, taskId, targetBoardId, {
                ...(payload?.targetColumnId
                  ? { targetColumnId: payload.targetColumnId as string }
                  : {}),
                ...(typeof payload?.preserveAssignment === 'boolean'
                  ? { preserveAssignment: payload.preserveAssignment }
                  : {}),
                ...(typeof payload?.preserveDependencies === 'boolean'
                  ? { preserveDependencies: payload.preserveDependencies }
                  : {}),
              });
        result ? ok(ws, type, result.targetBoard) : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.chain': {
        const boardId = payload?.boardId as string | undefined;
        const taskIds = payload?.taskIds as string[] | undefined;
        if (!boardId || !taskIds?.length) {
          fail(ws, type, 'boardId and taskIds required');
          return true;
        }
        const result = await setTaskChain(ctx.projectRoot, boardId, {
          taskIds,
          ...(payload?.chainId ? { chainId: payload.chainId as string } : {}),
          ...(typeof payload?.enforceDependencies === 'boolean'
            ? { enforceDependencies: payload.enforceDependencies }
            : {}),
        });
        result
          ? ok(ws, type, { board: result.board, chainId: result.chainId, tasks: result.tasks })
          : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.chain.get': {
        const boardId = payload?.boardId as string | undefined;
        const taskOrChainId =
          (payload?.taskId as string | undefined) ?? (payload?.chainId as string | undefined);
        if (!boardId || !taskOrChainId) {
          fail(ws, type, 'boardId and taskId or chainId required');
          return true;
        }
        const result = await getTaskChain(ctx.projectRoot, boardId, taskOrChainId);
        result
          ? ok(ws, type, { board: result.board, chainId: result.chainId, tasks: result.tasks })
          : fail(ws, type, 'Chain not found');
        return true;
      }
      case 'kanban.task.claim': {
        const result = await claimReadyTask(ctx.projectRoot, {
          ...(payload?.boardId ? { boardId: payload.boardId as string } : {}),
          ...(payload?.taskId ? { taskId: payload.taskId as string } : {}),
          ...(payload?.agentId ? { agentId: payload.agentId as string } : {}),
          ...(payload?.name ? { name: payload.name as string } : {}),
          ...(payload?.role ? { role: payload.role as string } : {}),
          ...(payload?.provider ? { provider: payload.provider as string } : {}),
          ...(payload?.model ? { model: payload.model as string } : {}),
          ...(payload?.fallbackProfile
            ? { fallbackProfile: payload.fallbackProfile as string }
            : {}),
          ...(payload?.fallbackModels
            ? { fallbackModels: payload.fallbackModels as string[] }
            : {}),
          ...(payload?.tools ? { tools: payload.tools as string[] } : {}),
          ...(payload?.allowedCapabilities
            ? { allowedCapabilities: payload.allowedCapabilities as string[] }
            : {}),
          ...(payload?.assignee ? { assignee: payload.assignee as string } : {}),
          status:
            (payload?.assignmentStatus as 'assigned' | 'queued' | 'running' | undefined) ??
            'queued',
        });
        result
          ? ok(ws, type, { board: result.board, task: result.task })
          : fail(ws, type, 'No ready kanban task matched the claim');
        return true;
      }
      case 'kanban.task.release': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        if (!boardId || !taskId) {
          fail(ws, type, 'boardId and taskId required');
          return true;
        }
        const board = await releaseTaskClaim(ctx.projectRoot, boardId, taskId, {
          ...(payload?.status ? { status: payload.status as 'pending' | 'ready' | 'blocked' } : {}),
          ...(payload?.reason ? { reason: payload.reason as string } : {}),
          ...(typeof payload?.clearAssignee === 'boolean'
            ? { clearAssignee: payload.clearAssignee }
            : {}),
        });
        board ? ok(ws, type, board) : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.metric.add': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        const name = payload?.name as string | undefined;
        if (!boardId || !taskId || !name) {
          fail(ws, type, 'boardId, taskId, and name required');
          return true;
        }
        const board = await addGoalMetricToTask(ctx.projectRoot, boardId, taskId, {
          name,
          ...(payload?.status
            ? { status: payload.status as 'pending' | 'met' | 'missed' | 'waived' }
            : {}),
          ...(payload?.target !== undefined ? { target: payload.target as string | number } : {}),
          ...(payload?.current !== undefined
            ? { current: payload.current as string | number }
            : {}),
          ...(payload?.unit ? { unit: payload.unit as string } : {}),
          ...(payload?.notes ? { notes: payload.notes as string } : {}),
        });
        board ? ok(ws, type, board) : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.metric.update': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        const metricId = payload?.metricId as string | undefined;
        if (!boardId || !taskId || !metricId) {
          fail(ws, type, 'boardId, taskId, and metricId required');
          return true;
        }
        const board = await updateGoalMetricOnTask(ctx.projectRoot, boardId, taskId, metricId, {
          ...(payload?.name ? { name: payload.name as string } : {}),
          ...(payload?.status
            ? { status: payload.status as 'pending' | 'met' | 'missed' | 'waived' }
            : {}),
          ...(payload?.target !== undefined ? { target: payload.target as string | number } : {}),
          ...(payload?.current !== undefined
            ? { current: payload.current as string | number }
            : {}),
          ...(payload?.unit ? { unit: payload.unit as string } : {}),
          ...(payload?.notes ? { notes: payload.notes as string } : {}),
        });
        board ? ok(ws, type, board) : fail(ws, type, 'Metric not found');
        return true;
      }
      case 'kanban.task.assign': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        if (!boardId || !taskId) {
          fail(ws, type, 'boardId and taskId required');
          return true;
        }
        const board = await assignTask(ctx.projectRoot, boardId, taskId, {
          ...(payload?.agentId ? { agentId: payload.agentId as string } : {}),
          ...(payload?.name ? { name: payload.name as string } : {}),
          ...(payload?.role ? { role: payload.role as string } : {}),
          ...(payload?.provider ? { provider: payload.provider as string } : {}),
          ...(payload?.model ? { model: payload.model as string } : {}),
          ...(payload?.fallbackProfile
            ? { fallbackProfile: payload.fallbackProfile as string }
            : {}),
          ...(payload?.fallbackModels
            ? { fallbackModels: payload.fallbackModels as string[] }
            : {}),
          ...(payload?.tools ? { tools: payload.tools as string[] } : {}),
          ...(payload?.allowedCapabilities
            ? { allowedCapabilities: payload.allowedCapabilities as string[] }
            : {}),
        });
        board
          ? ok(ws, type, findTask(board.tasks, taskId))
          : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.dispatch':
        fail(
          ws,
          type,
          'Kanban agent dispatch is only available from the CLI-hosted WebUI runtime.',
        );
        return true;
      case 'kanban.task.remove': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        if (!boardId || !taskId) {
          fail(ws, type, 'boardId and taskId required');
          return true;
        }
        const task = await getTask(ctx.projectRoot, boardId, taskId);
        if (!task) {
          fail(ws, type, 'Board or task not found');
          return true;
        }
        const board = await removeTask(ctx.projectRoot, boardId, taskId);
        board
          ? ok(ws, type, { removed: true, boardId: board.id, taskId: task.id, board })
          : fail(ws, type, 'Board or task not found');
        return true;
      }
      case 'kanban.task.get': {
        const boardId = payload?.boardId as string | undefined;
        const taskId = payload?.taskId as string | undefined;
        if (!boardId || !taskId) {
          fail(ws, type, 'boardId and taskId required');
          return true;
        }
        const task = await getTask(ctx.projectRoot, boardId, taskId);
        task ? ok(ws, type, task) : fail(ws, type, 'Task not found');
        return true;
      }
      case 'kanban.column.add': {
        const boardId = payload?.boardId as string | undefined;
        const title = payload?.title as string | undefined;
        if (!boardId || !title) {
          fail(ws, type, 'boardId and title required');
          return true;
        }
        const result = await addColumn(ctx.projectRoot, boardId, { title });
        result ? ok(ws, type, result.board.columns) : fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      case 'kanban.column.remove': {
        const boardId = payload?.boardId as string | undefined;
        const columnId = payload?.columnId as string | undefined;
        if (!boardId || !columnId) {
          fail(ws, type, 'boardId and columnId required');
          return true;
        }
        const board = await removeColumn(ctx.projectRoot, boardId, columnId, {
          moveTasksToColumnId: payload?.moveTasksToColumnId as string | undefined,
        });
        board
          ? ok(ws, type, { removed: true, boardId: board.id, columnId, board })
          : fail(ws, type, `Column not found: ${columnId}`);
        return true;
      }
      default:
        fail(ws, type, `Unknown kanban message type: ${type}`);
        return true;
    }
  } catch (err) {
    fail(ws, type, err instanceof Error ? err.message : String(err));
    return true;
  }
}

function findTask(tasks: KanbanTask[], taskId: string): KanbanTask | undefined {
  return tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
}
