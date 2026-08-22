import { normalizeKanbanBoundaryPolicy } from '../boundary.js';
import {
  createBoardObject,
  deleteBoard,
  listBoardSummaries,
  mutateBoard,
  readBoard,
  readBoardHistory,
  writeBoard,
} from '../storage.js';
import type { KanbanBoard, KanbanBoardHistoryEntry, KanbanColumn } from '../types.js';
import type {
  CreateKanbanBoardInput,
  CreateKanbanColumnInput,
  DuplicateKanbanBoardInput,
  RemoveKanbanColumnOptions,
  UpdateKanbanBoardInput,
  UpdateKanbanColumnInput,
} from '../types-operations.js';
import {
  cloneTaskForBoard,
  createBoardHistoryEntry,
  createTaskObject,
  emitBoardHistoryEvent,
  normalizeAllColumnTaskOrders,
  normalizeColumns,
  nowIso,
  remapTaskReferences,
  requireNonBlank,
} from './_internal.js';
import { cloneContractGraphForBoard } from './contract-graph.js';
import { initializeAndValidateManagedTask, validateManagedLifecyclePolicy } from './lifecycle.js';
import { withLiveKanbanPresence } from './presence.js';

export async function createBoard(
  projectRoot: string,
  input: CreateKanbanBoardInput,
): Promise<KanbanBoard> {
  const columns = normalizeColumns(input.columns);
  const board = createBoardObject({
    title: requireNonBlank(input.title, 'Kanban board title'),
    columns,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.generatedBy !== undefined ? { generatedBy: input.generatedBy } : {}),
    ...(input.supervisor !== undefined ? { supervisor: input.supervisor } : {}),
    ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
    ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
    ...(input.atomicity !== undefined ? { atomicity: input.atomicity } : {}),
    ...(input.completionGate !== undefined ? { completionGate: input.completionGate } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.retention !== undefined ? { retention: input.retention } : {}),
  });

  const policyIssues = validateManagedLifecyclePolicy(board);
  if (policyIssues.length) throw new Error(policyIssues[0]!.message);

  if (input.tasks?.length) {
    board.tasks = input.tasks.map((task, index) => {
      const created = createTaskObject(board, {
        ...task,
        title: task.title,
        columnId: task.columnId ?? board.columns[0]?.id ?? 'backlog',
        order: task.order ?? index,
      });
      initializeAndValidateManagedTask(board, created);
      return created;
    });
  }

  await writeBoard(projectRoot, board);
  await emitBoardHistoryEvent(
    projectRoot,
    createBoardHistoryEntry(board.id, board.title, 'board.created', {
      after: {
        ...(board.kind !== undefined ? { kind: board.kind } : {}),
        ...(board.tags !== undefined ? { tags: board.tags } : {}),
      },
    }),
  );
  return board;
}

export async function listBoards(projectRoot: string) {
  return (await listBoardSummaries(projectRoot)).map((board) => ({
    ...board,
    ...(board.presence !== undefined
      ? {
          presence: withLiveKanbanPresence({ ...board, columns: [], tasks: [], version: 1 })
            .presence,
        }
      : {}),
  }));
}

/**
 * Read board-level history from the global log.
 *
 * When `boardId` is provided, returns only entries for that board (including
 * entries recorded before the board was deleted — the global log survives
 * deletion). When omitted, returns the entire global history across all boards.
 */
export async function listBoardHistory(
  projectRoot: string,
  boardId?: string,
): Promise<KanbanBoardHistoryEntry[]> {
  return readBoardHistory(projectRoot, boardId);
}

export async function getBoard(projectRoot: string, boardId: string): Promise<KanbanBoard | null> {
  const board = await readBoard(projectRoot, boardId);
  return board ? withLiveKanbanPresence(board) : null;
}

export async function updateBoard(
  projectRoot: string,
  boardId: string,
  input: UpdateKanbanBoardInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const now = nowIso();
    if (input.title !== undefined) board.title = requireNonBlank(input.title, 'Kanban board title');
    if (input.description !== undefined) board.description = input.description;
    if (input.tags !== undefined) board.tags = input.tags;
    // Columns are locked: the `columns` field on UpdateKanbanBoardInput is
    // ignored. Boards always carry the 5 standard columns (backlog, todo,
    // in-progress, review, done) once created.
    if (input.completedAt !== undefined) {
      if (input.completedAt === null) delete board.completedAt;
      else board.completedAt = input.completedAt;
    }
    if (input.supervisor !== undefined) {
      if (input.supervisor === null) delete board.supervisor;
      else board.supervisor = { ...input.supervisor };
    }
    if (input.lifecycle !== undefined) {
      if (input.lifecycle === null) delete board.lifecycle;
      else
        board.lifecycle = {
          ...input.lifecycle,
          columns: { ...input.lifecycle.columns },
        };
    }
    if (input.boundary !== undefined) {
      if (input.boundary === null) delete board.boundary;
      else board.boundary = normalizeKanbanBoundaryPolicy(input.boundary);
    }
    if (input.atomicity !== undefined) {
      if (input.atomicity === null) delete board.atomicity;
      else
        board.atomicity = {
          ...input.atomicity,
          ...(input.atomicity.config ? { config: { ...input.atomicity.config } } : {}),
        };
    }
    if (input.completionGate !== undefined) {
      if (input.completionGate === null) delete board.completionGate;
      else board.completionGate = { ...input.completionGate };
    }
    const policyIssues = validateManagedLifecyclePolicy(board);
    if (policyIssues.length) throw new Error(policyIssues[0]!.message);
    normalizeAllColumnTaskOrders(board);
    board.updatedAt = now;
    return board;
  });
  if (updated) {
    // Record which fields changed for the board-level history log.
    const changed: Record<string, unknown> = {};
    if (input.title !== undefined) changed.title = updated.board.title;
    if (input.description !== undefined) changed.description = updated.board.description ?? null;
    if (input.tags !== undefined) changed.tags = updated.board.tags ?? [];
    if (input.completedAt !== undefined) changed.completedAt = updated.board.completedAt ?? null;
    if (input.supervisor !== undefined)
      changed.supervisor = updated.board.supervisor ? 'set' : 'cleared';
    if (input.lifecycle !== undefined)
      changed.lifecycle = updated.board.lifecycle ? 'set' : 'cleared';
    if (input.boundary !== undefined) changed.boundary = updated.board.boundary ? 'set' : 'cleared';
    if (input.atomicity !== undefined)
      changed.atomicity = updated.board.atomicity ? 'set' : 'cleared';
    if (input.completionGate !== undefined)
      changed.completionGate = updated.board.completionGate ? 'set' : 'cleared';
    await emitBoardHistoryEvent(
      projectRoot,
      createBoardHistoryEntry(updated.board.id, updated.board.title, 'board.updated', {
        ...(Object.keys(changed).length > 0 ? { after: changed } : {}),
      }),
    );
  }
  return updated?.board ?? null;
}

export async function removeBoard(projectRoot: string, boardId: string): Promise<boolean> {
  // Emit board.deleted BEFORE deleting — once the board is gone, its title is
  // no longer readable, and the global history log should record what was
  // removed. The per-board event log will be destroyed by deleteBoard, but
  // the global board_history log survives.
  const board = await readBoard(projectRoot, boardId);
  if (board) {
    await emitBoardHistoryEvent(
      projectRoot,
      createBoardHistoryEntry(board.id, board.title, 'board.deleted'),
    );
  }
  return deleteBoard(projectRoot, boardId);
}

export async function duplicateBoard(
  projectRoot: string,
  boardId: string,
  input: DuplicateKanbanBoardInput = {},
): Promise<KanbanBoard | null> {
  const source = await readBoard(projectRoot, boardId);
  if (!source) return null;
  const board = createBoardObject({
    title: input.title ?? `${source.title} Copy`,
    ...(source.description !== undefined ? { description: source.description } : {}),
    ...(source.tags !== undefined ? { tags: [...source.tags] } : {}),
    columns: source.columns.map((column) => ({ ...column })),
    generatedBy: input.generatedBy ?? `duplicate:${source.id}`,
    ...(source.supervisor !== undefined ? { supervisor: { ...source.supervisor } } : {}),
    ...(source.lifecycle !== undefined
      ? { lifecycle: { ...source.lifecycle, columns: { ...source.lifecycle.columns } } }
      : {}),
    ...(source.boundary !== undefined ? { boundary: { ...source.boundary } } : {}),
    ...(source.atomicity !== undefined ? { atomicity: { ...source.atomicity } } : {}),
    ...(source.completionGate !== undefined
      ? { completionGate: { ...source.completionGate } }
      : {}),
  });

  if (input.includeTasks !== false) {
    const sourceTasks = source.tasks.filter(
      (task) => input.includeCompletedTasks !== false || task.status !== 'completed',
    );
    const idMap = new Map<string, string>();
    board.tasks = sourceTasks.map((task) => {
      const cloned = cloneTaskForBoard(board, task, {
        targetColumnId:
          board.lifecycle?.mode === 'managed' ? board.lifecycle.columns.backlog : task.columnId,
        preserveAssignment: input.preserveAssignment === true,
        preserveDependencies: true,
      });
      if (board.lifecycle?.mode === 'managed') {
        delete cloned.lifecycle;
        cloned.status = 'pending';
        delete cloned.completedAt;
        initializeAndValidateManagedTask(board, cloned);
      }
      idMap.set(task.id, cloned.id);
      return cloned;
    });
    for (let index = 0; index < board.tasks.length; index++) {
      const original = sourceTasks[index];
      const cloned = board.tasks[index];
      if (!original || !cloned) continue;
      remapTaskReferences(cloned, original, idMap);
    }
    cloneContractGraphForBoard(source, board, idMap);
  }

  await writeBoard(projectRoot, board);
  await emitBoardHistoryEvent(
    projectRoot,
    createBoardHistoryEntry(board.id, board.title, 'board.duplicated', {
      after: { sourceBoardId: source.id, sourceBoardTitle: source.title },
    }),
  );
  return board;
}

export async function addColumn(
  _projectRoot: string,
  _boardId: string,
  _input: CreateKanbanColumnInput,
): Promise<{ board: KanbanBoard; column: KanbanColumn } | null> {
  // Columns are locked to the 5 standard columns (backlog, todo, in-progress,
  // review, done). Adding a custom column is no longer supported. The function
  // signature is kept so existing callers get a clear error instead of a
  // compile break, and the domain-operation entry can be removed in lockstep.
  throw new Error(
    'Columns are locked to the 5 standard columns (backlog, todo, in-progress, review, done). Custom columns are not supported.',
  );
}

export async function updateColumn(
  _projectRoot: string,
  _boardId: string,
  _columnId: string,
  _input: UpdateKanbanColumnInput,
): Promise<KanbanBoard | null> {
  // Column metadata (title/color/order/wipLimit) is locked alongside the
  // column set. WIP limits are set at board creation via DEFAULT_COLUMNS.
  throw new Error(
    'Columns are locked to the 5 standard columns (backlog, todo, in-progress, review, done). Column updates are not supported.',
  );
}

export async function removeColumn(
  _projectRoot: string,
  _boardId: string,
  _columnId: string,
  _options: RemoveKanbanColumnOptions = {},
): Promise<KanbanBoard | null> {
  // Columns are locked to the 5 standard columns. Removing one is not supported.
  throw new Error(
    'Columns are locked to the 5 standard columns (backlog, todo, in-progress, review, done). Column removal is not supported.',
  );
}
