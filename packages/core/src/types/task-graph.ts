export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskType = 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  type: TaskType;
  priority: TaskPriority;
  status: TaskStatus;
  assignee?: string | undefined;
  estimateHours?: number | undefined;
  actualHours?: number | undefined;
  tags?: string[] | undefined;
  specRequirementId?: string | undefined;
  parentId?: string | undefined;
  children?: string[] | undefined;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | undefined; // set when status → in_progress
  completedAt?: number | undefined;
  metadata?: Record<string, unknown>;
}

export interface TaskEdge {
  id: string;
  from: string;
  to: string;
  type: 'blocks' | 'depends_on' | 'relates_to' | 'implements';
  weight?: number | undefined;
}

export interface TaskGraph {
  id: string;
  specId: string;
  /** Canonical spec scope. When present, execution must retain at least one task per id. */
  requiredRequirementIds?: string[] | undefined;
  title: string;
  nodes: Map<string, TaskNode>;
  edges: TaskEdge[];
  rootNodes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskDependency {
  taskId: string;
  blockedBy: string[];
  blocking: string[];
}

export interface TaskAssignment {
  taskId: string;
  assignee: string;
  assignedAt: number;
}

export interface TaskProgress {
  total: number;
  pending: number;
  inProgress: number;
  blocked: number;
  failed: number;
  review: number;
  completed: number;
  percentComplete: number;
  estimatedHours: number;
  actualHours: number;
}

export interface TaskFilter {
  status?: TaskStatus[] | undefined;
  priority?: TaskPriority[] | undefined;
  type?: TaskType[] | undefined;
  assignee?: string[] | undefined;
  tags?: string[] | undefined;
  specRequirementId?: string | undefined;
}

export interface TaskSort {
  field: 'priority' | 'createdAt' | 'updatedAt' | 'status';
  direction: 'asc' | 'desc';
}

export interface CriticalPathResult {
  taskIds: string[];
  totalEstimateHours: number;
  bottleneckTasks: string[];
}

export function computeTaskProgress(graph: TaskGraph): TaskProgress {
  let completed = 0;
  let pending = 0;
  let inProgress = 0;
  let blocked = 0;
  let failed = 0;
  let review = 0;
  let estimatedHours = 0;
  let actualHours = 0;
  for (const n of graph.nodes.values()) {
    switch (n.status) {
      case 'completed':
        completed++;
        break;
      case 'pending':
        pending++;
        break;
      case 'in_progress':
        inProgress++;
        break;
      case 'blocked':
        blocked++;
        break;
      case 'failed':
        failed++;
        break;
      case 'review':
        review++;
        break;
    }
    estimatedHours += n.estimateHours ?? 0;
    actualHours += n.actualHours ?? 0;
  }
  const total = graph.nodes.size;

  return {
    total,
    pending,
    inProgress,
    blocked,
    failed,
    review,
    completed,
    percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
    estimatedHours,
    actualHours,
  };
}

export function findCriticalPath(graph: TaskGraph): CriticalPathResult {
  const nodes = Array.from(graph.nodes.values());
  const criticalNodes = nodes.filter((n) => n.priority === 'critical');
  const bottleneckTasks = criticalNodes
    .filter((n) => graph.edges.some((e) => e.to === n.id && e.type === 'depends_on'))
    .map((n) => n.id);

  const totalEstimateHours = criticalNodes.reduce((sum, n) => sum + (n.estimateHours ?? 0), 0);

  return {
    taskIds: criticalNodes.map((n) => n.id),
    totalEstimateHours,
    bottleneckTasks,
  };
}

export function topologicalSort(graph: TaskGraph): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const result: string[] = [];

  function visit(id: string): void {
    // Cycle: callers must detect cycles up-front if they care; we just stop recursing.
    if (inStack.has(id)) return;
    if (visited.has(id)) return;
    if (!graph.nodes.has(id)) return;

    visited.add(id);
    inStack.add(id);

    for (const edge of graph.edges) {
      if (edge.from === id) visit(edge.to);
    }

    inStack.delete(id);
    result.push(id);
  }

  for (const rootId of graph.rootNodes) {
    visit(rootId);
  }

  return result;
}

export type SerializableTaskGraphNodes =
  | TaskNode[]
  | Array<[string, TaskNode]>
  | Record<string, TaskNode>;

export type SerializableTaskGraph = Omit<TaskGraph, 'nodes'> & {
  nodes: SerializableTaskGraphNodes;
};

export type SerializedTaskGraph = Omit<TaskGraph, 'nodes'> & {
  nodes: TaskNode[];
};

export function serializeTaskGraph(graph: TaskGraph): SerializedTaskGraph {
  return {
    ...graph,
    nodes: Array.from(graph.nodes.values()),
  };
}

export function deserializeTaskGraph(input: SerializableTaskGraph): TaskGraph {
  const nodes = new Map<string, TaskNode>();
  if (Array.isArray(input.nodes)) {
    for (const entry of input.nodes) {
      if (Array.isArray(entry)) nodes.set(entry[0], { ...entry[1], id: entry[1].id || entry[0] });
      else nodes.set(entry.id, entry);
    }
  } else {
    for (const [id, node] of Object.entries(input.nodes)) {
      nodes.set(id, { ...node, id: node.id || id });
    }
  }
  return { ...input, nodes };
}
