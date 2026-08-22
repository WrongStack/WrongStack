import { ERROR_CODES, SddError } from '../types/errors.js';
import type {
  TaskFilter,
  TaskGraph,
  TaskNode,
  TaskProgress,
  TaskSort,
} from '../types/task-graph.js';
import { computeTaskProgress } from '../types/task-graph.js';
import { toErrorMessage } from '../utils/error.js';

export interface TaskStore {
  saveGraph(graph: TaskGraph): Promise<void>;
  loadGraph(id: string): Promise<TaskGraph | null>;
  listGraphs(): Promise<{ id: string; title: string; updatedAt: number }[]>;
  deleteGraph(id: string): Promise<void>;
}

export interface TaskTrackerOptions {
  store: TaskStore;
  /**
   * Called when an in-the-background persistence (`saveGraph`) rejects.
   * The synchronous TaskTracker methods (addNode/addEdge/updateNodeStatus)
   * fire-and-forget their writes; without this, a failing store silently
   * loses graph mutations. Defaults to a console.warn.
   */
  onPersistError?: ((err: unknown) => void) | undefined;
}

export interface TaskTransition {
  /** The task the transition applies to — required for per-task filtering. */
  nodeId: string;
  from: TaskNode['status'];
  to: TaskNode['status'];
  timestamp: number;
  reason?: string | undefined;
}

/** A change notification emitted to `TaskTracker.subscribe` listeners. */
export interface TaskTrackerChange {
  type: 'node_added' | 'node_updated' | 'status_changed' | 'node_removed';
  nodeId: string;
  /** For `node_removed` this is the node as it was just before deletion. */
  node: TaskNode;
  transition?: TaskTransition | undefined;
}

export type TaskTrackerListener = (change: TaskTrackerChange) => void;

export class TaskTracker {
  private graph: TaskGraph | null = null;
  private transitions: TaskTransition[] = [];
  private listeners: TaskTrackerListener[] = [];
  /**
   * Re-entrancy guard for status cascades: true while an auto-block /
   * auto-unblock cascade is running. Listener-driven mutations during a
   * cascade still record their own primary transition — only their
   * cascading is skipped (prevents unbounded recursion).
   */
  private cascading = false;
  private static readonly MAX_TRANSITIONS = 10_000;

  constructor(private readonly opts: TaskTrackerOptions) {}

  /**
   * Subscribe to live task mutations (add / update / status change). Returns an
   * unsubscribe fn. This is the hook the board projector uses to stream a live
   * snapshot — the tracker was previously fire-and-forget with no observability.
   */
  subscribe(listener: TaskTrackerListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notifyChange(change: TaskTrackerChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // A faulty listener must never break a tracker mutation.
      }
    }
  }

  /**
   * Attach an existing graph (used by PhaseOrchestrator to associate a tracker
   * with a phase's pre-built task graph without re-creating it).
   */
  setGraph(graph: TaskGraph): void {
    this.graph = graph;
  }

  async createGraph(specId: string, title: string): Promise<TaskGraph> {
    this.graph = {
      id: crypto.randomUUID(),
      specId,
      title,
      nodes: new Map(),
      edges: [],
      rootNodes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.opts.store.saveGraph(this.graph);
    return this.graph;
  }

  async loadGraph(id: string): Promise<TaskGraph | null> {
    this.graph = await this.opts.store.loadGraph(id);
    return this.graph;
  }

  addNode(node: Omit<TaskNode, 'id' | 'createdAt' | 'updatedAt'>): TaskNode {
    if (!this.graph)
      throw new SddError({
        message: 'No graph loaded',
        code: ERROR_CODES.SDD_INVALID_STATE,
      });

    const now = Date.now();
    const newNode: TaskNode = {
      ...node,
      id: crypto.randomUUID(),
      status: node.status ?? 'pending',
      createdAt: now,
      updatedAt: now,
    };

    this.graph.nodes.set(newNode.id, newNode);

    if (!node.parentId) {
      this.graph.rootNodes.push(newNode.id);
    }

    this.graph.updatedAt = now;
    this.persist();
    this.notifyChange({ type: 'node_added', nodeId: newNode.id, node: newNode });

    return newNode;
  }

  addEdge(from: string, to: string, type: TaskGraph['edges'][0]['type'] = 'depends_on'): void {
    if (!this.graph)
      throw new SddError({
        message: 'No graph loaded',
        code: ERROR_CODES.SDD_INVALID_STATE,
      });

    // BIZ-004: `addEdge` used to accept anything, so a typo'd endpoint or a
    // cycle silently produced a graph whose `canStart()` stayed false forever.
    // Validate here and fail loudly; `addDependency` remains the
    // boolean-returning soft wrapper for agent-declared references.
    if (!this.graph.nodes.has(from) || !this.graph.nodes.has(to)) {
      throw new SddError({
        message: `Cannot add ${type} edge ${from} -> ${to}: endpoint task is not in the graph`,
        code: ERROR_CODES.SDD_NOT_READY,
        context: { from, to, type },
      });
    }
    if (from === to) {
      throw new SddError({
        message: `Cannot add ${type} edge: self-loop on task ${from}`,
        code: ERROR_CODES.SDD_INVALID_STATE,
        context: { nodeId: from, type },
      });
    }
    // Exact duplicate — idempotent no-op (mirrors addDependency's contract).
    if (this.graph.edges.some((e) => e.from === from && e.to === to && e.type === type)) return;
    // Cycle guard for dependency edges: adding `from -> to` (to depends on
    // from) closes a loop when `from` already (transitively) depends on `to`.
    if (type === 'depends_on' && this.dependsOnTransitively(from, to, new Set())) {
      throw new SddError({
        message: `Cannot add depends_on edge ${from} -> ${to}: it would create a dependency cycle`,
        code: ERROR_CODES.SDD_INVALID_STATE,
        context: { from, to },
      });
    }

    this.graph.edges.push({
      id: crypto.randomUUID(),
      from,
      to,
      type,
    });
    this.graph.updatedAt = Date.now();
    this.persist();
  }

  /**
   * Declare that `taskId` depends on `depId` (a `depends_on` edge `depId → taskId`),
   * guarding against self-loops, duplicates, missing nodes, and cycles. Returns
   * true if the dependency now holds (added or already present), false if it was
   * rejected (would create a cycle / unknown node). This is the safe entry point
   * for wiring agent-declared `dependsOn` references into the graph.
   */
  addDependency(depId: string, taskId: string): boolean {
    if (!this.graph) return false;
    if (depId === taskId) return false;
    if (!this.graph.nodes.has(depId) || !this.graph.nodes.has(taskId)) return false;
    // Already a blocker — idempotent success.
    if (this.getBlockers(taskId).includes(depId)) return true;
    // Cycle guard: if `depId` already (transitively) depends on `taskId`, adding
    // `taskId → depId` would close a loop. Reject rather than deadlock the run.
    if (this.dependsOnTransitively(depId, taskId, new Set())) return false;
    this.addEdge(depId, taskId, 'depends_on');
    return true;
  }

  /** True when `taskId` transitively depends on `targetId` (follows depends_on blockers). */
  private dependsOnTransitively(taskId: string, targetId: string, seen: Set<string>): boolean {
    if (taskId === targetId) return true;
    if (seen.has(taskId)) return false;
    seen.add(taskId);
    for (const blocker of this.getBlockers(taskId)) {
      if (this.dependsOnTransitively(blocker, targetId, seen)) return true;
    }
    return false;
  }

  /**
   * Merge `patch` into a node's `metadata` (used for per-task model/provider/
   * fallback assignment and the cancel marker). Persists + notifies as a node
   * update. No-op if the node is missing.
   */
  patchMetadata(id: string, patch: Record<string, unknown>): void {
    if (!this.graph) return;
    const node = this.graph.nodes.get(id);
    if (!node) return;
    node.metadata = { ...node.metadata, ...patch };
    node.updatedAt = Date.now();
    this.graph.updatedAt = node.updatedAt;
    this.persist();
    this.notifyChange({ type: 'node_updated', nodeId: id, node });
  }

  /**
   * Remove a node and every edge touching it. Intended for deleting a task that
   * has not started yet — callers must gate on status (do not remove a running
   * task). Dependents simply lose this blocker (re-evaluated by `canStart`).
   * Returns true if a node was removed.
   */
  removeNode(id: string): boolean {
    if (!this.graph) return false;
    const node = this.graph.nodes.get(id);
    if (!node) return false;
    if (
      node.specRequirementId &&
      this.graph.requiredRequirementIds?.includes(node.specRequirementId) &&
      !Array.from(this.graph.nodes.values()).some(
        (candidate) =>
          candidate.id !== id && candidate.specRequirementId === node.specRequirementId,
      )
    ) {
      // The declared requirement scope is authority, not the mutable task list.
      // Removing its last implementing task would make the work disappear from
      // the scheduler and falsely improve completion percentage.
      return false;
    }
    this.graph.nodes.delete(id);
    this.graph.edges = this.graph.edges.filter((e) => e.from !== id && e.to !== id);
    this.graph.rootNodes = this.graph.rootNodes.filter((r) => r !== id);
    // Detach from any parent's children list.
    for (const n of this.graph.nodes.values()) {
      if (n.children?.includes(id)) n.children = n.children.filter((c) => c !== id);
    }
    this.graph.updatedAt = Date.now();
    this.persist();
    this.notifyChange({ type: 'node_removed', nodeId: id, node });
    return true;
  }

  updateNodeStatus(id: string, status: TaskNode['status'], reason?: string): void {
    if (!this.graph)
      throw new SddError({
        message: 'No graph loaded',
        code: ERROR_CODES.SDD_INVALID_STATE,
      });

    const node = this.graph.nodes.get(id);
    if (!node)
      throw new SddError({
        message: `Node ${id} not found`,
        code: ERROR_CODES.SDD_NOT_READY,
        context: { nodeId: id },
      });

    const from = node.status;
    const now = Date.now();
    node.status = status;
    node.updatedAt = now;

    if (status === 'completed') {
      node.completedAt = now;
      node.startedAt = node.startedAt ?? now; // ensure startedAt is set
    }
    if (status === 'in_progress') {
      node.startedAt = now;
    }

    this.transitions.push({ nodeId: id, from, to: status, timestamp: now, reason });
    if (this.transitions.length > TaskTracker.MAX_TRANSITIONS) {
      this.transitions.splice(0, this.transitions.length - TaskTracker.MAX_TRANSITIONS);
    }

    // Auto-unblock / auto-block cascades. Re-entrancy is guarded inside the
    // helpers (flag set around their work): a listener notified mid-cascade
    // may mutate statuses but cannot re-enter the cascade itself.
    if (status === 'completed') {
      this.unblockDependents(id);
    }

    if (status === 'in_progress') {
      this.checkAndBlockIfNeeded(id);
    }

    this.graph.updatedAt = now;
    this.persist();
    this.notifyChange({
      type: 'status_changed',
      nodeId: id,
      node,
      transition: { nodeId: id, from, to: status, timestamp: now, reason },
    });
  }

  updateNode(
    id: string,
    patch: Partial<
      Pick<TaskNode, 'title' | 'description' | 'priority' | 'estimateHours' | 'tags' | 'assignee'>
    >,
  ): void {
    if (!this.graph)
      throw new SddError({
        message: 'No graph loaded',
        code: ERROR_CODES.SDD_INVALID_STATE,
      });

    const node = this.graph.nodes.get(id);
    if (!node)
      throw new SddError({
        message: `Node ${id} not found`,
        code: ERROR_CODES.SDD_NOT_READY,
        context: { nodeId: id },
      });

    if (patch.title !== undefined) node.title = patch.title;
    if (patch.description !== undefined) node.description = patch.description;
    if (patch.priority !== undefined) node.priority = patch.priority;
    if (patch.estimateHours !== undefined) node.estimateHours = patch.estimateHours;
    if (patch.tags !== undefined) node.tags = patch.tags;
    if (patch.assignee !== undefined) node.assignee = patch.assignee;
    node.updatedAt = Date.now();
    this.graph.updatedAt = node.updatedAt;
    this.persist();
    this.notifyChange({ type: 'node_updated', nodeId: id, node });
  }

  getNode(id: string): TaskNode | undefined {
    return this.graph?.nodes.get(id);
  }

  getAllNodes(filter?: TaskFilter, sort?: TaskSort): TaskNode[] {
    if (!this.graph) return [];

    let nodes = Array.from(this.graph.nodes.values());

    if (filter) {
      nodes = nodes.filter((n) => {
        if (filter.status?.length && !filter.status.includes(n.status)) return false;
        if (filter.priority?.length && !filter.priority.includes(n.priority)) return false;
        if (filter.type?.length && !filter.type.includes(n.type)) return false;
        if (filter.assignee?.length && n.assignee && !filter.assignee.includes(n.assignee))
          return false;
        if (filter.tags?.length && n.tags && !n.tags.some((t) => filter.tags?.includes(t)))
          return false;
        if (filter.specRequirementId && n.specRequirementId !== filter.specRequirementId)
          return false;
        return true;
      });
    }

    if (sort) {
      nodes.sort((a, b) => {
        const cmp = compareByField(a, b, sort.field);
        return sort.direction === 'asc' ? cmp : -cmp;
      });
    }

    return nodes;
  }

  getChildren(parentId: string): TaskNode[] {
    if (!this.graph) return [];
    return Array.from(this.graph.nodes.values()).filter((n) => n.parentId === parentId);
  }

  getDependents(taskId: string): string[] {
    if (!this.graph) return [];
    return this.graph.edges
      .filter((e) => e.from === taskId && e.type === 'depends_on')
      .map((e) => e.to);
  }

  getBlockers(taskId: string): string[] {
    if (!this.graph) return [];
    return this.graph.edges
      .filter((e) => e.to === taskId && e.type === 'depends_on')
      .map((e) => e.from);
  }

  canStart(taskId: string): boolean {
    const blockers = this.getBlockers(taskId);
    return blockers.every((id) => {
      const node = this.graph?.nodes.get(id);
      // A task can start when all blockers are either completed or failed.
      // Failed blockers should not permanently deadlock dependent tasks.
      return node?.status === 'completed' || node?.status === 'failed';
    });
  }

  getProgress(): TaskProgress {
    if (!this.graph) {
      return {
        total: 0,
        pending: 0,
        inProgress: 0,
        blocked: 0,
        failed: 0,
        review: 0,
        completed: 0,
        percentComplete: 0,
        estimatedHours: 0,
        actualHours: 0,
      };
    }
    return computeTaskProgress(this.graph);
  }

  /**
   * Recorded transitions in insertion order (oldest first — the array is
   * trimmed from the front). With `taskId`, only that task's transitions are
   * returned, still oldest-first; a consumer wanting newest-first reverses
   * the result. Per-task filtering is possible because every TaskTransition
   * carries `nodeId` (BIZ-005).
   */
  getTransitions(taskId?: string): TaskTransition[] {
    return taskId === undefined
      ? [...this.transitions]
      : this.transitions.filter((t) => t.nodeId === taskId);
  }

  /**
   * Record a cascade-driven status change (BIZ-003): mutate the node, push a
   * TaskTransition, persist, and notify subscribers — the same effects an
   * explicit updateNodeStatus produces — so the board projector's live
   * snapshot and the transition log observe auto-block/auto-unblock.
   */
  private recordCascadeStatusChange(
    nodeId: string,
    node: TaskNode,
    to: TaskNode['status'],
    reason: string,
  ): void {
    const from = node.status;
    if (from === to) return; // no-op transitions are not recorded
    const now = Date.now();
    node.status = to;
    node.updatedAt = now;
    if (this.graph) this.graph.updatedAt = now;
    this.transitions.push({ nodeId, from, to, timestamp: now, reason });
    if (this.transitions.length > TaskTracker.MAX_TRANSITIONS) {
      this.transitions.splice(0, this.transitions.length - TaskTracker.MAX_TRANSITIONS);
    }
    this.persist();
    this.notifyChange({
      type: 'status_changed',
      nodeId,
      node,
      transition: { nodeId, from, to, timestamp: now, reason },
    });
  }

  private unblockDependents(completedId: string): void {
    if (!this.graph || this.cascading) return;
    this.cascading = true;
    try {
      const dependents = this.getDependents(completedId);
      for (const depId of dependents) {
        const dep = this.graph.nodes.get(depId);
        if (dep?.status !== 'blocked') continue;
        // Check if all blockers are now completed
        const remainingBlockers = this.getBlockers(depId);
        const allUnblocked = remainingBlockers.every((id) => {
          const blocker = this.graph?.nodes.get(id);
          return blocker?.status === 'completed' || blocker?.status === 'failed';
        });
        if (allUnblocked) {
          this.recordCascadeStatusChange(
            depId,
            dep,
            'pending',
            `auto-unblocked: blocker ${completedId} reached a terminal state`,
          );
        }
      }
    } finally {
      this.cascading = false;
    }
  }

  private checkAndBlockIfNeeded(taskId: string): void {
    if (!this.graph || this.cascading) return;
    this.cascading = true;
    try {
      const blockers = this.getBlockers(taskId);
      const incomplete = blockers.filter((id) => {
        const blocker = this.graph?.nodes.get(id);
        // A task is only blocked by incomplete blockers that haven't failed.
        // Failed tasks should not block their dependents.
        return blocker?.status !== 'completed' && blocker?.status !== 'failed';
      });
      if (incomplete.length > 0) {
        const node = this.graph.nodes.get(taskId);
        if (node) {
          this.recordCascadeStatusChange(
            taskId,
            node,
            'blocked',
            `auto-blocked: incomplete blocker(s) ${incomplete.join(', ')}`,
          );
        }
      }
    } finally {
      this.cascading = false;
    }
  }

  /**
   * Fire-and-forget persistence with attached error handler.
   * Synchronous mutators (addNode/addEdge/updateNodeStatus) use this to
   * avoid forcing an async cascade through every caller; if the store
   * is missing or throwing, the error is surfaced via onPersistError.
   */
  private persist(): void {
    if (!this.graph) return;
    this.opts.store.saveGraph(this.graph).catch((err) => {
      this.opts.onPersistError
        ? this.opts.onPersistError(err)
        : console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'task_tracker.save_graph_failed',
              message: toErrorMessage(err),
              timestamp: new Date().toISOString(),
            }),
          );
    });
  }
}

// Sort comparison helpers
const PRIORITY_RANK: Record<TaskNode['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const STATUS_RANK: Record<TaskNode['status'], number> = {
  in_progress: 0,
  pending: 1,
  review: 2,
  blocked: 3,
  failed: 4,
  completed: 5,
};

function compareByField(a: TaskNode, b: TaskNode, field: TaskSort['field']): number {
  switch (field) {
    case 'priority':
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case 'status':
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    case 'createdAt':
      return a.createdAt - b.createdAt;
    case 'updatedAt':
      return a.updatedAt - b.updatedAt;
  }
}
