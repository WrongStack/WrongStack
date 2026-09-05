import type { Context } from '@wrongstack/core/agent';
import {
  addCheckToTask,
  addGoalMetricToTask,
  addNoteToTask,
  assignTask,
  claimReadyTask,
  type KanbanCheckType,
  type KanbanTask,
  reconcileKanbanBoard,
  releaseTaskClaim,
  updateCheckOnTask,
  updateGoalMetricOnTask,
} from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import { activityContext, fail, findTask, has, ok } from './kanban-route-helpers.js';
import type { WSServerMessage } from './types.js';

export interface KanbanItemRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  requestSessionId?: string | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
}

export async function handleKanbanItemRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanItemRouteContext,
): Promise<boolean> {
  switch (type) {
    case 'kanban.task.claim': {
      const result = await claimReadyTask(
        ctx.projectRoot,
        {
          ...(payload?.boardId ? { boardId: payload.boardId as string } : {}),
          ...(payload?.taskId ? { taskId: payload.taskId as string } : {}),
          ...(payload?.agentId ? { agentId: payload.agentId as string } : {}),
          ...(payload?.name ? { name: payload.name as string } : {}),
          ...(payload?.role ? { role: payload.role as string } : {}),
          ...(payload?.provider ? { provider: payload.provider as string } : {}),
          ...(payload?.model ? { model: payload.model as string } : {}),
          ...(payload?.modelRouting
            ? { modelRouting: payload.modelRouting as 'session' | 'fixed' | 'fallback_profile' }
            : {}),
          ...(payload?.fallbackProfile
            ? { fallbackProfile: payload.fallbackProfile as string }
            : {}),
          ...(payload?.fallbackModels
            ? { fallbackModels: payload.fallbackModels as string[] }
            : {}),
          ...(payload?.skills ? { skills: payload.skills as string[] } : {}),
          ...(payload?.tools ? { tools: payload.tools as string[] } : {}),
          ...(payload?.allowedCapabilities
            ? { allowedCapabilities: payload.allowedCapabilities as string[] }
            : {}),
          ...(payload?.assignee ? { assignee: payload.assignee as string } : {}),
          status:
            (payload?.assignmentStatus as 'assigned' | 'queued' | 'running' | undefined) ??
            'queued',
        },
        activityContext(ctx),
      );
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
      const board = await releaseTaskClaim(
        ctx.projectRoot,
        boardId,
        taskId,
        {
          ...(payload?.status ? { status: payload.status as 'pending' | 'ready' | 'blocked' } : {}),
          ...(payload?.reason ? { reason: payload.reason as string } : {}),
          ...(typeof payload?.clearAssignee === 'boolean'
            ? { clearAssignee: payload.clearAssignee }
            : {}),
          ...(typeof payload?.maxAttempts === 'number' ? { maxAttempts: payload.maxAttempts } : {}),
          ...(typeof payload?.costCeilingUsd === 'number'
            ? { costCeilingUsd: payload.costCeilingUsd }
            : {}),
          ...(payload?.retryPolicy
            ? { retryPolicy: payload.retryPolicy as NonNullable<KanbanTask['retryPolicy']> }
            : {}),
        },
        activityContext(ctx),
      );
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
      const board = await addGoalMetricToTask(
        ctx.projectRoot,
        boardId,
        taskId,
        {
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
        },
        activityContext(
          ctx,
          'webui',
          (payload?.activityNote as string | undefined) ?? `Goal metric added: ${name}.`,
        ),
      );
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
      const board = await updateGoalMetricOnTask(
        ctx.projectRoot,
        boardId,
        taskId,
        metricId,
        {
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
        },
        activityContext(
          ctx,
          'webui',
          (payload?.activityNote as string | undefined) ?? 'Goal metric updated in WebUI.',
        ),
      );
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
      const board = await assignTask(
        ctx.projectRoot,
        boardId,
        taskId,
        {
          ...(payload?.agentId ? { agentId: payload.agentId as string } : {}),
          ...(payload?.name ? { name: payload.name as string } : {}),
          ...(payload?.role ? { role: payload.role as string } : {}),
          ...(payload?.provider ? { provider: payload.provider as string } : {}),
          ...(payload?.model ? { model: payload.model as string } : {}),
          ...(payload?.modelRouting
            ? { modelRouting: payload.modelRouting as 'session' | 'fixed' | 'fallback_profile' }
            : {}),
          ...(payload?.fallbackProfile
            ? { fallbackProfile: payload.fallbackProfile as string }
            : {}),
          ...(payload?.fallbackModels
            ? { fallbackModels: payload.fallbackModels as string[] }
            : {}),
          ...(payload?.skills ? { skills: payload.skills as string[] } : {}),
          ...(payload?.tools ? { tools: payload.tools as string[] } : {}),
          ...(payload?.allowedCapabilities
            ? { allowedCapabilities: payload.allowedCapabilities as string[] }
            : {}),
          ...(payload?.assignee ? { assignee: payload.assignee as string } : {}),
          ...(payload?.maxAttempts !== undefined
            ? { maxAttempts: Number(payload.maxAttempts) }
            : {}),
          ...(payload?.costCeilingUsd !== undefined
            ? { costCeilingUsd: Number(payload.costCeilingUsd) }
            : {}),
          ...(payload?.retryPolicy
            ? { retryPolicy: payload.retryPolicy as NonNullable<KanbanTask['retryPolicy']> }
            : {}),
        },
        activityContext(ctx, undefined, payload?.activityNote as string | undefined),
      );
      board
        ? ok(ws, type, findTask(board.tasks, taskId))
        : fail(ws, type, 'Board or task not found');
      return true;
    }
    case 'kanban.task.check.add': {
      const boardId = payload?.boardId as string | undefined;
      const taskId = payload?.taskId as string | undefined;
      const description = payload?.description as string | undefined;
      if (!boardId || !taskId || !description) {
        fail(ws, type, 'boardId, taskId, and description required');
        return true;
      }
      const board = await addCheckToTask(
        ctx.projectRoot,
        boardId,
        taskId,
        {
          description,
          type: (payload?.checkType as KanbanCheckType) ?? 'manual',
          status: (payload?.status as 'pending' | 'passed' | 'failed' | 'skipped') ?? 'pending',
          ...(typeof payload?.notes === 'string' ? { notes: payload.notes } : {}),
        },
        activityContext(
          ctx,
          'webui',
          (payload?.activityNote as string | undefined) ??
            `Acceptance check added: ${description}.`,
        ),
      );
      board ? ok(ws, type, board) : fail(ws, type, 'Board or task not found');
      return true;
    }
    case 'kanban.task.check.update': {
      const boardId = payload?.boardId as string | undefined;
      const taskId = payload?.taskId as string | undefined;
      const checkId = payload?.checkId as string | undefined;
      if (!boardId || !taskId || !checkId) {
        fail(ws, type, 'boardId, taskId, and checkId required');
        return true;
      }
      const board = await updateCheckOnTask(
        ctx.projectRoot,
        boardId,
        taskId,
        checkId,
        {
          ...(has(payload, 'status')
            ? { status: payload?.status as 'pending' | 'passed' | 'failed' | 'skipped' }
            : {}),
        },
        activityContext(
          ctx,
          'webui',
          (payload?.activityNote as string | undefined) ??
            `Acceptance check updated${payload?.status ? ` to ${String(payload.status)}` : ''}.`,
        ),
      );
      if (!board) fail(ws, type, 'Check not found');
      else {
        ok(
          ws,
          type,
          (await reconcileKanbanBoard(ctx.projectRoot, boardId, activityContext(ctx)))?.board ??
            board,
        );
      }
      return true;
    }
    case 'kanban.task.note.add': {
      const boardId = payload?.boardId as string | undefined;
      const taskId = payload?.taskId as string | undefined;
      const content = payload?.content as string | undefined;
      if (!boardId || !taskId || !content) {
        fail(ws, type, 'boardId, taskId, and content required');
        return true;
      }
      const author = (payload?.author as string | undefined) ?? 'webui';
      const board = await addNoteToTask(
        ctx.projectRoot,
        boardId,
        taskId,
        {
          author,
          content,
        },
        activityContext(ctx, author),
      );
      board ? ok(ws, type, board) : fail(ws, type, 'Board or task not found');
      return true;
    }
    default:
      return false;
  }
}
