import type { Context } from '@wrongstack/core/agent';
import {
  type KanbanDecompositionSubtask,
  listBoards,
  resolveDecompositionProposal,
  updateTask,
  verifyTaskCompletion,
} from '@wrongstack/kanban';
import { recordKanbanVerificationEvidence } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { kanbanBoardMessage, publishKanbanBoard } from './kanban-broadcast.js';
import { activityContext, fail, ok } from './kanban-route-helpers.js';
import type { WSServerMessage } from './types.js';

export interface KanbanDecompositionRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  /** Tab that sent the request — the session every emitted event belongs to. */
  requestSessionId?: string | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
}

export async function handleKanbanDecompositionRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanDecompositionRouteContext,
): Promise<boolean> {
  switch (type) {
    case 'kanban.decomposition.approve':
    case 'kanban.decomposition.reject':
      await handleDecompositionResolution(ws, type, payload, ctx);
      return true;
    case 'kanban.task.verify':
      await handleTaskVerification(ws, type, payload, ctx);
      return true;
    default:
      return false;
  }
}

async function handleDecompositionResolution(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanDecompositionRouteContext,
): Promise<void> {
  const boardId = payload?.boardId as string | undefined;
  const taskId = payload?.taskId as string | undefined;
  const proposalId = payload?.proposalId as string | undefined;
  if (!boardId || !taskId || !proposalId) {
    fail(ws, type, 'boardId, taskId, and proposalId required');
    return;
  }
  const action = type === 'kanban.decomposition.approve' ? 'approve' : 'reject';
  let edits: KanbanDecompositionSubtask[] | undefined;
  if (Array.isArray(payload?.edits)) {
    const rawEdits = payload.edits as unknown[];
    const valid = rawEdits.every(
      (e): e is KanbanDecompositionSubtask =>
        e !== null &&
        typeof e === 'object' &&
        typeof (e as Record<string, unknown>).title === 'string',
    );
    if (!valid) {
      fail(ws, type, 'Each edit must be an object with a string "title"');
      return;
    }
    edits = rawEdits;
  }
  const resolved = await resolveDecompositionProposal(
    ctx.projectRoot,
    boardId,
    taskId,
    proposalId,
    {
      action,
      ...(typeof payload?.reason === 'string' ? { reason: payload.reason } : {}),
      ...(edits ? { editedSubtasks: edits } : {}),
      resolvedBy: 'webui',
    },
    activityContext(ctx, 'webui'),
  );
  if (!resolved) {
    fail(ws, type, `Proposal not found or already resolved: ${proposalId}`);
    return;
  }
  ok(ws, type, { boardId, task: resolved.task });
  if (action === 'approve') {
    ctx.broadcast?.({
      type: 'kanban.decomposition.applied',
      payload: { success: true, data: { board: resolved.board } },
    });
    // Decomposition can add a board, so the list really does change here.
    await publishKanbanBoard(
      (message) => ctx.broadcast?.(message),
      resolved.board,
      () => listBoards(ctx.projectRoot),
    );
  } else {
    ctx.broadcast?.({
      type: 'kanban.decomposition.resolved',
      payload: { success: true, data: { boardId, task: resolved.task } },
    });
  }
}

async function handleTaskVerification(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanDecompositionRouteContext,
): Promise<void> {
  const boardId = payload?.boardId as string | undefined;
  const taskId = payload?.taskId as string | undefined;
  if (!boardId || !taskId) {
    fail(ws, type, 'boardId and taskId required');
    return;
  }
  ctx.broadcast?.({
    type: 'kanban.task.verification_started',
    payload: { success: true, data: { boardId, taskId } },
  });
  try {
    const verResult = await verifyTaskCompletion(ctx.projectRoot, boardId, taskId);
    const persisted = await updateTask(
      ctx.projectRoot,
      boardId,
      taskId,
      {
        verificationReport: verResult.report,
        successCriteria: verResult.task.successCriteria,
      },
      activityContext(ctx, 'webui'),
    );
    const freshTask =
      persisted?.tasks.find((candidate) => candidate.id === verResult.task.id) ?? verResult.task;
    if (ctx.context) recordKanbanVerificationEvidence(ctx.context, verResult.report);
    ok(ws, type, { boardId, task: freshTask });
    ctx.broadcast?.({
      type: 'kanban.task.verification_completed',
      payload: { success: true, data: { boardId, task: freshTask } },
    });
    if (persisted) {
      ctx.broadcast?.(kanbanBoardMessage(persisted));
    }
  } catch (err) {
    ctx.broadcast?.({
      type: 'kanban.task.verification_completed',
      payload: {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        data: { boardId, taskId },
      },
    });
    fail(ws, type, err instanceof Error ? err.message : String(err));
  }
}
