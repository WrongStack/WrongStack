import type { KanbanBoard, KanbanTask, KanbanTaskStatus } from '../types.js';

export function existingColumnId(
  board: KanbanBoard,
  columnId: string | undefined,
): string | undefined {
  if (!columnId) return undefined;
  const exact = board.columns.find((column) => column.id === columnId);
  if (exact) return exact.id;
  const matches = board.columns.filter((column) => column.id.startsWith(columnId));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous kanban column id "${columnId}": ${matches
        .slice(0, 5)
        .map((column) => column.id)
        .join(', ')}`,
    );
  }
  return matches[0]?.id;
}

export function columnIdForKanbanStatus(
  board: KanbanBoard,
  status: KanbanTaskStatus,
): string | undefined {
  const preferred =
    status === 'completed'
      ? ['done', 'completed']
      : status === 'in_progress'
        ? ['in-progress', 'progress', 'doing']
        : status === 'review' || status === 'failed'
          ? ['review']
          : status === 'blocked'
            ? ['blocked', 'backlog']
            : status === 'ready'
              ? ['todo', 'ready', 'backlog']
              : status === 'archived'
                ? ['done', 'archive', 'backlog']
                : ['todo', 'backlog'];
  for (const columnRef of preferred) {
    const columnId = existingColumnId(board, columnRef);
    if (columnId) return columnId;
  }
  return board.columns[0]?.id;
}

function safeTaskOrder(order: number): number {
  return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

export function normalizeColumnTaskOrders(board: KanbanBoard, columnId: string): void {
  board.tasks
    .filter((task) => task.columnId === columnId)
    .sort(
      (a, b) =>
        safeTaskOrder(a.order) - safeTaskOrder(b.order) || a.createdAt.localeCompare(b.createdAt),
    )
    .forEach((task, index) => {
      task.order = index;
    });
}

export function syncTaskColumnForStatus(
  board: KanbanBoard,
  task: KanbanTask,
  previousColumnId: string,
): void {
  const nextColumnId = columnIdForKanbanStatus(board, task.status);
  if (!nextColumnId || nextColumnId === task.columnId) return;
  task.columnId = nextColumnId;
  normalizeColumnTaskOrders(board, previousColumnId);
  placeTaskInColumn(board, task, nextColumnId, undefined);
}

export function placeTaskInColumn(
  board: KanbanBoard,
  task: KanbanTask,
  columnId: string,
  targetOrder: number | undefined,
): void {
  const tasks = board.tasks
    .filter((candidate) => candidate.columnId === columnId && candidate.id !== task.id)
    .sort(
      (a, b) =>
        safeTaskOrder(a.order) - safeTaskOrder(b.order) || a.createdAt.localeCompare(b.createdAt),
    );
  const index = clampOrder(targetOrder, tasks.length);
  tasks.splice(index, 0, task);
  tasks.forEach((candidate, order) => {
    candidate.order = order;
  });
}

export function nextTaskOrder(
  board: KanbanBoard,
  columnId: string,
  excludeTaskId?: string | undefined,
): number {
  return (
    board.tasks
      .filter((task) => task.columnId === columnId && task.id !== excludeTaskId)
      .reduce((max, task) => (Number.isFinite(task.order) ? Math.max(max, task.order) : max), -1) +
    1
  );
}

export function clampOrder(order: number | undefined, max: number): number {
  const safeMax = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  if (!Number.isFinite(order)) return safeMax;
  return Math.max(0, Math.min(Math.trunc(order as number), safeMax));
}

export function applyCompletedAtForStatus(task: KanbanTask, timestamp: string): void {
  if (task.status === 'completed') task.completedAt = task.completedAt ?? timestamp;
  else delete task.completedAt;
}
