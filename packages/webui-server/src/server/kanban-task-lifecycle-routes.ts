import type { Context } from '@wrongstack/core/agent';
import {
  addTask,
  copyTaskToBoard,
  type KanbanLifecycleStage,
  type KanbanLink,
  type KanbanTask,
  type KanbanTaskPriority,
  type KanbanTaskStatus,
  type KanbanTaskTransitionInput,
  mergeTasks,
  moveTask,
  splitTask,
  transferTaskToBoard,
  transitionTask,
  updateTask,
} from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import {
  activityContext,
  fail,
  findTask,
  has,
  ok,
  syncSessionSource,
} from './kanban-route-helpers.js';
import type { WSServerMessage } from './types.js';

export interface KanbanTaskLifecycleRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  requestSessionId?: string | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
}

export async function handleKanbanTaskLifecycleRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanTaskLifecycleRouteContext,
): Promise<boolean> {
  switch (type) {
    case 'kanban.task.add': {
      const boardId = payload?.boardId as string | undefined;
      const title = payload?.title as string | undefined;
      if (!boardId || !title) {
        fail(ws, type, 'boardId and title required');
        return true;
      }
      const result = await addTask(
        ctx.projectRoot,
        boardId,
        {
          title,
          columnId: (payload?.columnId as string | undefined) ?? 'backlog',
          ...(payload?.description ? { description: payload.description as string } : {}),
          ...(payload?.dueDate ? { dueDate: payload.dueDate as string } : {}),
          ...(payload?.priority ? { priority: payload.priority as KanbanTaskPriority } : {}),
          ...(payload?.assignedAgent ? { assignedAgent: payload.assignedAgent as string } : {}),
          ...(payload?.labels ? { labels: payload.labels as string[] } : {}),
          ...(has(payload, 'boundary')
            ? { boundary: payload?.boundary as NonNullable<KanbanTask['boundary']> }
            : {}),
        },
        activityContext(ctx, 'webui', payload?.activityNote as string | undefined),
      );
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
      const result = await splitTask(
        ctx.projectRoot,
        boardId,
        taskId,
        {
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
        },
        activityContext(ctx),
      );
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
      const result = await mergeTasks(
        ctx.projectRoot,
        boardId,
        {
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
        },
        activityContext(ctx),
      );
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
      const board = await updateTask(
        ctx.projectRoot,
        boardId,
        taskId,
        {
          ...(has(payload, 'title') ? { title: payload?.title as string } : {}),
          ...(has(payload, 'description')
            ? { description: (payload?.description as string | undefined) ?? '' }
            : {}),
          ...(has(payload, 'dueDate')
            ? { dueDate: (payload?.dueDate as string | null | undefined) ?? null }
            : {}),
          ...(has(payload, 'columnId') ? { columnId: payload?.columnId as string } : {}),
          ...(has(payload, 'priority')
            ? { priority: payload?.priority as KanbanTaskPriority }
            : {}),
          ...(has(payload, 'type')
            ? { type: payload?.type as NonNullable<KanbanTask['type']> }
            : {}),
          ...(has(payload, 'status') ? { status: payload?.status as KanbanTaskStatus } : {}),
          ...(has(payload, 'dependsOn')
            ? { dependsOn: (payload?.dependsOn as string[] | undefined) ?? [] }
            : {}),
          ...(has(payload, 'chain')
            ? { chain: (payload?.chain as KanbanTask['chain'] | null | undefined) ?? null }
            : {}),
          ...(has(payload, 'labels')
            ? { labels: (payload?.labels as string[] | undefined) ?? [] }
            : {}),
          ...(has(payload, 'estimatedHours')
            ? { estimatedHours: Number(payload?.estimatedHours ?? 0) }
            : {}),
          ...(has(payload, 'actualHours')
            ? { actualHours: Number(payload?.actualHours ?? 0) }
            : {}),
          ...(has(payload, 'retryPolicy')
            ? {
                retryPolicy:
                  (payload?.retryPolicy as KanbanTask['retryPolicy'] | null | undefined) ?? null,
              }
            : {}),
          ...(has(payload, 'costCeilingUsd')
            ? {
                costCeilingUsd:
                  payload?.costCeilingUsd === null || payload?.costCeilingUsd === ''
                    ? null
                    : Number(payload?.costCeilingUsd),
              }
            : {}),
          ...(has(payload, 'boundary')
            ? {
                boundary: (payload?.boundary as KanbanTask['boundary'] | null | undefined) ?? null,
              }
            : {}),
        },
        activityContext(ctx, 'webui', payload?.activityNote as string | undefined),
      );
      if (!board) {
        fail(ws, type, 'Board or task not found');
        return true;
      }
      const task = findTask(board.tasks, taskId);
      if (task) await syncSessionSource(ctx, task);
      ok(ws, type, task);
      return true;
    }
    case 'kanban.task.transition': {
      const boardId = payload?.boardId as string | undefined;
      const taskId = payload?.taskId as string | undefined;
      const to = payload?.to as KanbanLifecycleStage | undefined;
      const actor = payload?.actor as string | undefined;
      const comment = payload?.comment as string | undefined;
      if (!boardId || !taskId || !to || !actor || !comment) {
        fail(ws, type, 'boardId, taskId, to, actor, and comment required');
        return true;
      }
      const result = await transitionTask(ctx.projectRoot, boardId, taskId, {
        to,
        sessionId: activityContext(ctx).sessionId,
        actor,
        comment,
        ...(payload?.action ? { action: payload.action as string } : {}),
        ...(payload?.attachment ? { attachment: payload.attachment as KanbanLink } : {}),
        ...(payload?.patch
          ? { patch: payload.patch as NonNullable<KanbanTaskTransitionInput['patch']> }
          : {}),
      });
      if (!result) {
        fail(ws, type, 'Board or task not found');
        return true;
      }
      await syncSessionSource(ctx, result.task);
      ok(ws, type, result);
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
        activityContext(ctx, 'webui', payload?.activityNote as string | undefined),
      );
      if (!board) {
        fail(ws, type, 'Move failed');
        return true;
      }
      const task = findTask(board.tasks, taskId);
      if (task) await syncSessionSource(ctx, task);
      ok(ws, type, task);
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
              eventContext: activityContext(ctx),
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
              eventContext: activityContext(ctx),
            });
      result ? ok(ws, type, result.targetBoard) : fail(ws, type, 'Board or task not found');
      return true;
    }
    default:
      return false;
  }
}
