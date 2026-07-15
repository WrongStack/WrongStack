import {
  createBoardObject,
  deleteBoard,
  listBoardSummaries,
  mutateBoard,
  readBoard,
  writeBoard,
} from '../storage.js';
import {
  type CreateKanbanBoardInput,
  type CreateKanbanColumnInput,
  type DuplicateKanbanBoardInput,
  type KanbanBoard,
  type KanbanColumn,
  type RemoveKanbanColumnOptions,
  type UpdateKanbanBoardInput,
  type UpdateKanbanColumnInput,
} from '../types.js';
import {
  applyCompletedAtForStatus,
  cloneTaskForBoard,
  createTaskObject,
  existingColumnId,
  nextTaskOrder,
  normalizeAllColumnTaskOrders,
  normalizeColumns,
  nowIso,
  reconcileTaskColumns,
  remapTaskReferences,
  requireNonBlank,
  slugify,
  statusForColumn,
  uniqueColumnId,
} from './_internal.js';

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
  });

  if (input.tasks?.length) {
    board.tasks = input.tasks.map((task, index) =>
      createTaskObject(board, {
        ...task,
        title: task.title,
        columnId: task.columnId ?? board.columns[0]?.id ?? 'backlog',
        order: task.order ?? index,
      }),
    );
  }

  await writeBoard(projectRoot, board);
  return board;
}

export async function listBoards(projectRoot: string) {
  return listBoardSummaries(projectRoot);
}

export async function getBoard(projectRoot: string, boardId: string): Promise<KanbanBoard | null> {
  return readBoard(projectRoot, boardId);
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
    if (input.columns !== undefined) {
      board.columns = normalizeColumns(input.columns);
      reconcileTaskColumns(board, now);
    }
    if (input.completedAt !== undefined) {
      if (input.completedAt === null) delete board.completedAt;
      else board.completedAt = input.completedAt;
    }
    if (input.supervisor !== undefined) {
      if (input.supervisor === null) delete board.supervisor;
      else board.supervisor = { ...input.supervisor };
    }
    normalizeAllColumnTaskOrders(board);
    board.updatedAt = now;
    return board;
  });
  return updated?.board ?? null;
}

export async function removeBoard(projectRoot: string, boardId: string): Promise<boolean> {
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
  });

  if (input.includeTasks !== false) {
    const sourceTasks = source.tasks.filter(
      (task) => input.includeCompletedTasks !== false || task.status !== 'completed',
    );
    const idMap = new Map<string, string>();
    board.tasks = sourceTasks.map((task) => {
      const cloned = cloneTaskForBoard(board, task, {
        preserveAssignment: input.preserveAssignment === true,
        preserveDependencies: true,
      });
      idMap.set(task.id, cloned.id);
      return cloned;
    });
    for (let index = 0; index < board.tasks.length; index++) {
      const original = sourceTasks[index];
      const cloned = board.tasks[index];
      if (!original || !cloned) continue;
      remapTaskReferences(cloned, original, idMap);
    }
  }

  await writeBoard(projectRoot, board);
  return board;
}

export async function addColumn(
  projectRoot: string,
  boardId: string,
  input: CreateKanbanColumnInput,
): Promise<{ board: KanbanBoard; column: KanbanColumn } | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const column: KanbanColumn = {
      id: uniqueColumnId(board, input.id ?? (slugify(input.title) || 'column')),
      title: requireNonBlank(input.title, 'Kanban column title'),
      order: input.order ?? board.columns.length,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.wipLimit !== undefined ? { wipLimit: input.wipLimit } : { wipLimit: 0 }),
    };
    board.columns.push(column);
    board.columns = normalizeColumns(board.columns);
    board.updatedAt = nowIso();
    return column;
  });
  return updated ? { board: updated.board, column: updated.result } : null;
}

export async function updateColumn(
  projectRoot: string,
  boardId: string,
  columnId: string,
  input: UpdateKanbanColumnInput,
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const resolvedColumnId = existingColumnId(board, columnId);
    if (!resolvedColumnId) return null;
    const column = board.columns.find((candidate) => candidate.id === resolvedColumnId);
    if (!column) return null;
    if (input.title !== undefined)
      column.title = requireNonBlank(input.title, 'Kanban column title');
    if (input.description !== undefined) column.description = input.description;
    if (input.color !== undefined) column.color = input.color;
    if (input.order !== undefined) column.order = input.order;
    if (input.wipLimit !== undefined) column.wipLimit = input.wipLimit;
    board.columns = normalizeColumns(board.columns);
    board.updatedAt = nowIso();
    return board;
  });
  return updated?.result ? updated.board : null;
}

export async function removeColumn(
  projectRoot: string,
  boardId: string,
  columnId: string,
  options: RemoveKanbanColumnOptions = {},
): Promise<KanbanBoard | null> {
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const resolvedColumnId = existingColumnId(board, columnId);
    if (!resolvedColumnId) return null;
    const index = board.columns.findIndex((column) => column.id === resolvedColumnId);
    if (index === -1) return null;
    const columnTasks = board.tasks.filter((task) => task.columnId === resolvedColumnId);
    if (columnTasks.length && !options.moveTasksToColumnId) {
      throw new Error(
        `Column "${resolvedColumnId}" has tasks. Pass moveTasksToColumnId to move them.`,
      );
    }
    if (options.moveTasksToColumnId) {
      const targetColumnId = existingColumnId(board, options.moveTasksToColumnId);
      if (!targetColumnId)
        throw new Error(`Target column not found: ${options.moveTasksToColumnId}`);
      if (targetColumnId === resolvedColumnId) {
        throw new Error(`Cannot move tasks to the column being removed: ${resolvedColumnId}`);
      }
      const now = nowIso();
      const targetStart = nextTaskOrder(board, targetColumnId);
      const orderedColumnTasks = columnTasks.sort((a, b) => a.order - b.order);
      for (let i = 0; i < orderedColumnTasks.length; i++) {
        const task = orderedColumnTasks[i];
        if (!task) continue;
        task.columnId = targetColumnId;
        task.order = targetStart + i;
        task.status = statusForColumn(targetColumnId);
        task.updatedAt = now;
        applyCompletedAtForStatus(task, now);
      }
    }
    board.columns.splice(index, 1);
    board.columns = normalizeColumns(board.columns);
    const updatedAt = nowIso();
    reconcileTaskColumns(board, updatedAt);
    if (options.moveTasksToColumnId) normalizeAllColumnTaskOrders(board);
    board.updatedAt = updatedAt;
    return board;
  });
  return updated?.result ? updated.board : null;
}
