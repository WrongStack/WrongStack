/**
 * SddTaskDecomposer
 *
 * Converts a TaskGraph (from SDD's TaskGenerator) into a dependency-aware
 * sequence of batches for ParallelEternalEngine.
 *
 * Key behaviour:
 * - Each `nextBatch()` call returns up to `parallelSlots` ready tasks
 *   (all blockers completed, sorted by priority).
 * - Tasks that are blocked by an in-progress task are NOT included
 *   in the batch — they wait for the blocker to complete.
 * - When `isDone()` returns true the whole graph is either completed
 *   or deadlocked (all remaining tasks are blocked by failed tasks).
 *
 * Usage:
 * ```
 * const decomposer = new SddTaskDecomposer(tracker, graph, { parallelSlots: 4 });
 * while (!decomposer.isDone()) {
 *   const batch = decomposer.nextBatch();
 *   if (batch.length === 0) break; // deadlock
 *   await fanOut(batch);
 *   decomposer.acknowledgeBatch(batch.map(t => t.id));
 * }
 * ```
 */

import type { TaskNode, TaskGraph } from '@wrongstack/core/types';
import type { TaskTracker } from '@wrongstack/core/tasking';

export interface SddTaskDecomposerOptions {
  /** Max tasks per batch. Default: 4. Range 1–16. */
  parallelSlots?: number | undefined;
}

export interface TaskBatch {
  /** Tasks ready to execute in this wave. */
  tasks: TaskNode[];
  /** 0-based wave number since the decomposer was constructed. */
  wave: number;
  /** True when every node in the graph is either completed or failed. */
  allDone: boolean;
  /** True when no batch was produced because remaining tasks are all blocked by failed nodes. */
  deadlocked: boolean;
}

export class SddTaskDecomposer {
  private readonly slots: number;
  private wave = 0;

  constructor(
    private readonly tracker: TaskTracker,
    _graph: TaskGraph,
    opts: SddTaskDecomposerOptions = {},
  ) {
    this.slots = Math.min(16, Math.max(1, opts.parallelSlots ?? 4));
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Return the next batch of runnable tasks.
   * Returns `allDone: true` when every node is completed.
   * Returns `deadlocked: true` when no batch can be produced because
   * all remaining tasks are blocked by failed nodes.
   */
  nextBatch(): TaskBatch {
    if (this.isDone()) {
      return { tasks: [], wave: this.wave, allDone: true, deadlocked: false };
    }

    const pending = this.pendingReadyNodes();

    if (pending.length === 0) {
      // No runnable tasks — check for deadlock
      const hasBlockedTasks = this.hasAnyBlockedTasks();
      return { tasks: [], wave: this.wave, allDone: false, deadlocked: hasBlockedTasks };
    }

    const batch = pending.slice(0, this.slots);
    return { tasks: batch, wave: this.wave, allDone: false, deadlocked: false };
  }

  /**
   * Advance the wave counter after a batch completes.
   * Call this once per `nextBatch()` result that was fan-out.
   */
  acknowledgeBatch(_completedTaskIds: string[]): void {
    this.wave++;
  }

  /**
   * True when every node in the graph is completed.
   * Use this to exit the fan-out loop after `isDone() || deadlocked`.
   */
  isDone(): boolean {
    const progress = this.tracker.getProgress();
    return progress.total > 0 && progress.completed === progress.total;
  }

  /**
   * Total waves produced so far.
   */
  getWaveCount(): number {
    return this.wave;
  }

  /**
   * All ready (dependency-satisfied) pending tasks, priority-sorted — UNSLICED.
   * The continuous scheduler fills its own free slots from this list, so unlike
   * `nextBatch()` it does not cap at `slots`.
   */
  readyNodes(): TaskNode[] {
    return this.pendingReadyNodes();
  }

  /**
   * True when every node has reached a terminal state (completed or failed).
   * This — not `isDone()` (which requires ALL completed) — is the correct loop
   * exit for the continuous scheduler: a terminally-failed task must not keep
   * the run spinning to its backstop.
   */
  isSettled(): boolean {
    const nodes = this.tracker.getAllNodes();
    return (
      nodes.length > 0 && nodes.every((n) => n.status === 'completed' || n.status === 'failed')
    );
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  /**
   * Return pending nodes whose blockers are all completed.
   * Sorted by priority (critical first), then by creation time.
   */
  private pendingReadyNodes(): TaskNode[] {
    const allPending = this.tracker.getAllNodes({ status: ['pending'] });
    const ready: TaskNode[] = [];

    for (const node of allPending) {
      if (this.tracker.canStart(node.id)) {
        ready.push(node);
      }
    }

    // Sort by priority first, then by createdAt
    const priorityRank: Record<TaskNode['priority'], number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };

    ready.sort((a, b) => {
      const pr = priorityRank[a.priority] - priorityRank[b.priority];
      if (pr !== 0) return pr;
      return a.createdAt - b.createdAt;
    });

    return ready;
  }

  /** True when at least one non-completed, non-failed task is blocked. */
  private hasAnyBlockedTasks(): boolean {
    const nodes = this.tracker.getAllNodes({
      status: ['pending', 'in_progress', 'blocked'],
    });
    return nodes.some((n) => n.status === 'blocked');
  }
}
