import type { Context } from '@wrongstack/core/agent';
import {
  getKanbanWorkbench,
  getTask,
  listTaskActivity,
  recordTaskActivity,
  removeTask,
} from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import {
  activityContext,
  fail,
  ok,
  syncSessionSource,
  touchTaskPresence,
} from './kanban-route-helpers.js';
import type { WSServerMessage } from './types.js';

export interface KanbanTaskRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  /** Tab that sent the request — the session every emitted event belongs to. */
  requestSessionId?: string | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
}

export async function handleKanbanTaskRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanTaskRouteContext,
): Promise<boolean> {
  switch (type) {
    case 'kanban.workbench':
      ok(
        ws,
        type,
        await getKanbanWorkbench(ctx.projectRoot, {
          ...(typeof payload?.limitPerLane === 'number'
            ? { limitPerLane: payload.limitPerLane }
            : {}),
          ...(typeof payload?.alertLimit === 'number' ? { alertLimit: payload.alertLimit } : {}),
        }),
      );
      return true;
    case 'kanban.task.remove':
      await handleTaskRemove(ws, type, payload, ctx);
      return true;
    case 'kanban.task.get':
      await handleTaskGet(ws, type, payload, ctx);
      return true;
    case 'kanban.task.activity':
      await handleTaskActivity(ws, type, payload, ctx);
      return true;
    case 'kanban.task.activity.add':
      await handleTaskActivityAdd(ws, type, payload, ctx);
      return true;
    default:
      return false;
  }
}

async function handleTaskRemove(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanTaskRouteContext,
): Promise<void> {
  const boardId = payload?.boardId as string | undefined;
  const taskId = payload?.taskId as string | undefined;
  if (!boardId || !taskId) {
    fail(ws, type, 'boardId and taskId required');
    return;
  }
  const task = await getTask(ctx.projectRoot, boardId, taskId);
  if (!task) {
    fail(ws, type, 'Board or task not found');
    return;
  }
  const board = await removeTask(ctx.projectRoot, boardId, taskId, activityContext(ctx));
  if (!board) {
    fail(ws, type, 'Board or task not found');
    return;
  }
  await syncSessionSource(ctx, task, true);
  ok(ws, type, { removed: true, boardId: board.id, taskId: task.id, board });
}

async function handleTaskGet(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanTaskRouteContext,
): Promise<void> {
  const boardId = payload?.boardId as string | undefined;
  const taskId = payload?.taskId as string | undefined;
  if (!boardId || !taskId) {
    fail(ws, type, 'boardId and taskId required');
    return;
  }
  const task = await getTask(ctx.projectRoot, boardId, taskId);
  if (task) {
    await touchTaskPresence(ctx, boardId, task.id);
    ok(ws, type, task);
  } else {
    fail(ws, type, 'Task not found');
  }
}

async function handleTaskActivity(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanTaskRouteContext,
): Promise<void> {
  const boardId = payload?.boardId as string | undefined;
  const taskId = payload?.taskId as string | undefined;
  if (!boardId || !taskId) {
    fail(ws, type, 'boardId and taskId required');
    return;
  }
  const presenceBoard = await touchTaskPresence(ctx, boardId, taskId);
  const events = await listTaskActivity(ctx.projectRoot, boardId, taskId, {
    ...(typeof payload?.limit === 'number' ? { limit: payload.limit } : {}),
  });
  ok(ws, type, {
    boardId,
    taskId,
    events,
    presence: presenceBoard?.presence?.filter((entry) => entry.taskId === taskId) ?? [],
  });
}

async function handleTaskActivityAdd(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanTaskRouteContext,
): Promise<void> {
  const boardId = payload?.boardId as string | undefined;
  const taskId = payload?.taskId as string | undefined;
  const kind = payload?.kind as string | undefined;
  const summary = payload?.summary as string | undefined;
  const allowedKinds = ['decision', 'attempt', 'result', 'blocker', 'observation'] as const;
  const allowedOutcomes = ['succeeded', 'failed', 'partial', 'skipped', 'unknown'] as const;
  if (!boardId || !taskId || !summary?.trim() || !allowedKinds.includes(kind as never)) {
    fail(ws, type, 'boardId, taskId, summary, and a valid activity kind required');
    return;
  }
  const requestedOutcome = payload?.outcome as string | undefined;
  const outcome = allowedOutcomes.includes(requestedOutcome as never)
    ? (requestedOutcome as (typeof allowedOutcomes)[number])
    : 'unknown';
  const board = await recordTaskActivity(
    ctx.projectRoot,
    boardId,
    taskId,
    {
      kind: kind as (typeof allowedKinds)[number],
      summary: summary.trim(),
      outcome,
      ...(typeof payload?.details === 'string' && payload.details.trim()
        ? { details: payload.details.trim() }
        : {}),
    },
    activityContext(ctx, (payload?.actor as string | undefined) ?? ctx.context?.agentId ?? 'webui'),
  );
  board ? ok(ws, type, board) : fail(ws, type, 'Board or task not found');
}
