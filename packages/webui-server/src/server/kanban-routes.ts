import type { Context } from '@wrongstack/core/agent';
import { deserializeTaskGraph, serializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializableTaskGraph } from '@wrongstack/core/types';
import {
  addCheckToTask,
  addGoalMetricToTask,
  addNoteToTask,
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromText,
  duplicateBoard,
  exportBoardToTaskGraph,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  getTaskChain,
  hasKanbanQueueAnomalies,
  type KanbanBoard,
  type KanbanCheckType,
  type KanbanLifecycleStage,
  type KanbanLink,
  type KanbanTask,
  type KanbanTaskPriority,
  type KanbanTaskStatus,
  type KanbanTaskTransitionInput,
  kanbanQueueAnomalyCount,
  listBoardHistory,
  listBoards,
  listReadyTasks,
  mergeTasks,
  moveTask,
  parseLinesIntoTasks,
  reconcileKanbanBoard,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeBoard,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transferTaskToBoard,
  transitionTask,
  updateBoard,
  updateCheckOnTask,
  updateGoalMetricOnTask,
  updateTask,
} from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import { handleKanbanContractRoute } from './kanban-contract-routes.js';
import { handleKanbanDecompositionRoute } from './kanban-decomposition-routes.js';
import { handleKanbanTaskDispatch, type KanbanTaskDispatcher } from './kanban-dispatch.js';
import {
  activityContext,
  fail,
  findTask,
  has,
  ok,
  syncSessionSource,
} from './kanban-route-helpers.js';
import { paginateKanbanBoards } from './kanban-route-pagination.js';
import type { KanbanSupervisor } from './kanban-supervisor.js';
import { handleKanbanTaskRoute } from './kanban-task-routes.js';
import type { WSClientMessage, WSServerMessage } from './types.js';
import { messageSessionId } from './ws-utils.js';

export { type KanbanBoardPage, paginateKanbanBoards } from './kanban-route-pagination.js';
export { KANBAN_CLIENT_MESSAGE_TYPES } from './kanban-route-protocol.js';

export interface KanbanRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  /**
   * Every session a tab is currently displaying.
   *
   * `context.session` is only the one the runtime last switched to. With four
   * tabs open, guarding `kanban.delete` on that alone protected ONE live board
   * and left the other three deletable out from under the tabs showing them.
   * Hosts that track displayed tabs pass this; single-session hosts omit it
   * and the runtime session remains the whole set.
   */
  getDisplayedSessionIds?: (() => string[]) | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
  dispatchTask?: KanbanTaskDispatcher | undefined;
  /**
   * Background supervisor (if enabled). When present, the `kanban.supervisor.audit`
   * and `kanban.supervisor.status` routes delegate to its in-process audit cycle
   * instead of running a second reconcile/health/recover chain — preventing the
   * double-audit that happens when both paths refresh the same board concurrently.
   */
  supervisor?: KanbanSupervisor | undefined;
  /** Set per message by `handleKanbanRoute` — see `KanbanRouteHelperContext`. */
  requestSessionId?: string | undefined;
}

export async function handleKanbanRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  rawCtx: KanbanRouteContext,
): Promise<boolean> {
  if (!msg.type.startsWith('kanban.')) return false;
  const payload = msg.payload as Record<string, unknown> | undefined;
  const type = msg.type;
  // Attribute this message to the tab that sent it. Everything downstream
  // (`activityContext`, `touchTaskPresence`) reads it through
  // `actingSessionId`, so one stamp here covers every route below.
  const requestSessionId = messageSessionId(msg);
  const ctx: KanbanRouteContext = requestSessionId ? { ...rawCtx, requestSessionId } : rawCtx;

  try {
    if (await handleKanbanDecompositionRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanContractRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanTaskRoute(ws, type, payload, ctx)) return true;
    switch (type) {
      case 'kanban.list': {
        const boards = await listBoards(ctx.projectRoot);
        const requestedPage = Number(payload?.page);
        const requestedPageSize = Number(payload?.pageSize);
        if (!Number.isFinite(requestedPage) || !Number.isFinite(requestedPageSize)) {
          // Keep the legacy array response for older clients.
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
        // The browser renders counts only — no component reads
        // `classifications`, and this route is polled every five seconds, so
        // the per-task diagnostics would be pure wire weight. The tool path
        // keeps them: that is where an agent asks why a card is unclaimable.
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
        // Delegate to the background supervisor when available so the
        // background tick and the on-demand route share a single reconcile /
        // health / recover chain. The supervisor's `auditNow` returns the
        // exact snapshot shape this route emits, so we forward it verbatim.
        if (ctx.supervisor) {
          const snapshots = await ctx.supervisor.auditNow(boardId);
          const snapshot = snapshots[0];
          if (snapshot) {
            ok(ws, type, snapshot);
            return true;
          }
          // Supervisor audit could not run (board gone, race, etc.); fall
          // through to the standalone path so the client still gets an answer.
        }
        const reconciled = await reconcileKanbanBoard(ctx.projectRoot, boardId);
        let health = await getKanbanQueueHealth(ctx.projectRoot, { boardId });
        const recovered = health.staleAssignments.count
          ? await recoverStaleTaskAssignments(ctx.projectRoot, boardId, {
              mode: board.supervisor?.recoveryMode ?? 'auto',
              reason: 'On-demand standalone Kanban supervisor audit.',
            })
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
        // A board belonging to ANY open tab is off limits, not just the
        // runtime's — the other three tabs are just as live to the user.
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
                  boundary:
                    (payload?.boundary as KanbanTask['boundary'] | null | undefined) ?? null,
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
          ...(typeof payload?.maxAttempts === 'number' ? { maxAttempts: payload.maxAttempts } : {}),
          ...(typeof payload?.costCeilingUsd === 'number'
            ? { costCeilingUsd: payload.costCeilingUsd }
            : {}),
          ...(payload?.retryPolicy
            ? { retryPolicy: payload.retryPolicy as NonNullable<KanbanTask['retryPolicy']> }
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
            // The old cast listed `manual | auto | agent | test | review` —
            // three of which have no verifier plugin, while the six that do
            // (command, file_exists, file_matches, git_diff, metric, test)
            // were unreachable. `notes` carries the executable body every
            // deterministic plugin reads.
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
        else ok(ws, type, (await reconcileKanbanBoard(ctx.projectRoot, boardId))?.board ?? board);
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
      case 'kanban.task.dispatch':
        await handleKanbanTaskDispatch(ws, payload, ctx);
        return true;
      case 'kanban.capabilities':
        ok(ws, type, { dispatchSupported: Boolean(ctx.dispatchTask) });
        return true;
      default:
        fail(ws, type, `Unknown kanban message type: ${type}`);
        return true;
    }
  } catch (err) {
    fail(ws, type, err instanceof Error ? err.message : String(err));
    return true;
  }
}
