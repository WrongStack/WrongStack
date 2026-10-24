/**
 * SddParallelRun
 *
 * Drives a TaskGraph through ParallelEternalEngine's infrastructure
 * (DefaultMultiAgentCoordinator + AgentSubagentRunner) but powered by
 * SddTaskDecomposer — producing dependency-aware waves instead of
 * goal-driven iterations.
 *
 * One-shot: completes when all tasks are done OR a deadlock is detected.
 * Does NOT loop — each run() call is a discrete execution.
 *
 * Usage:
 * ```
 * const run = new SddParallelRun({ tracker, graph, agent, projectRoot });
 * await run.run({ onWave });
 * // or with progress callback:
 * await run.run({ onProgress: (p) => console.log(renderProgress(p)) });
 * ```
 */

import type { TaskNode } from '@wrongstack/contracts/types';
import type { TaskTracker } from '@wrongstack/core/tasking';
import {
  cancelTask as cancelTaskFromHost,
  cleanupWorktrees as cleanupWorktreesFromHost,
  deleteTask as deleteTaskFromHost,
  reassignTask as reassignTaskFromHost,
  retryTask as retryTaskFromHost,
  rollback as rollbackFromHost,
  setTaskFallbacks as setTaskFallbacksFromHost,
  setTaskModel as setTaskModelFromHost,
  setTaskVerification as setTaskVerificationFromHost,
  splitTask as splitTaskFromHost,
} from './sdd-parallel-controls.js';
import { SddParallelRunState } from './sdd-parallel-run-state.js';
import type {
  RunResult,
  SddSubtaskSpec,
  TaskOutcome,
  WaveResult,
} from './sdd-parallel-run-types.js';
import type { TaskBatch } from './sdd-task-decomposer.js';
import {
  executeOne as executeOneFromHost,
  executeWave as executeWaveFromHost,
} from './sdd-task-dispatch.js';
import { resetOrphans as delegateResetOrphans } from './sdd-task-recovery.js';

export type {
  RunResult,
  SddParallelRunOptions,
  SddProgress,
  SddSubtaskSpec,
  SddSupervisorVerdict,
  WaveResult,
} from './sdd-parallel-run-types.js';
export class SddParallelRun extends SddParallelRunState {
  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /** Trigger stop — causes run() to abort after the current wave. */
  stop(): void {
    this.stopRequested = true;
    this.paused = false;
    this.notifyPausedWaiters();
    this.coordinator?.stopAll();
  }

  /** Pause: no new wave starts until resume() (the current wave finishes). */
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.notifyPausedWaiters();
  }
  isPaused(): boolean {
    return this.paused;
  }
  isRunning(): boolean {
    return !this.stopRequested && !this.runReturned && !this.decomposer.isSettled();
  }

  /** Base branch the run's squash commits land on (undefined when worktrees off). */
  getBaseBranch(): string | undefined {
    return this.baseBranch;
  }

  /** Squash commits this run landed on the base branch, in landing order. */
  getMergedCommits(): ReadonlyArray<{ taskId: string; sha: string; title: string }> {
    return this.mergedCommits;
  }

  /**
   * Remove every git worktree + branch this run (and any prior run) created.
   * Refuses while the run is still live — cleaning a checkout under an active
   * worker would corrupt it. Stop first. Returns the number of worktrees removed
   * (0 when worktrees are disabled). Idempotent.
   */
  async cleanupWorktrees(): Promise<number> {
    return cleanupWorktreesFromHost(this.sddParallelControlsHost());
  }

  /**
   * Undo the run's merged commits by reverting each on the base branch (history
   * preserving). Refuses while the run is still live (stop first). Returns the
   * revert outcome; a dirty tree or revert conflict surfaces as `ok:false`.
   */
  async rollback(): Promise<{ ok: boolean; reverted: number; reason?: string }> {
    return rollbackFromHost(this.sddParallelControlsHost());
  }

  /** Requeue a task to `pending` so the scheduler re-runs it (clears retries + cancel marker). */
  retryTask(taskId: string): boolean {
    return retryTaskFromHost(this.sddParallelControlsHost(), taskId);
  }

  /** Reassign a task to a specific agent name (reflected on the board). */
  reassignTask(taskId: string, agentName: string): boolean {
    return reassignTaskFromHost(this.sddParallelControlsHost(), taskId, agentName);
  }

  /**
   * Set/override a task's worker model (and optionally provider) — applied on its
   * NEXT dispatch (a running task must be cancelled + retried to take effect). The
   * assignment lives on node metadata so it survives crash → resume.
   */
  setTaskModel(taskId: string, model: string | undefined, provider?: string | undefined): boolean {
    return setTaskModelFromHost(this.sddParallelControlsHost(), taskId, model, provider);
  }

  /** Set/override a task's fallback model chain (applied on its next dispatch). */
  setTaskFallbacks(taskId: string, fallbackModels: string[] | undefined): boolean {
    return setTaskFallbacksFromHost(this.sddParallelControlsHost(), taskId, fallbackModels);
  }

  /**
   * Set/override a task's verification command (the completion gate runs it in
   * the task's cwd and only lets the task complete on exit 0). Empty/undefined
   * clears it. Applied on the task's next verification — i.e. its next dispatch.
   */
  setTaskVerification(taskId: string, verificationCommand: string | undefined): boolean {
    return setTaskVerificationFromHost(this.sddParallelControlsHost(), taskId, verificationCommand);
  }

  /**
   * Cancel a task. If it is currently running, abort its subagent and mark the
   * node terminally failed+cancelled (so the scheduler frees the slot and does
   * NOT retry it). If it has not started, it is simply marked cancelled. Use
   * `retryTask` to bring a cancelled task back. Returns false for an unknown task.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    return cancelTaskFromHost(this.sddParallelControlsHost(), taskId);
  }

  /**
   * Delete a not-yet-started task from the graph (pending/blocked/failed only —
   * never a running task; cancel it first). Removes the node and every edge
   * touching it; dependents lose this blocker. Returns false if missing or running.
   */
  deleteTask(taskId: string): boolean {
    return deleteTaskFromHost(this.sddParallelControlsHost(), taskId);
  }

  /**
   * Split a task into sub-tasks and delegate them to separate workers. The new
   * leaves inherit the parent's blockers (so they don't start before the
   * parent's dependencies are met), every existing dependent is rewired to
   * depend on ALL leaves (so downstream work waits for the whole split), and the
   * parent becomes a `completed` container. Refuses a running task (cancel it
   * first) or empty subtask list. Returns the new leaf ids (empty on refusal).
   * The scheduler picks the new pending leaves up on its next dispatch pass.
   */
  splitTask(taskId: string, subtasks: SddSubtaskSpec[]): string[] {
    return splitTaskFromHost(this.sddParallelControlsHost(), taskId, subtasks);
  }

  /**
   * Continuous dependency-driven execution. Unlike a wave-barrier loop (where a
   * whole batch must finish before the next starts), this fills free worker
   * slots the instant a task's dependencies are satisfied: a fast task's
   * dependent starts immediately rather than waiting for a slow sibling. Truly
   * independent tasks run in parallel; dependency chains run in order. Returns
   * the final summary when the graph settles, deadlocks, stops, or hits a backstop.
   */
  async run(): Promise<RunResult> {
    this.stopRequested = false;
    this.fatalError = undefined;
    this.restoreRetryMap();
    const startTime = Date.now();
    this.round = 0;
    this.dispatchSeq = 0;
    this.runReturned = false; // re-arm: a new run() call is live again
    let totalDispatched = 0;

    this.buildCoordinator();

    // Capture the base branch once so a later rollback knows where the run's
    // squash commits landed (worktree path only; no-op without a manager).
    if (this.opts.worktrees && !this.baseBranch) {
      const base = await this.opts.worktrees.currentBase().catch(() => null);
      if (base) this.baseBranch = base.branch;
    }

    this.emit('sdd.run.started', {
      runId: this.runId,
      graphId: this.opts.graph.id,
      specId: this.opts.graph.specId,
      total: this.opts.graph.nodes.size,
      baseBranch: this.baseBranch,
    });

    this.recoveryRounds = 0;
    this.failedSweeps = 0;
    this.lastSweepCompleted = 0;
    let deadlocked = false;
    // node id → in-flight executeOne promise. size = live worker count.
    const running = new Map<string, Promise<TaskOutcome>>();

    const dispatch = (task: TaskNode): void => {
      totalDispatched++;
      const tracked = (async (): Promise<TaskOutcome> => {
        try {
          return await this.executeOne(task);
        } catch (err) {
          // A dispatch-time throw must not wedge the scheduler: mark the node
          // terminally failed (frees its dependents per failed-blocker rules).
          this.opts.tracker.updateNodeStatus(task.id, 'failed', `dispatch error: ${String(err)}`);
          this.emit('sdd.task.failed', {
            runId: this.runId,
            taskId: task.id,
            subagentId: '',
            error: String(err),
          });
          return { taskId: task.id, success: false };
        } finally {
          running.delete(task.id);
        }
      })();
      running.set(task.id, tracked);
    };

    while (!this.stopRequested) {
      // Run-level backstops — an autonomous run must always terminate.
      if (totalDispatched >= this.maxTotalWaves) {
        // The dispatch ceiling stops new work, not the promises already
        // handed to workers. Drain them before reporting run completion.
        await Promise.allSettled(running.values());
        break;
      }
      if (this.maxWallClockMs && Date.now() - startTime >= this.maxWallClockMs) {
        // A wall-clock cap must cancel active workers and use the same bounded
        // teardown path as an explicit stop instead of abandoning in-flight work.
        this.stop();
        break;
      }

      await this.waitWhilePaused();
      if (this.stopRequested) break;

      // Fill free slots with ready (dependency-satisfied) tasks not already running.
      let dispatchedThisRound = 0;
      const ready = this.decomposer.readyNodes().filter((t) => !running.has(t.id));
      for (const task of ready) {
        if (running.size >= this.slots || totalDispatched >= this.maxTotalWaves) break;
        dispatch(task);
        dispatchedThisRound++;
      }
      if (dispatchedThisRound > 0) {
        this.emit('sdd.wave', {
          runId: this.runId,
          wave: this.round,
          batchSize: dispatchedThisRound,
        });
        this.round++;
      }

      if (running.size === 0) {
        // Nothing in flight and nothing dispatched this pass.
        if (this.decomposer.isSettled()) {
          // End-of-run failed-task sweep: requeue every terminal-failed
          // (non-cancelled) task and run them again, bounded by
          // maxFailedSweeps. Stop early once a sweep yields no new completions
          // (no progress) so a hopeless task can't spin the loop forever.
          const completed = this.opts.tracker.getProgress().completed;
          const madeProgress = this.failedSweeps === 0 || completed > this.lastSweepCompleted;
          if (
            this.failedSweeps < this.maxFailedSweeps &&
            madeProgress &&
            this.requeueFailedTasks() > 0
          ) {
            this.lastSweepCompleted = completed;
            this.failedSweeps++;
            continue;
          }
          break;
        }
        const chains = this.computeDeadlockChains();
        if (chains.length > 0) {
          this.emit('sdd.deadlock', { runId: this.runId, chains });
          if (this.recoveryRounds < this.maxRecoveryRounds && this.recoverFailedBlockers()) {
            this.recoveryRounds++;
            continue;
          }
          deadlocked = true;
        }
        // No running, no ready, no recoverable deadlock → no further progress.
        break;
      }

      // If we still have a free slot AND a ready task, loop to dispatch it now;
      // otherwise wait for any in-flight task to settle (which may unblock more).
      const moreReadyNow =
        running.size < this.slots && this.decomposer.readyNodes().some((t) => !running.has(t.id));
      if (!moreReadyNow) {
        await Promise.race(running.values());
        this.opts.onProgress?.(this.buildProgress());
      }
    }

    // Clean teardown on stop: interrupted tasks reset, worktrees released.
    if (this.stopRequested) {
      await Promise.allSettled(running.values());
      await this.teardown();
    }

    const finalProgress = this.opts.tracker.getProgress();

    this.emit('sdd.run.finished', {
      runId: this.runId,
      deadlocked,
      completed: finalProgress.completed,
      failed: finalProgress.failed,
      stopped: this.stopRequested,
      ...(this.fatalError ? { fatalError: this.fatalError } : {}),
    });

    // The run has finished — release the liveness gate even when the graph is
    // left unsettled (deadlock exit), so cleanupWorktrees()/rollback() and the
    // host's Ctrl+C ladders stop treating the returned run as live.
    this.runReturned = true;
    return {
      totalWaves: this.round,
      totalCompleted: finalProgress.completed,
      totalFailed: finalProgress.failed,
      totalDurationMs: Date.now() - startTime,
      deadlocked,
      stopRequested: this.stopRequested,
      ...(this.fatalError ? { fatalError: this.fatalError } : {}),
      finalProgress,
    };
  }

  /**
   * Manually requeue all failed tasks to `pending` (board "Retry all failed").
   * Unlike the automatic sweep this also clears any `cancelled` marker, so a
   * user can bring cancelled tasks back in the same action — mirroring
   * `retryTask`. Picked up by the running scheduler on its next dispatch pass.
   * Returns the number of tasks requeued.
   */
  retryAllFailed(): number {
    const failed = this.opts.tracker.getAllNodes({ status: ['failed'] });
    for (const node of failed) {
      this.cancelledTasks.delete(node.id);
      this.opts.tracker.patchMetadata(node.id, { cancelled: undefined });
    }
    return this.requeueFailedTasks('manual retry all');
  }

  /**
   * Reset orphaned `in_progress` tasks (no agent runs them after a crash) back
   * to `pending` so a fresh run re-executes them. Call before constructing a run
   * from a reloaded graph. Static so callers don't need a run instance.
   */
  static resetOrphans(tracker: TaskTracker): number {
    return delegateResetOrphans(tracker);
  }

  /**
   * Execute a batch of tasks together. Retained as a thin wrapper over the
   * single-task primitive `executeOne` so the wave-oriented tests and any
   * batch callers keep working; the continuous scheduler in `run()` calls
   * `executeOne` directly. Throws if no coordinator is wired or a spawn fails
   * (surfaced from `executeOne`), preserving the original all-or-nothing contract.
   */
  async executeWave(batch: TaskBatch): Promise<WaveResult> {
    return executeWaveFromHost.call(this.sddTaskDispatchHost(), batch);
  }

  /**
   * Execute one task end-to-end: assign a worker identity, allocate its worktree,
   * spawn + assign the subagent, await its result, then update tracker status
   * (success / retry / terminal-fail / cancelled) and resolve the worktree. This
   * is the unit the continuous scheduler dispatches into a free slot. Throws on a
   * missing coordinator or failed spawn so callers can enforce all-or-nothing.
   */
  async executeOne(task: TaskNode): Promise<TaskOutcome> {
    return executeOneFromHost.call(this.sddTaskDispatchHost(), task);
  }
}
