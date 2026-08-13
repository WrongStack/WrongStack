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
  /**
   * Set when the blocking card is parked — its verification budget ran out, so
   * it will not clear itself. Without this the waiting card reported the same
   * "not completed yet" as a dependency that is merely still running, and an
   * agent had no way to tell "wait" from "this subtree is stalled until
   * someone acts". Carried as a field rather than a third `status` so every
   * existing consumer keeps working unchanged.
   */
  parkedReason?: string | undefined;
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
        ...(dependency.park ? { parkedReason: dependency.park.reason } : {}),
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
    .map((issue) => {
      if (issue.status === 'missing') return `${issue.dependencyId} (missing)`;
      const name = issue.dependencyTitle ?? issue.dependencyId;
      const state = issue.taskStatus ?? 'incomplete';
      // A parked blocker will not clear on its own, so saying only "blocked"
      // invites the reader to wait for something that is not coming.
      return issue.parkedReason
        ? `${name} (${state}, parked: ${issue.parkedReason})`
        : `${name} (${state})`;
    })
    .join(', ');
}

/**
 * The one sentence every "this card cannot start yet" refusal uses.
 *
 * Three call sites each carried their own copy — the lifecycle transition
 * gate and two branches of the assignment gate — so an escape hint added to
 * one was invisible from the others, and which wording a caller saw depended
 * on whether it went through `transition_task` or `mark_assignment`.
 *
 * The escape clause is the point: a dependency added by mistake is not a
 * reason to complete work nobody wants, and the caller cannot be expected to
 * guess that `update_task` accepts a corrected `dependsOn`.
 */
export function dependencyIncompleteMessage(
  issues: readonly KanbanDependencyReadinessIssue[],
): string {
  const parked = issues.some((issue) => issue.parkedReason !== undefined);
  return (
    `Running requires every dependency to exist and be completed: ` +
    `${formatDependencyReadinessIssues(issues)}. ` +
    'Finish the blocking card, or — if the dependency was recorded in error — ' +
    'call kanban update_task with the corrected `dependsOn` (an empty array clears it).' +
    // A parked blocker has already exhausted its retries, so "finish the
    // blocking card" alone would send the reader back into the loop parking
    // exists to break.
    (parked
      ? ' A parked dependency has spent its verification budget and will not clear itself:' +
        ' resolve what its park reason names, or correct `dependsOn`. Do not wait on it,' +
        ' and do not re-run it unchanged.'
      : '')
  );
}

/**
 * Dependency readiness is a leaf-domain rule shared by mutations and queries.
 * Accepts either a full task id or a unique prefix (delegated to `findTask`).
 */
export function areDependenciesMet(board: KanbanBoard, taskId: string): boolean {
  return getDependencyReadinessIssues(board, taskId).length === 0;
}
