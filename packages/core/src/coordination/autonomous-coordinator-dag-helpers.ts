import type { GoalNode, KnowledgeGraph } from './knowledge-graph.js';
import type { TaskDAG } from './task-dag.js';

export function dagProgressKey(dag: TaskDAG): string {
  const s = dag.stats();
  return `${s.pending}:${s.ready}:${s.running}:${s.done}:${s.failed}:${s.skipped}`;
}

export function waitForDagProgress(dag: TaskDAG, timeoutMs: number): Promise<void> {
  const before = dagProgressKey(dag);
  if (dag.isDone()) return Promise.resolve();

  return new Promise((resolve) => {
    let off: (() => void) | undefined;
    const timer = setTimeout(() => {
      off?.();
      resolve();
    }, timeoutMs);

    off = dag.onEvent(() => {
      if (dagProgressKey(dag) === before) return;
      clearTimeout(timer);
      off?.();
      resolve();
    });
  });
}

export function rebuildDagNode(dag: TaskDAG, goal: GoalNode, deps: string[]): void {
  dag.addNode(goal.id, goal.description, deps, { tags: goal.tags });
  if (goal.status === 'in_progress') {
    dag.start(goal.id, goal.assignee ?? 'unknown');
    return;
  }
  if (goal.status === 'done') {
    dag.complete(goal.id, goal.result ?? 'Persisted completion');
    return;
  }
  if (goal.status === 'failed') {
    dag.fail(goal.id, goal.result ?? 'Persisted failure');
  }
}

export function rebuildDagFromGraph(graph: KnowledgeGraph, dag: TaskDAG): void {
  const goals = graph.getGoals({});
  const knownGoalIds = new Set(goals.map((goal) => goal.id));
  const added = new Set<string>();
  const remaining = new Map(goals.map((goal) => [goal.id, goal]));

  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, goal] of Array.from(remaining.entries())) {
      const deps = goal.blockedBy.filter((depId) => knownGoalIds.has(depId));
      if (!deps.every((depId) => added.has(depId))) continue;
      rebuildDagNode(dag, goal, deps);
      added.add(id);
      remaining.delete(id);
      progressed = true;
    }

    if (!progressed) {
      // Persisted graph has a cycle or dangling dependency set. Preserve the
      // nodes without deps rather than throwing during coordinator startup;
      // the normal deadlock detector will still surface blocked live work.
      for (const [id, goal] of Array.from(remaining.entries())) {
        rebuildDagNode(dag, goal, []);
        added.add(id);
        remaining.delete(id);
      }
    }
  }
}

export function syncDagStatuses(graph: KnowledgeGraph, dag: TaskDAG): void {
  const goals = graph.getGoals({});
  for (const goal of goals) {
    const dagNode = dag.getNode(goal.id);
    if (!dagNode) continue;
    if (goal.status === 'done' && dagNode.status !== 'done' && dagNode.status !== 'failed') {
      dag.complete(goal.id, goal.result ?? 'Completed by another session');
    } else if (
      goal.status === 'failed' &&
      dagNode.status !== 'failed' &&
      dagNode.status !== 'done'
    ) {
      dag.fail(goal.id, goal.result ?? 'Failed by another session');
    } else if (
      goal.status === 'in_progress' &&
      (dagNode.status === 'ready' || dagNode.status === 'pending')
    ) {
      dag.start(goal.id, goal.assignee ?? 'another-session');
    }
  }
}
