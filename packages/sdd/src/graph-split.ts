/**
 * splitGraphNode — the single code path for graph node decomposition, shared by
 * run-time splits (SddParallelRun.splitTask, supervisor `split` verdicts) and
 * planning-time splits (plan-decompose.ts).
 *
 * Semantics (extracted verbatim from SddParallelRun.splitTask):
 *   - new leaves inherit the parent's blockers, so they cannot start before the
 *     parent's dependencies are met;
 *   - every existing dependent is rewired to depend on ALL leaves, so
 *     downstream work waits for the whole split;
 *   - the parent becomes a `completed` container (its real work lives in the
 *     leaves).
 */

import type { TaskTracker } from '@wrongstack/core/tasking';
import type { SddSubtaskSpec } from './sdd-parallel-run-types.js';

export interface SplitGraphNodeOptions {
  /** Extra refusal predicate, e.g. "task currently has a live subagent". */
  isRunning?: ((taskId: string) => boolean) | undefined;
}

/**
 * Split a task node into sub-task leaves. Refuses a missing/in-progress/running
 * task or an empty subtask list, returning []. Returns the new leaf ids.
 */
export function splitGraphNode(
  tracker: TaskTracker,
  taskId: string,
  subtasks: SddSubtaskSpec[],
  options: SplitGraphNodeOptions = {},
): string[] {
  const node = tracker.getNode(taskId);
  if (!node) return [];
  if (node.status === 'in_progress' || options.isRunning?.(taskId)) return [];
  if (!subtasks.length) return [];

  const blockers = tracker.getBlockers(taskId);
  const dependents = tracker.getDependents(taskId);

  const leafIds = subtasks.map((s) => {
    const criterion = s.successCriterion?.trim();
    const description = criterion
      ? `${s.description}\n\n**Acceptance Criteria:**\n- ${criterion}`
      : s.description;
    return tracker.addNode({
      title: s.title,
      description,
      type: s.type ?? node.type,
      priority: s.priority ?? node.priority,
      status: 'pending',
      parentId: taskId,
    } as never).id;
  });

  for (const leaf of leafIds) {
    // Each leaf inherits the parent's dependencies…
    for (const b of blockers) tracker.addDependency(b, leaf);
    // …and every prior dependent of the parent now waits on every leaf.
    for (const dep of dependents) tracker.addDependency(leaf, dep);
  }

  // The parent is now just a grouping node — mark it completed so the graph
  // can settle (its real work lives in the leaves).
  tracker.updateNodeStatus(taskId, 'completed', `split into ${leafIds.length} subtasks`);
  return leafIds;
}
