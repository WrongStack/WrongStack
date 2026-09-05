import type { Context } from '@wrongstack/core/agent';
import { deserializeTaskGraph, serializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializableTaskGraph } from '@wrongstack/core/types';
import {
  exportBoardToTaskGraph,
  getKanbanOrchestrationSnapshot,
  getTaskChain,
  type KanbanTaskPriority,
  type KanbanTaskStatus,
  listReadyTasks,
  setTaskChain,
  syncBoardFromTaskGraph,
} from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import { activityContext, fail, ok } from './kanban-route-helpers.js';

export interface KanbanOrchestrationRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  requestSessionId?: string | undefined;
}

export async function handleKanbanOrchestrationRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanOrchestrationRouteContext,
): Promise<boolean> {
  switch (type) {
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
    case 'kanban.task.chain': {
      const boardId = payload?.boardId as string | undefined;
      const taskIds = payload?.taskIds as string[] | undefined;
      if (!boardId || !taskIds?.length) {
        fail(ws, type, 'boardId and taskIds required');
        return true;
      }
      const result = await setTaskChain(
        ctx.projectRoot,
        boardId,
        {
          taskIds,
          ...(payload?.chainId ? { chainId: payload.chainId as string } : {}),
          ...(typeof payload?.enforceDependencies === 'boolean'
            ? { enforceDependencies: payload.enforceDependencies }
            : {}),
        },
        activityContext(ctx),
      );
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
    default:
      return false;
  }
}
