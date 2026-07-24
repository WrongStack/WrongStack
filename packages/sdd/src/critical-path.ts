import { topologicalSort } from '@wrongstack/core/tasking';
import type { TaskGraph } from '@wrongstack/core/types';
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
  const topoOrder = topologicalSort(graph);

  // Build adjacency: blocker → blocked tasks
  const blockedByMap = new Map<string, Set<string>>();
  const blocksMap = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    if (edge.type === 'depends_on') {
      // edge.from depends on edge.to
      if (!blockedByMap.has(edge.from)) blockedByMap.set(edge.from, new Set());
      blockedByMap.get(edge.from)?.add(edge.to);

      if (!blocksMap.has(edge.to)) blocksMap.set(edge.to, new Set());
      blocksMap.get(edge.to)?.add(edge.from);
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
    if (downstream.size > 0) {
      const blockedHours = Array.from(downstream).reduce((sum, id) => {
        const n = graph.nodes.get(id);
        return sum + (n?.estimateHours ?? 0);
      }, 0);
      bottlenecks.push({
        taskId: node.id,
        title: node.title,
        blockedCount: downstream.size,
        blockedHours,
        severity: Math.min(100, Math.round((downstream.size / nodes.length) * 100)),
      });
    }
  }

  bottlenecks.sort((a, b) => b.severity - a.severity);

  // Compute critical path (longest path by estimated hours)
  const criticalPath = computeCriticalPath(graph, topoOrder, blockedByMap);

  // Total hours on critical path
  const totalHours = criticalPath.reduce((sum, id) => {
    return sum + (graph.nodes.get(id)!.estimateHours ?? 0);
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
function computeCriticalPath(
  graph: TaskGraph,
  _topoOrder: string[],
  blockedByMap: Map<string, Set<string>>,
): string[] {
  // Use all nodes in the graph, not just topo-reachable ones
  const allIds = Array.from(graph.nodes.keys());
  if (allIds.length === 0) return [];

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();

  // Initialize each node's distance to its own estimate
  for (const id of allIds) {
    dist.set(id, graph.nodes.get(id)?.estimateHours ?? 1);
    prev.set(id, null);
  }

  // Build reverse map: blocker → tasks it blocks
  const blocksMap = new Map<string, Set<string>>();
  for (const [taskId, blockers] of blockedByMap) {
    for (const blockerId of blockers) {
      if (!blocksMap.has(blockerId)) blocksMap.set(blockerId, new Set());
      blocksMap.get(blockerId)?.add(taskId);
    }
  }

  // Relax edges repeatedly (Bellman-Ford style) since topoOrder may be incomplete.
  // Run N-1 iterations to handle longest path in DAG.
  const n = allIds.length;
  for (let i = 0; i < n - 1; i++) {
    let changed = false;
    for (const id of allIds) {
      const blocked = blocksMap.get(id);
      if (!blocked) continue;
      for (const blockedId of blocked) {
        const candidateDist = dist.get(id)! + (graph.nodes.get(blockedId)?.estimateHours ?? 1);
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

/**
 * Compute groups of tasks that can run in parallel.
 * Tasks in the same group have no dependencies on each other.
 */
function computeParallelGroups(
  graph: TaskGraph,
  blockedByMap: Map<string, Set<string>>,
): string[][] {
  const groups: string[][] = [];
  const assigned = new Set<string>();
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
