import type { Context } from '@wrongstack/core/agent';
import { loadTasks } from '@wrongstack/core/storage';
import { deserializeTaskGraph, serializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializableTaskGraph } from '@wrongstack/core/types';
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
  listBoards,
  listKanbanEvents,
  listReadyTasks,
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
import { fail, okBoard } from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';
import { taskFileToSerializedGraph } from './session-kanban.js';

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
      const boards = await listBoards(projectRoot);
      return { ok: true, message: `${boards.length} board(s).`, boards };
    }
    case 'get_board': {
      const board = await requireBoard(projectRoot, input.boardId);
      return board ? okBoard(board) : fail('Board not found.');
    }
    case 'create_board': {
      if (!input.title) return fail('create_board requires title.');
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
      if (!input.boardId) return fail('update_board requires boardId.');
      const board = await updateBoard(projectRoot, input.boardId, boardUpdatePatch(input));
      return board ? okBoard(board, 'Board updated.') : fail('Board not found.');
    }
    case 'adopt_managed_lifecycle': {
      if (!input.boardId || !input.author || !input.transitionComment) {
        return fail(
          'adopt_managed_lifecycle requires boardId, author, transitionComment, and five ordered columns.',
        );
      }
      if (input.columns?.length !== 5) {
        return fail(
          'adopt_managed_lifecycle columns must be ordered as backlog, todo, running, review, done.',
        );
      }
      const [backlog, todo, running, review, done] = input.columns;
      if (!backlog || !todo || !running || !review || !done) {
        return fail('adopt_managed_lifecycle columns must contain five nonblank ids.');
      }
      const board = await adoptManagedLifecycle(projectRoot, input.boardId, {
        columns: { backlog, todo, running, review, done },
        actor: input.author,
        comment: input.transitionComment,
      });
      return board
        ? okBoard(board, 'Managed lifecycle adopted without moving existing cards.')
        : fail('Board not found.');
    }
    case 'release_managed_lifecycle': {
      if (!input.boardId) return fail('release_managed_lifecycle requires boardId.');
      const board = await updateBoard(projectRoot, input.boardId, { lifecycle: null });
      return board
        ? okBoard(
            board,
            'Managed lifecycle released; the board now tracks work without strict gates.',
          )
        : fail('Board not found.');
    }
    case 'duplicate_board': {
      if (!input.boardId) return fail('duplicate_board requires boardId.');
      const board = await duplicateBoard(projectRoot, input.boardId, duplicateBoardOptions(input));
      return board ? okBoard(board, 'Board duplicated.') : fail('Board not found.');
    }
    case 'delete_board': {
      if (!input.boardId) return fail('delete_board requires boardId.');
      const removed = await removeBoard(projectRoot, input.boardId);
      return { ok: removed, message: removed ? 'Board deleted.' : 'Board not found.' };
    }
    case 'generate_board': {
      if (!input.description) return fail('generate_board requires description.');
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
        ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
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
      const taskPath = (ctx.meta as Record<string, unknown>)?.['task.path'] as string | undefined;
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
        label: input.label ?? input.labels?.[0],
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
        message: `Counts: startable=${health.counts.startable}, running=${health.counts.running}, stale=${health.staleAssignments.count}.`,
        queueHealth: health,
      };
    }
    default:
      return undefined;
  }
}
