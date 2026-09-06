import type { KanbanBoard, KanbanTask } from '../types.js';

export function findTask(board: KanbanBoard, taskId: string): KanbanTask | undefined {
  if (!taskId || !taskId.trim()) return undefined;
  const exact = board.tasks.find((task) => task.id === taskId);
  if (exact) return exact;
  const matches = board.tasks.filter((task) => task.id.startsWith(taskId));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous kanban task id "${taskId}": ${matches
        .slice(0, 5)
        .map((task) => task.id)
        .join(', ')}`,
    );
  }
  return matches[0];
}
