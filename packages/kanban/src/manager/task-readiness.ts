import type { KanbanBoard, KanbanTask } from '../types.js';
import { findTask } from './task-lookup.js';

export interface KanbanDependencyReadinessIssue {
  dependencyId: string;
  status: 'missing' | 'incomplete';
  taskStatus?: string | undefined;
  /**
   * Title of the blocking card, when it still exists. Messages built from
   * these issues are read by an agent deciding what to do next, and a bare
   * UUID does not say what the work is waiting for.
   */
  dependencyTitle?: string | undefined;
}

/**
 * Return the concrete dependency failures instead of reducing them to a
 * boolean. Missing references are failures too: silently treating a deleted
 * or stale dependency as satisfied lets downstream work run out of order.
 */
export function getDependencyReadinessIssues(
  board: KanbanBoard,
  taskRef: string | KanbanTask,
): KanbanDependencyReadinessIssue[] {
  const task = typeof taskRef === 'string' ? findTask(board, taskRef) : taskRef;
  if (!task?.dependsOn?.length) return [];
  const issues: KanbanDependencyReadinessIssue[] = [];
  for (const dependencyId of task.dependsOn) {
    const dependency = findTask(board, dependencyId);
    if (!dependency) {
      issues.push({ dependencyId, status: 'missing' });
    } else if (dependency.status !== 'completed') {
      issues.push({
        dependencyId: dependency.id,
        status: 'incomplete',
        taskStatus: dependency.status,
        dependencyTitle: dependency.title,
      });
    }
  }
  return issues;
}

/**
 * Render dependency failures as a human sentence fragment.
 *
 * Shared by every caller that reports "this card cannot start yet" so the
 * wording cannot drift between the assignment path and the lifecycle path.
 * Names the blocking card, falling back to the id when the card is gone.
 */
export function formatDependencyReadinessIssues(
  issues: readonly KanbanDependencyReadinessIssue[],
): string {
  return issues
    .map((issue) =>
      issue.status === 'missing'
        ? `${issue.dependencyId} (missing)`
        : `${issue.dependencyTitle ?? issue.dependencyId} (${issue.taskStatus ?? 'incomplete'})`,
    )
    .join(', ');
}

/**
 * Dependency readiness is a leaf-domain rule shared by mutations and queries.
 * Accepts either a full task id or a unique prefix (delegated to `findTask`).
 */
export function areDependenciesMet(board: KanbanBoard, taskId: string): boolean {
  return getDependencyReadinessIssues(board, taskId).length === 0;
}
