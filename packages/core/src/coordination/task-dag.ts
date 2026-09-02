/**
 * TaskDAG — Directed Acyclic Graph of tasks with fork/join semantics.
 *
 * Replaces the Director's flat `awaitTasks()` with a proper dependency graph.
 * Each task has explicit dependencies; the DAG resolves which tasks are
 * runnable at any moment and manages blocking/unblocking as tasks complete.
 *
 * Key features:
 * - Fork: one parent spawns multiple children that run in parallel
 * - Join: a task can wait for multiple children before continuing
 * - Dynamic: tasks can be added dynamically; the graph re-evaluates runnable set
 * - Cycle detection: inserting a dependency that would create a cycle throws
 * - Priority queue: within a "runnable" set, tasks are ordered by priority
 * - Deadlock detection: if no tasks are runnable and no tasks are complete,
 *   the DAG is in deadlock — agents are notified
 *
 * @module task-dag
 */

/** Represents a node in the DAG. */
export interface DAGNode {
  id: string;
  description: string;
  role?: string;
  priority: number; // lower = higher priority
  status: DAGNodeStatus;
  deps: string[]; // task ids this waits on (incoming edges)
  dependents: string[]; // task ids that wait on this (outgoing edges)
  result?: unknown;
  error?: string;
  spawnedAt?: string;
  completedAt?: string;
  assignedTo?: string;
  tags: string[];
}

export type DAGNodeStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';

/** The three settled states; a node that reached one never leaves it. */
function isTerminalDagStatus(status: DAGNodeStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped';
}

/** Event emitted by the DAG on state changes. */
export type DAGEdgeEvent =
  | { type: 'node:ready'; nodeId: string; deps: string[] }
  | { type: 'node:started'; nodeId: string; assignedTo: string }
  | { type: 'node:completed'; nodeId: string; result: unknown; blockers: string[] }
  | { type: 'node:failed'; nodeId: string; error: string; blockers: string[] }
  | { type: 'node:skipped'; nodeId: string; reason: string }
  | { type: 'deadlock'; blocked: string[] }
  | { type: 'graph:done'; allDone: boolean };

export type DAGEdgeHandler = (event: DAGEdgeEvent) => void;

/** Callback invoked when the DAG produces a set of runnable tasks. */
export type RunnablesHandler = (nodes: DAGNode[]) => void;

export class TaskDAG {
  private readonly nodes = new Map<string, DAGNode>();
  private readonly handlers = new Set<DAGEdgeHandler>();
  private readonly runnablesHandlers = new Set<RunnablesHandler>();
  private runnableCache: DAGNode[] | null = null;

  // ── Node management ───────────────────────────────────────────────────

  /**
   * Add a task node. Dependencies are validated for cycles.
   * Throws if adding a dep would create a cycle.
   */
  addNode(
    id: string,
    description: string,
    deps: string[] = [],
    opts: {
      role?: string;
      priority?: number;
      tags?: string[];
    } = {},
  ): void {
    if (this.nodes.has(id)) return; // idempotent

    // Validate: all deps exist
    for (const depId of deps) {
      if (!this.nodes.has(depId)) {
        throw new Error(
          `TaskDAG.addNode: unknown dependency "${depId}" for task "${id}". Add the dep first.`,
        );
      }
    }

    // Cycle detection: would adding this edge create a cycle?
    /* v8 ignore start -- unreachable: a brand-new id has no dependents, so adding it can never close a cycle */
    if (this._wouldCycle(id, deps)) {
      throw new Error(
        `TaskDAG.addNode: adding deps [${deps.join(', ')}] to "${id}" would create a cycle.`,
      );
    }
    /* v8 ignore stop */

    const node: DAGNode = {
      id,
      description,
      deps: [...deps],
      status: deps.length === 0 ? 'ready' : 'pending',
      role: opts.role,
      priority: opts.priority ?? 5,
      dependents: [],
      tags: opts.tags ?? [],
    } as DAGNode;

    // Register in both directions
    this.nodes.set(id, node);
    for (const depId of deps) {
      this.nodes.get(depId)!.dependents.push(id);
    }

    this.invalidateCache();
    this._emitReady();
  }

  /**
   * Remove a node and all edges to/from it.
   * Skips any dependents that would become dangling.
   */
  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Notify dependents they lost a dep (they may become ready)
    for (const depId of node.deps) {
      const dep = this.nodes.get(depId);
      if (dep) {
        dep.dependents = dep.dependents.filter((d) => d !== id);
      }
    }

    // Remove the node BEFORE checking dependents so the readiness guard
    // `!this.nodes.has(d)` sees the removed dependency as satisfied. The old
    // code deleted the node AFTER this loop, so a dependent whose only
    // unsatisfied dep was the removed node stayed 'pending' forever — the
    // guard saw the node still in the map with a non-'done' status.
    this.nodes.delete(id);
    this.invalidateCache();

    // Mark dependents with no remaining deps as ready
    for (const depId of node.dependents) {
      const dep = this.nodes.get(depId);
      if (dep?.deps.every((d) => !this.nodes.has(d) || this.nodes.get(d)!.status === 'done')) {
        this._transition(depId, 'pending', 'ready');
      }
    }
  }

  // ── State transitions ──────────────────────────────────────────────────

  /**
   * Mark a task as running. Returns true if the transition was valid
   * (task was in 'ready' state), false otherwise.
   */
  start(id: string, assignedTo: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    if (node.status !== 'ready') return false;
    node.status = 'running';
    node.assignedTo = assignedTo;
    node.spawnedAt = new Date().toISOString();
    this.invalidateCache();
    this._emit({ type: 'node:started', nodeId: id, assignedTo });
    return true;
  }

  /**
   * Mark a task as completed. Unblocks all dependents; they become 'ready'
   * if all their deps are done.
   */
  complete(id: string, result: unknown): void {
    const node = this.nodes.get(id);
    if (!node) return;
    // Terminal states are absorbing — first outcome wins. `claim()` already
    // guards its transition; these did not, and the DAG is shared across
    // sessions (`autonomous-coordinator` folds in "completed/failed by
    // another session" goal updates), so a duplicated or late cross-session
    // report could rewrite a settled node — `fail()` after `complete()`
    // flipped `done` to `failed` and re-emitted lifecycle events. Dependents
    // were already safe (`_transition` checks its from-state); the node's own
    // record was not.
    if (isTerminalDagStatus(node.status)) return;
    node.status = 'done';
    node.result = result;
    node.completedAt = new Date().toISOString();
    this.invalidateCache();

    const blocked: string[] = [];
    for (const depId of node.dependents) {
      const dep = this.nodes.get(depId);
      /* v8 ignore next -- defensive: dependents are kept consistent (removeNode prunes them) */
      if (!dep) continue;
      // Check if all deps are now done
      const allDone = dep.deps
        .filter((d) => this.nodes.has(d))
        .every((d) => this.nodes.get(d)!.status === 'done');
      if (allDone) {
        this._transition(depId, 'pending', 'ready');
      } else {
        blocked.push(depId);
      }
    }

    this._emit({ type: 'node:completed', nodeId: id, result, blockers: blocked });
    if (blocked.length === 0) this._emitReady();
  }

  /**
   * Mark a task as failed. Unblocks dependents but they remain 'pending'
   * (they may still be runnable if other deps succeeded).
   */
  fail(id: string, error: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    // Same absorbing rule as `complete` — see the comment there.
    if (isTerminalDagStatus(node.status)) return;
    node.status = 'failed';
    node.error = error;
    node.completedAt = new Date().toISOString();
    this.invalidateCache();

    const blocked: string[] = [];
    for (const depId of node.dependents) {
      const dep = this.nodes.get(depId);
      /* v8 ignore next -- defensive: dependents are kept consistent (removeNode prunes them) */
      if (!dep) continue;
      const allDone = dep.deps
        .filter((d) => this.nodes.has(d))
        .every((d) => {
          const s = this.nodes.get(d)!.status;
          return s === 'done' || s === 'skipped';
        });
      if (allDone) {
        /* v8 ignore next -- unreachable: the just-failed dep is never done/skipped, so a dependent is never fully satisfied here */
        this._transition(depId, 'pending', 'ready');
      } else {
        blocked.push(depId);
      }
    }

    this._emit({ type: 'node:failed', nodeId: id, error, blockers: blocked });
    if (blocked.length === 0) this._emitReady();
  }

  /**
   * Skip a task (e.g., it was deemed unnecessary by an earlier step).
   * Treats it as done for dependency purposes.
   */
  skip(id: string, reason: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    // Same absorbing rule as `complete` — see the comment there.
    if (isTerminalDagStatus(node.status)) return;
    node.status = 'skipped';
    node.completedAt = new Date().toISOString();
    this.invalidateCache();

    for (const depId of node.dependents) {
      const dep = this.nodes.get(depId);
      /* v8 ignore next -- defensive: dependents are kept consistent (removeNode prunes them) */
      if (!dep) continue;
      const allDone = dep.deps
        .filter((d) => this.nodes.has(d))
        .every((d) => {
          const s = this.nodes.get(d)!.status;
          return s === 'done' || s === 'skipped';
        });
      if (allDone) this._transition(depId, 'pending', 'ready');
    }

    this._emit({ type: 'node:skipped', nodeId: id, reason });
  }

  // ── Queries ────────────────────────────────────────────────────────────

  getNode(id: string): DAGNode | undefined {
    return this.nodes.get(id);
  }

  getAll(): DAGNode[] {
    return Array.from(this.nodes.values());
  }

  getReady(): DAGNode[] {
    if (this.runnableCache) return this.runnableCache;
    const runnable = Array.from(this.nodes.values())
      .filter((n) => n.status === 'ready')
      .sort((a, b) => a.priority - b.priority);
    this.runnableCache = runnable;
    return runnable;
  }

  getRunning(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'running');
  }

  getPending(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'pending');
  }

  getDone(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'done');
  }

  getFailed(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'failed');
  }

  getCompleted(): DAGNode[] {
    return Array.from(this.nodes.values()).filter(
      (n) => n.status === 'done' || n.status === 'skipped',
    );
  }

  isDone(): boolean {
    return Array.from(this.nodes.values()).every(
      (n) => n.status === 'done' || n.status === 'failed' || n.status === 'skipped',
    );
  }

  isFailed(): boolean {
    return Array.from(this.nodes.values()).some((n) => n.status === 'failed');
  }

  /** All tasks that are currently blocked (pending but not ready). */
  getBlocked(): DAGNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'pending');
  }

  /** Topological sort — tasks in dependency order. */
  getTopologicalOrder(): DAGNode[] {
    const visited = new Set<string>();
    const result: DAGNode[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.nodes.get(id);
      if (!node) return;
      for (const depId of node.deps) visit(depId);
      result.push(node);
    };

    for (const id of this.nodes.keys()) visit(id);
    return result;
  }

  /** Check for deadlock: no runnable tasks but not done. */
  hasDeadlock(): boolean {
    if (this.isDone()) return false;
    return this.getReady().length === 0 && this.getRunning().length === 0;
  }

  /** Stats snapshot for reporting. */
  stats(): {
    total: number;
    pending: number;
    ready: number;
    running: number;
    done: number;
    failed: number;
    skipped: number;
    progress: number; // 0-1
  } {
    const all = Array.from(this.nodes.values());
    const done = all.filter((n) => n.status === 'done' || n.status === 'skipped').length;
    return {
      total: all.length,
      pending: all.filter((n) => n.status === 'pending').length,
      ready: all.filter((n) => n.status === 'ready').length,
      running: all.filter((n) => n.status === 'running').length,
      done: all.filter((n) => n.status === 'done').length,
      failed: all.filter((n) => n.status === 'failed').length,
      skipped: all.filter((n) => n.status === 'skipped').length,
      progress: all.length ? done / all.length : 0,
    };
  }

  // ── Events ────────────────────────────────────────────────────────────

  onEvent(handler: DAGEdgeHandler): () => void {
    this.handlers.add(handler);
    return () => void this.handlers.delete(handler);
  }

  onRunnable(handler: RunnablesHandler): () => void {
    this.runnablesHandlers.add(handler);
    return () => void this.runnablesHandlers.delete(handler);
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _transition(id: string, from: DAGNodeStatus, to: DAGNodeStatus): void {
    const node = this.nodes.get(id);
    if (!node || node.status !== from) return;
    node.status = to;
    this.invalidateCache();
    if (to === 'ready') {
      this._emit({ type: 'node:ready', nodeId: id, deps: node.deps });
    }
  }

  private _emit(event: DAGEdgeEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch {
        /* swallow handler errors */
      }
    }
  }

  private _emitReady(): void {
    const runnable = this.getReady();
    if (this.hasDeadlock()) {
      this._emit({ type: 'deadlock', blocked: this.getBlocked().map((n) => n.id) });
    } else {
      this._emit({ type: 'graph:done', allDone: this.isDone() });
    }
    if (runnable.length > 0) {
      for (const h of this.runnablesHandlers) {
        try {
          h(runnable);
        } catch {
          /* swallow */
        }
      }
    }
  }

  private invalidateCache(): void {
    this.runnableCache = null;
  }

  /**
   * DFS cycle detection. Adding edge (id → dep) creates a cycle if
   * there already exists a path from dep to id.
   */
  private _wouldCycle(id: string, newDeps: string[]): boolean {
    // Adding edge (id depends on dep) cycles iff `dep` can already reach `id`
    // by following the dependency direction. So walk `deps` (incoming edges),
    // NOT `dependents` (outgoing) — the latter walks away from id and can never
    // find the back-path.
    const visited = new Set<string>();
    const stack = [...newDeps];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === id) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = this.nodes.get(current);
      if (node) stack.push(...node.deps);
    }
    return false;
  }
}
