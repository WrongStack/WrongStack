import type { TaskGraph } from '@wrongstack/contracts/types';
import { expectDefined } from '@wrongstack/core/utils';
/**
 * Enhanced critical path analysis with bottleneck detection,
 * parallel execution groups, and time estimation.
 */
export interface CriticalPathAnalysis {
  /** Ordered list of critical path task IDs. */
  criticalPath: string[];
  /** Total estimated hours for the critical path. */
  totalHours: number;
  /** Tasks that block the most downstream work. */
  bottlenecks: BottleneckTask[];
  /** Groups of tasks that can run in parallel. */
  parallelGroups: string[][];
  /** Recommended execution order respecting dependencies. */
  executionOrder: string[];
  /** Tasks with no blockers (can start immediately). */
  readyTasks: string[];
  /** Tasks that are blocked and cannot start. */
  blockedTasks: string[];
}

export interface BottleneckTask {
  taskId: string;
  title: string;
  /** Number of tasks directly or transitively blocked by this task. */
  blockedCount: number;
  /** Total estimated hours of blocked downstream work. */
  blockedHours: number;
  /** Severity score (0-100). */
  severity: number;
}

/**
 * Analyze a task graph and return critical path analysis.
 */
export function analyzeCriticalPath(graph: TaskGraph): CriticalPathAnalysis {
  const nodes = Array.from(graph.nodes.values());
  const topoOrder = dependencyFirstOrder(graph);

  // Canonical depends_on direction: dependency (from) → dependent (to).
  const blockedByMap = new Map<string, Set<string>>();
  const blocksMap = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    if (edge.type === 'depends_on') {
      if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
      if (!blockedByMap.has(edge.to)) blockedByMap.set(edge.to, new Set());
      blockedByMap.get(edge.to)?.add(edge.from);

      if (!blocksMap.has(edge.from)) blocksMap.set(edge.from, new Set());
      blocksMap.get(edge.from)?.add(edge.to);
    }
  }

  // Find ready tasks (no blockers or all blockers completed)
  const readyTasks: string[] = [];
  const blockedTasks: string[] = [];

  for (const node of nodes) {
    if (node.status === 'completed') continue;
    const blockers = blockedByMap.get(node.id);
    if (!blockers || blockers.size === 0) {
      readyTasks.push(node.id);
    } else {
      const allCompleted = Array.from(blockers).every((id) => {
        const n = graph.nodes.get(id);
        return n?.status === 'completed';
      });
      if (allCompleted) {
        readyTasks.push(node.id);
      } else {
        blockedTasks.push(node.id);
      }
    }
  }

  // Compute bottleneck scores
  const bottlenecks: BottleneckTask[] = [];
  for (const node of nodes) {
    if (node.status === 'completed') continue;
    const downstream = getTransitiveBlocked(graph, node.id, blocksMap);
    const activeDownstream = Array.from(downstream).filter((id) => {
      const downstreamNode = graph.nodes.get(id);
      return downstreamNode?.status !== 'completed';
    });
    if (activeDownstream.length > 0) {
      const blockedHours = activeDownstream.reduce(
        (sum, id) => sum + taskEstimateHours(graph, id, 0),
        0,
      );
      bottlenecks.push({
        taskId: node.id,
        title: node.title,
        blockedCount: activeDownstream.length,
        blockedHours,
        severity: Math.min(100, Math.round((activeDownstream.length / nodes.length) * 100)),
      });
    }
  }

  bottlenecks.sort((a, b) => b.severity - a.severity);

  // Compute critical path (longest dependency → dependent path by estimated hours).
  const criticalPath = computeCriticalPath(graph, blocksMap);

  // Total hours on critical path
  const totalHours = criticalPath.reduce((sum, id) => {
    return sum + taskEstimateHours(graph, id, 0);
  }, 0);

  // Parallel execution groups
  const parallelGroups = computeParallelGroups(graph, blockedByMap);

  // Execution order: topo sort filtered to non-completed tasks
  const executionOrder = topoOrder.filter((id) => {
    const n = graph.nodes.get(id);
    return n && n.status !== 'completed';
  });

  return {
    criticalPath,
    totalHours,
    bottlenecks,
    parallelGroups,
    executionOrder,
    readyTasks,
    blockedTasks,
  };
}

/**
 * Return a dependency-first order for every graph node. Valid DAGs are fully
 * ordered; cycle members are appended deterministically so the analysis stays
 * bounded for diagnostic callers that have not run the execution-integrity gate.
 */
function dependencyFirstOrder(graph: TaskGraph): string[] {
  const ids = Array.from(graph.nodes.keys());
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (edge.type !== 'depends_on') continue;
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
    const dependents = outgoing.get(edge.from);
    if (dependents) dependents.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const id = ready[cursor]!;
    order.push(id);
    for (const dependent of outgoing.get(id) ?? []) {
      const next = indegree.get(dependent)! - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }

  const ordered = new Set(order);
  for (const id of ids) {
    if (!ordered.has(id)) order.push(id);
  }
  return order;
}

/**
 * Get all tasks transitively blocked by a given task.
 */
function getTransitiveBlocked(
  _graph: TaskGraph,
  taskId: string,
  blocksMap: Map<string, Set<string>>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = expectDefined(queue.shift());
    const blocked = blocksMap.get(current);
    if (!blocked) continue;
    for (const id of blocked) {
      if (!visited.has(id) && id !== taskId) {
        visited.add(id);
        queue.push(id);
      }
    }
  }

  return visited;
}

/**
 * Compute the critical path (longest path by estimated hours).
 */
function computeCriticalPath(graph: TaskGraph, blocksMap: Map<string, Set<string>>): string[] {
  // Use all nodes in the graph, not just topo-reachable ones
  const allIds = Array.from(graph.nodes.keys());
  if (allIds.length === 0) return [];

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();

  // Initialize each node's distance to its own estimate
  for (const id of allIds) {
    dist.set(id, taskEstimateHours(graph, id, 1));
    prev.set(id, null);
  }

  // Relax edges repeatedly (Bellman-Ford style) so diagnostic analysis stays
  // bounded even when a caller supplies a cyclic graph.
  // Run N-1 iterations to handle longest path in DAG.
  const n = allIds.length;
  for (let i = 0; i < n - 1; i++) {
    let changed = false;
    for (const id of allIds) {
      const blocked = blocksMap.get(id);
      if (!blocked) continue;
      for (const blockedId of blocked) {
        const candidateDist = dist.get(id)! + taskEstimateHours(graph, blockedId, 1);
        if (candidateDist > (dist.get(blockedId) ?? 0)) {
          dist.set(blockedId, candidateDist);
          prev.set(blockedId, id);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // Find the node with maximum distance (end of critical path)
  let maxDist = 0;
  let maxId = expectDefined(allIds[0]);
  for (const id of allIds) {
    const d = dist.get(id)!;
    if (d > maxDist) {
      maxDist = d;
      maxId = id;
    }
  }

  // Trace back the critical path
  const path: string[] = [];
  let current: string | null = maxId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    path.unshift(current);
    current = prev.get(current) ?? null;
  }

  return path;
}

function taskEstimateHours(graph: TaskGraph, taskId: string, fallback: number): number {
  const value = graph.nodes.get(taskId)?.estimateHours;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Compute groups of tasks that can run in parallel.
 * Tasks in the same group have no dependencies on each other.
 */
function computeParallelGroups(
  graph: TaskGraph,
  blockedByMap: Map<string, Set<string>>,
): string[][] {
  const groups: string[][] = [];
  const assigned = new Set<string>(
    Array.from(graph.nodes.values())
      .filter((n) => n.status === 'completed')
      .map((n) => n.id),
  );
  const nodes = Array.from(graph.nodes.values()).filter((n) => n.status !== 'completed');

  // Topological levels
  const remaining = new Set(nodes.map((n) => n.id));

  while (remaining.size > 0) {
    const group: string[] = [];
    for (const id of remaining) {
      const blockers = blockedByMap.get(id);
      if (!blockers || blockers.size === 0) {
        group.push(id);
      } else {
        const allAssigned = Array.from(blockers).every((b) => assigned.has(b));
        if (allAssigned) {
          group.push(id);
        }
      }
    }

    if (group.length === 0) {
      // Circular dependency or all remaining are blocked by non-completed
      // Just take the first remaining
      group.push(expectDefined(Array.from(remaining)[0]));
    }

    for (const id of group) {
      assigned.add(id);
      remaining.delete(id);
    }
    groups.push(group);
  }

  return groups;
}
