import type { SerializableTaskGraph } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { loadTasks } from '@wrongstack/core/storage';
import { deserializeTaskGraph, serializeTaskGraph } from '@wrongstack/core/tasking';
import {
  addTask,
  adoptManagedLifecycle,
  createBoard,
  createBoardFromTaskGraph,
  createBoardFromText,
  duplicateBoard,
  exportBoardAsMarkdown,
  exportBoardToTaskGraph,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  listBoardHistory,
  listBoards,
  listKanbanEvents,
  listReadyTasks,
  listTaskActivity,
  parseLinesIntoTasks,
  removeBoard,
  searchKanban,
  syncBoardFromTaskGraph,
  updateBoard,
} from '@wrongstack/kanban';
import {
  boardCreateInput,
  boardUpdatePatch,
  duplicateBoardOptions,
} from './kanban-board-inputs.js';
import { requireBoard } from './kanban-split-task-handler.js';
import {
  conflict,
  invalidInput,
  notFound,
  okBoard,
  resolveTaskRef,
} from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';
import { taskFileToSerializedGraph } from './session-kanban.js';

/**
 * `limit` on a list read: newest-updated first, then bounded. Without one the
 * whole list comes back in its usual order, as before; with 100+ boards and
 * 1000+ cards that payload overflows an MCP client's result budget.
 */
function newestFirst<T>(
  items: T[],
  updatedAt: (item: T) => string | undefined,
  limit: unknown,
): { items: T[]; total: number; bounded: boolean } {
  const n =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : undefined;
  if (n === undefined) return { items, total: items.length, bounded: false };
  const sorted = [...items].sort((a, b) => (updatedAt(b) ?? '').localeCompare(updatedAt(a) ?? ''));
  return { items: sorted.slice(0, n), total: items.length, bounded: true };
}

export async function handleKanbanBoardAction(
  projectRoot: string,
  input: KanbanToolInput,
  ctx: Context,
): Promise<KanbanToolOutput | undefined> {
  const eventContext = {
    sessionId: ctx.eventSessionId?.() ?? ctx.session?.id ?? 'default-session',
    ...(ctx.agentId !== undefined ? { actor: ctx.agentId } : {}),
  };
  switch (input.action) {
    case 'list_boards': {
      const all = await listBoards(projectRoot);
      const visible =
        input.includeArchived === false ? all.filter((board) => board.kind !== 'archive') : all;
      const {
        items: boards,
        total,
        bounded,
      } = newestFirst(visible, (board) => board.updatedAt, input.limit);
      const message = bounded
        ? `${boards.length} of ${total} board(s), most recently updated first.`
        : `${boards.length} board(s).`;
      return { ok: true, message, boards };
    }
    case 'get_board': {
      if (!input.boardId) throw invalidInput('get_board requires boardId.', 'boardId');
      const board = await requireBoard(projectRoot, input.boardId);
      if (!board) throw notFound('Board not found.');
      return okBoard(board);
    }
    case 'create_board': {
      if (!input.title) throw invalidInput('create_board requires title.', 'title');
      const existing = (await listBoards(projectRoot)).filter(
        (candidate) => (candidate.kind ?? 'project') === 'project',
      );
      const board = await createBoard(projectRoot, boardCreateInput(input, input.title));
      const note = existing.length
        ? ` ${existing.length} other project board(s) already exist: ${existing
            .slice(0, 3)
            .map((candidate) => `"${candidate.title}" (${candidate.taskCount} task(s))`)
            .join(
              ', ',
            )}${existing.length > 3 ? ', …' : ''}. If this work belongs to one of them, add_task there instead and delete this board.`
        : '';
      return { ok: true, message: `Board created: ${board.title}.${note}`, board };
    }
    case 'update_board': {
      if (!input.boardId) throw invalidInput('update_board requires boardId.', 'boardId');
      const board = await updateBoard(projectRoot, input.boardId, boardUpdatePatch(input));
      if (!board) throw notFound('Board not found.');
      return okBoard(board, 'Board updated.');
    }
    case 'adopt_managed_lifecycle': {
      if (!input.boardId || !input.author || !input.transitionComment) {
        throw invalidInput(
          'adopt_managed_lifecycle requires boardId, author, transitionComment, and five ordered columns.',
        );
      }
      if (input.columns?.length !== 5) {
        throw invalidInput(
          'adopt_managed_lifecycle columns must be ordered as backlog, todo, running, review, done.',
          'columns',
        );
      }
      const [backlog, todo, running, review, done] = input.columns;
      if (!backlog || !todo || !running || !review || !done) {
        throw invalidInput(
          'adopt_managed_lifecycle columns must contain five nonblank ids.',
          'columns',
        );
      }
      const board = await adoptManagedLifecycle(projectRoot, input.boardId, {
        columns: { backlog, todo, running, review, done },
        actor: input.author,
        comment: input.transitionComment,
      });
      if (!board) throw notFound('Board not found.');
      return okBoard(board, 'Managed lifecycle adopted without moving existing cards.');
    }
    case 'release_managed_lifecycle': {
      if (!input.boardId) {
        throw invalidInput('release_managed_lifecycle requires boardId.', 'boardId');
      }
      const board = await updateBoard(projectRoot, input.boardId, { lifecycle: null });
      if (!board) throw notFound('Board not found.');
      return okBoard(
        board,
        'Managed lifecycle released; the board now tracks work without strict gates.',
      );
    }
    case 'duplicate_board': {
      if (!input.boardId) throw invalidInput('duplicate_board requires boardId.', 'boardId');
      const board = await duplicateBoard(projectRoot, input.boardId, duplicateBoardOptions(input));
      if (!board) throw notFound('Board not found.');
      return okBoard(board, 'Board duplicated.');
    }
    case 'delete_board': {
      if (!input.boardId) throw invalidInput('delete_board requires boardId.', 'boardId');
      const removed = await removeBoard(projectRoot, input.boardId);
      if (!removed) throw notFound('Board not found.');
      return { ok: true, message: 'Board deleted.' };
    }
    case 'generate_board': {
      if (!input.description) {
        throw invalidInput('generate_board requires description.', 'description');
      }
      const boardInput = createBoardFromText({
        description: input.description,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}),
      });
      const board = await createBoard(projectRoot, boardInput);
      for (const tInput of parseLinesIntoTasks(
        input.description,
        board.columns[0]?.id ?? 'backlog',
      )) {
        await addTask(projectRoot, board.id, tInput, eventContext);
      }
      return okBoard((await getBoard(projectRoot, board.id)) ?? board, 'Board generated.');
    }
    case 'export_markdown': {
      if (!input.boardId) throw invalidInput('export_markdown requires boardId.', 'boardId');
      const board = await requireBoard(projectRoot, input.boardId);
      if (!board) throw notFound('Board not found.');
      // The markdown IS the export; returning the full board beside it doubled
      // the payload for no reader.
      return {
        ok: true,
        message: 'Board exported.',
        markdown: exportBoardAsMarkdown(board),
      };
    }
    case 'export_task_graph': {
      if (!input.boardId) throw invalidInput('export_task_graph requires boardId.', 'boardId');
      const exported = await exportBoardToTaskGraph(projectRoot, input.boardId, {
        ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
        ...(input.specId !== undefined ? { specId: input.specId } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.preserveOriginTaskIds !== undefined
          ? { preserveOriginTaskIds: input.preserveOriginTaskIds }
          : {}),
        ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      });
      if (!exported) throw notFound('Board not found.');
      return {
        ok: true,
        message: `Task graph exported with ${exported.graph.nodes.size} node(s).`,
        board: exported.board,
        taskGraph: serializeTaskGraph(exported.graph),
      };
    }
    case 'sync_task_graph': {
      if (!input.boardId || !input.taskGraph) {
        throw invalidInput('sync_task_graph requires boardId and taskGraph.');
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
      if (!result) throw notFound('Board not found.');
      return {
        ok: true,
        message: `Task graph synced: ${result.createdTaskIds.length} created, ${result.updatedTaskIds.length} updated, ${result.archivedTaskIds.length} archived.`,
        board: result.board,
      };
    }
    case 'create_from_graph': {
      if (!input.taskGraph)
        throw invalidInput('create_from_graph requires taskGraph.', 'taskGraph');
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
      // "Nothing to import" is a data outcome, not a failure.
      const taskPath = (ctx.meta as Record<string, unknown>)?.['task.path'] as string | undefined;
      if (!taskPath) {
        return { ok: true, imported: 0, message: 'No session task file for this session.' };
      }
      const file = await loadTasks(taskPath);
      if (!file || file.tasks.length === 0) {
        return { ok: true, imported: 0, message: 'No session tasks to import.' };
      }
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
        if (!result) {
          throw conflict('Session board vanished mid-sync; nothing was imported. Retry.', {
            retryable: true,
          });
        }
        return {
          ok: true,
          imported: file.tasks.length,
          message: `Synced ${file.tasks.length} session tasks into board "${result.board.title}".`,
          board: result.board,
        };
      }
      const { board } = await createBoardFromTaskGraph(projectRoot, graph, {
        title: `Session tasks (${sessionId.slice(0, 8)})`,
        sourceSystem: 'session',
        tags,
      });
      return {
        ok: true,
        imported: file.tasks.length,
        message: `Imported ${file.tasks.length} session tasks into new board "${board.title}".`,
        board,
      };
    }
    case 'stats': {
      const all = await listBoards(projectRoot);
      const boards = input.boardId ? all.filter((board) => board.id === input.boardId) : all;
      if (input.boardId && boards.length === 0) throw notFound('Board not found.');
      const matches = await searchKanban(projectRoot, {
        ...(input.boardId ? { boardId: input.boardId } : {}),
      });
      const tally = (keys: string[]): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const key of keys) out[key] = (out[key] ?? 0) + 1;
        return out;
      };
      const newest = newestFirst(boards, (board) => board.updatedAt, 1).items[0];
      const stats = {
        boards: boards.length,
        boardsByKind: tally(boards.map((board) => board.kind ?? 'project')),
        columns: boards.reduce((sum, board) => sum + board.columnCount, 0),
        cards: matches.length,
        cardsByStatus: tally(matches.map((match) => match.task.status)),
        ...(newest
          ? {
              mostRecentlyUpdatedBoard: {
                id: newest.id,
                title: newest.title,
                updatedAt: newest.updatedAt,
              },
            }
          : {}),
      };
      return {
        ok: true,
        message: `${stats.boards} board(s), ${stats.columns} column(s), ${stats.cards} card(s).`,
        stats,
      };
    }
    case 'search_tasks': {
      const tasks = await searchKanban(projectRoot, {
        query: input.query,
        boardId: input.boardId,
        assignedAgent: input.agentId,
        status: input.status,
        priority: input.priority,
        label: input.label ?? input.labels?.[0],
        chainId: input.chainId,
      });
      const { items, total, bounded } = newestFirst(
        tasks,
        (match) => match.task.updatedAt,
        input.limit,
      );
      const message = bounded
        ? `${items.length} of ${total} task(s) matched, most recently updated first.`
        : `${total} task(s) matched.`;
      return { ok: true, message, tasks: items };
    }
    case 'ready_tasks': {
      const tasks = await listReadyTasks(projectRoot, {
        query: input.query,
        boardId: input.boardId,
        assignedAgent: input.agentId,
        priority: input.priority,
        label: input.label ?? input.labels?.[0],
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
        label: input.label ?? input.labels?.[0],
        chainId: input.chainId,
      });
      return {
        ok: true,
        message: `${snapshot.ready.length} ready, ${snapshot.running.length} running, ${snapshot.blocked.length} blocked.`,
        snapshot,
      };
    }
    case 'events': {
      if (!input.boardId) throw invalidInput('events requires boardId.', 'boardId');
      const limit =
        typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
          ? Math.floor(input.limit)
          : undefined;
      // A card's own history used to be unreachable on a busy board: the only
      // route to it was the whole board log, and the transcript serializer caps
      // that at KANBAN_TRANSCRIPT_ITEM_CAP most-recent entries — so an older
      // card's events fell outside the window entirely and no argument could
      // bring them back. `listTaskActivity` filters the SAME log at the source.
      // It returns newest-first; re-reverse so this action stays chronological
      // whether or not a taskId was given.
      if (input.taskId) {
        const board = await getBoard(projectRoot, input.boardId);
        if (!board) throw notFound('Board not found.');
        const task = resolveTaskRef(board, input.taskId);
        if (!task) throw notFound('Task not found on this board.');
        const activity = (
          await listTaskActivity(projectRoot, input.boardId, task.id, {
            ...(limit !== undefined ? { limit } : {}),
          })
        ).reverse();
        return {
          ok: true,
          message: `${activity.length} event(s) for "${task.title}".`,
          events: activity,
        };
      }
      const eventList = await listKanbanEvents(projectRoot, input.boardId);
      const events = limit !== undefined ? eventList.slice(-limit) : eventList;
      return {
        ok: true,
        message:
          events.length === eventList.length
            ? `${eventList.length} event(s).`
            : `${events.length} most recent of ${eventList.length} event(s).`,
        events,
      };
    }
    case 'board_history': {
      // Board history is a GLOBAL append-only log, separate from the per-board
      // event rows `events` reads, and it deliberately outlives board deletion
      // — so it is the only way to answer "what happened to the board that is
      // no longer here". The WebUI has had it since protocol v6; the agent had
      // no path to it at all. `boardId` is optional: omit it for the whole
      // project.
      const entries = await listBoardHistory(projectRoot, input.boardId);
      const limit =
        typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
          ? Math.floor(input.limit)
          : undefined;
      const history = limit !== undefined ? entries.slice(-limit) : entries;
      return {
        ok: true,
        message: input.boardId
          ? `${history.length} history entry(ies) for board ${input.boardId}.`
          : `${history.length} history entry(ies) across every board in this project.`,
        history,
      };
    }
    case 'queue_health': {
      const health = await getKanbanQueueHealth(projectRoot, {
        ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
      });
      return {
        ok: true,
        // Parked is in the headline because it is the one count that changes
        // what the caller should DO: those cards spent their refusal budget,
        // so re-running them unchanged refuses again. Optional on the record
        // because several call sites build KanbanQueueHealth by hand.
        message:
          `Counts: startable=${health.counts.startable}, running=${health.counts.running}, ` +
          `stale=${health.staleAssignments.count}, parked=${health.parked?.count ?? 0}.`,
        queueHealth: health,
      };
    }
    default:
      return undefined;
  }
}
