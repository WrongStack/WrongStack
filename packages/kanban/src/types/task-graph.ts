/**
 * Task graph types — structural subset of @wrongstack/core's task-graph types.
 * Defined locally so @wrongstack/kanban has no build dependency on core.
 */
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
  startedAt?: number | undefined;
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
  /** Canonical spec scope declared by the planner/generator. */
  requiredRequirementIds?: string[] | undefined;
  title: string;
  nodes: Map<string, TaskNode>;
  edges: TaskEdge[];
  rootNodes: string[];
  createdAt: number;
  updatedAt: number;
}
