import type { Context } from '@wrongstack/core/agent';
import {
  addTask,
  createBoard,
  createBoardFromText,
  duplicateBoard,
  getBoard,
  getKanbanQueueHealth,
  hasKanbanQueueAnomalies,
  type KanbanBoard,
  kanbanQueueAnomalyCount,
  listBoardHistory,
  listBoards,
  parseLinesIntoTasks,
  reconcileKanbanBoard,
  recoverStaleTaskAssignments,
  removeBoard,
  updateBoard,
} from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import { activityContext, fail, has, ok } from './kanban-route-helpers.js';
import { paginateKanbanBoards } from './kanban-route-pagination.js';
import type { KanbanSupervisor } from './kanban-supervisor.js';
import type { WSServerMessage } from './types.js';

export interface KanbanBoardRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  getDisplayedSessionIds?: (() => string[]) | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
  supervisor?: KanbanSupervisor | undefined;
  requestSessionId?: string | undefined;
}

export async function handleKanbanBoardRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanBoardRouteContext,
): Promise<boolean> {
  switch (type) {
    case 'kanban.list': {
      const boards = await listBoards(ctx.projectRoot);
      const requestedPage = Number(payload?.page);
      const requestedPageSize = Number(payload?.pageSize);
      if (!Number.isFinite(requestedPage) || !Number.isFinite(requestedPageSize)) {
        ok(ws, type, boards);
        return true;
      }
      const activeSessionIds = Array.isArray(payload?.activeSessionIds)
        ? payload.activeSessionIds.filter((id): id is string => typeof id === 'string')
        : [];
      ok(
        ws,
        type,
        paginateKanbanBoards(boards, {
          page: requestedPage,
          pageSize: requestedPageSize,
          activeSessionIds,
        }),
      );
      return true;
    }
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
      ok(
        ws,
        type,
        await getKanbanQueueHealth(ctx.projectRoot, {
          boardId: hBoardId,
          includeClassifications: false,
        }),
      );
      return true;
    }
    case 'kanban.supervisor.status':
    case 'kanban.supervisor.audit': {
      const boardId = payload?.boardId as string | undefined;
      if (!boardId) {
        fail(ws, type, 'boardId required');
        return true;
      }
      const board = await getBoard(ctx.projectRoot, boardId);
      if (!board) {
        fail(ws, type, `Board not found: ${boardId}`);
        return true;
      }
      if (ctx.supervisor) {
        const snapshots = await ctx.supervisor.auditNow(boardId);
        const snapshot = snapshots[0];
        if (snapshot) {
          ok(ws, type, snapshot);
          return true;
        }
      }
      const auditContext = activityContext(ctx, 'kanban-supervisor');
      const reconciled = await reconcileKanbanBoard(ctx.projectRoot, boardId, auditContext);
      let health = await getKanbanQueueHealth(ctx.projectRoot, { boardId });
      const recovered = health.staleAssignments.count
        ? await recoverStaleTaskAssignments(
            ctx.projectRoot,
            boardId,
            {
              mode: board.supervisor?.recoveryMode ?? 'auto',
              reason: 'On-demand standalone Kanban supervisor audit.',
            },
            auditContext,
          )
        : null;
      if (recovered) health = await getKanbanQueueHealth(ctx.projectRoot, { boardId });
      const anomalyCount = kanbanQueueAnomalyCount(health);
      ok(ws, type, {
        boardId,
        status:
          board.supervisor?.enabled === false
            ? 'disabled'
            : hasKanbanQueueAnomalies(health)
              ? 'attention'
              : 'healthy',
        mode: board.supervisor?.mode ?? 'deterministic',
        lastAuditAt: new Date().toISOString(),
        reconciledTaskIds: reconciled?.tasks.map((task) => task.id) ?? [],
        staleRecoveredTaskIds: recovered?.tasks.map((task) => task.id) ?? [],
        anomalyCount,
        summary: `${health.counts.running} running · ${health.counts.startable} ready · ${health.counts.review} review · ${health.counts.blocked} blocked · ${health.counts.failed} failed`,
      });
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
          ...(has(payload, 'lifecycle')
            ? { lifecycle: payload?.lifecycle as NonNullable<KanbanBoard['lifecycle']> }
            : {}),
          ...(has(payload, 'boundary')
            ? { boundary: payload?.boundary as NonNullable<KanbanBoard['boundary']> }
            : {}),
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
        ...(has(payload, 'lifecycle')
          ? {
              lifecycle:
                (payload?.lifecycle as KanbanBoard['lifecycle'] | null | undefined) ?? null,
            }
          : {}),
        ...(has(payload, 'supervisor')
          ? {
              supervisor:
                (payload?.supervisor as KanbanBoard['supervisor'] | null | undefined) ?? null,
            }
          : {}),
        ...(has(payload, 'boundary')
          ? {
              boundary: (payload?.boundary as KanbanBoard['boundary'] | null | undefined) ?? null,
            }
          : {}),
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
      const liveSessionIds = new Set(
        ctx.getDisplayedSessionIds?.() ?? [ctx.context?.session?.id ?? ''],
      );
      liveSessionIds.delete('');
      const ownedByLiveSession = [...liveSessionIds].some((id) =>
        board?.tags?.includes(`session:${id}`),
      );
      if (ownedByLiveSession) {
        fail(ws, type, 'The active session Kanban board cannot be deleted.');
        return true;
      }
      ok(ws, type, {
        removed: board ? await removeBoard(ctx.projectRoot, board.id) : false,
        boardId: board?.id ?? boardId,
      });
      return true;
    }
    case 'kanban.board.history': {
      const boardId = payload?.boardId as string | undefined;
      const history = await listBoardHistory(ctx.projectRoot, boardId);
      ok(ws, type, history);
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
        createBoardFromText({
          description,
          ...(payload?.title ? { title: payload.title as string } : {}),
          ...(payload?.context ? { context: payload.context as string } : {}),
        }),
      );
      for (const taskInput of parseLinesIntoTasks(description, board.columns[0]?.id ?? 'backlog')) {
        await addTask(ctx.projectRoot, board.id, taskInput, activityContext(ctx));
      }
      ok(ws, type, (await getBoard(ctx.projectRoot, board.id)) ?? board);
      return true;
    }
    default:
      return false;
  }
}
