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

import { randomUUID } from 'node:crypto';
import type { AgentFactory } from '@wrongstack/core/coordination';
import {
  DefaultMultiAgentCoordinator,
  makeAgentSubagentRunner,
  withDisabledToolFiltering,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { TaskTracker } from '@wrongstack/core/tasking';
import type {
  MultiAgentConfig,
  SubagentConfig,
  TaskNode,
  TaskResult,
} from '@wrongstack/core/types';
import type { WorktreeHandle } from '@wrongstack/core/worktree';
import { requireSessionId } from '@wrongstack/primitives';
import { splitGraphNode } from './graph-split.js';
import type {
  RunResult,
  SddParallelRunOptions,
  SddProgress,
  SddSubtaskSpec,
  SddSupervisorVerdict,
  TaskOutcome,
  WaveResult,
} from './sdd-parallel-run-types.js';
import { SddTaskDecomposer, type TaskBatch } from './sdd-task-decomposer.js';
import { executeSddTask } from './sdd-task-execution.js';
import {
  allocateTaskWorktrees,
  forgetTaskWorktree,
  integrateTaskWorktree,
  resolveTaskWorktrees,
} from './sdd-worktree-integration.js';

export type {
  RunResult,
  SddParallelRunOptions,
  SddProgress,
  SddSubtaskSpec,
  SddSupervisorVerdict,
  WaveResult,
} from './sdd-parallel-run-types.js';
export class SddParallelRun {
  private readonly slots: number;
  /** Opt-in hard wall-clock cap (undefined → no cap; idle reaper guards instead). */
  private readonly timeoutMs: number | undefined;
  /** Idle reaper window (ms) — resets on activity; reaps only a genuine stall. */
  private readonly idleTimeoutMs: number;
  private readonly maxRetries: number;
  /** Max supervisor rescues per task before it must terminal-fail (loop guard). */
  private readonly maxSupervisorEscalations: number;
  /** Per-task count of supervisor rescues used (resets nothing — bounds the loop). */
  private supervisorEscalations = new Map<string, number>();
  /** Max end-of-run failed-task sweeps (see `maxFailedRetrySweeps`). */
  private readonly maxFailedSweeps: number;
  /** How many failed-task sweeps have run this `run()` so far. */
  private failedSweeps = 0;
  /** Completed-count snapshot at the last sweep, to detect a no-progress sweep. */
  private lastSweepCompleted = 0;
  private decomposer: SddTaskDecomposer;
  private coordinator: DefaultMultiAgentCoordinator | null = null;
  private stopRequested = false;
  private retryMap = new Map<string, number>();
  readonly runId: string;
  private readonly events?: EventBus | undefined;
  private readonly sessionIdSource: string | (() => string | undefined) | undefined;
  private readonly maxTotalWaves: number;
  private readonly maxWallClockMs?: number | undefined;
  private readonly maxRecoveryRounds: number;
  private recoveryRounds = 0;
  /** Per-run worker identities, so the board shows "who is on what". */
  private usedNicknames = new Set<string>();
  /** Per-task git worktree cwd (Layer 2 worktree isolation; empty otherwise). */
  private taskCwds = new Map<string, string>();
  /** Per-task git worktree branch, for board display. */
  private taskBranches = new Map<string, string>();
  /** Live worktree handles keyed by task id (for commit/merge/release). */
  private taskWorktrees = new Map<string, WorktreeHandle>();
  /** Live subagent id per running task — lets cancelTask() abort exactly one. */
  private taskSubagents = new Map<string, string>();
  /** Tasks the user cancelled mid-flight — skip retry, mark terminal-cancelled. */
  private cancelledTasks = new Set<string>();
  /**
   * Base branch the run's squash commits land on (captured once at start when
   * worktrees are enabled). Anchors a later `rollback()`.
   */
  private baseBranch: string | undefined;
  /**
   * Squash-merge commits this run landed on the base branch, in landing order.
   * `rollback()` reverts these (newest → oldest). Persisted via the board
   * snapshot so a post-run rollback can read them off disk.
   */
  private mergedCommits: Array<{ taskId: string; sha: string; title: string }> = [];
  /**
   * Fatal, non-recoverable run error — set together with `stopRequested` when
   * the run hard-stops (e.g. a known-invalid merge that could not be rolled
   * back). Surfaced on `run()`'s result so the caller can see WHY it stopped.
   */
  private fatalError: string | undefined;
  /** Monotonic dispatch counter (unique subagent ids) + dispatch-round counter. */
  private dispatchSeq = 0;
  private round = 0;

  constructor(private readonly opts: SddParallelRunOptions) {
    this.slots = Math.min(16, Math.max(1, opts.parallelSlots ?? 2));
    // Wall-clock cap is OPT-IN (undefined → none). The idle reaper is the
    // default guard: it resets on every activity signal so a productive task
    // is never killed for running long — only a genuine stall is reaped.
    this.timeoutMs = opts.taskTimeoutMs;
    this.idleTimeoutMs = Math.max(1, opts.taskIdleTimeoutMs ?? 600_000);
    this.maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.maxSupervisorEscalations = Math.max(0, opts.maxSupervisorEscalations ?? 2);
    this.maxFailedSweeps = Math.max(0, opts.maxFailedRetrySweeps ?? 2);
    this.runId = opts.runId ?? `sdd-${randomUUID().slice(0, 8)}`;
    this.events = opts.events;
    this.sessionIdSource = opts.sessionId;
    // Backstop: even with retries + recovery the loop must terminate. Derive a
    // generous ceiling from the graph size unless the caller pins one.
    this.maxTotalWaves = opts.maxTotalWaves ?? opts.graph.nodes.size * (this.maxRetries + 2) + 10;
    this.maxWallClockMs = opts.maxWallClockMs;
    this.maxRecoveryRounds = Math.max(0, opts.maxRecoveryRounds ?? 0);
    this.decomposer = new SddTaskDecomposer(opts.tracker, opts.graph, {
      parallelSlots: this.slots,
    });
  }

  /** Type-safe emit on the optional EventBus (no-op when unwired). */
  private emit<K extends keyof import('@wrongstack/core/kernel').EventMap>(
    event: K,
    payload: import('@wrongstack/core/kernel').EventMap[K],
  ): void {
    const sessionId = this.currentSessionId();
    this.events?.emit(
      event,
      (sessionId
        ? { ...payload, sessionId }
        : payload) as import('@wrongstack/core/kernel').EventMap[K],
    );
  }

  private currentSessionId(): string {
    const value =
      typeof this.sessionIdSource === 'function' ? this.sessionIdSource() : this.sessionIdSource;
    return requireSessionId(value, 'SDD session operation');
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  private paused = false;
  /** Resolvers for tasks parked in `waitWhilePaused`, woken on resume/stop. */
  private pausedWaiters = new Set<() => void>();

  private notifyPausedWaiters(): void {
    for (const resolve of this.pausedWaiters) resolve();
    this.pausedWaiters.clear();
  }

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
    return !this.stopRequested && !this.decomposer.isSettled();
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
    if (this.isRunning()) return 0;
    const wt = this.opts.worktrees;
    if (!wt) return 0;
    // Release any handles this run still holds (kept on stop / needs-review).
    for (const [taskId, handle] of [...this.taskWorktrees]) {
      await wt.release(handle, { keep: false }).catch(() => {});
      this.forgetWorktree(taskId);
    }
    const { removed } = await wt.cleanupAllManaged();
    return removed;
  }

  /**
   * Undo the run's merged commits by reverting each on the base branch (history
   * preserving). Refuses while the run is still live (stop first). Returns the
   * revert outcome; a dirty tree or revert conflict surfaces as `ok:false`.
   */
  async rollback(): Promise<{ ok: boolean; reverted: number; reason?: string }> {
    if (this.isRunning())
      return { ok: false, reverted: 0, reason: 'run still active — stop it first' };
    const wt = this.opts.worktrees;
    if (!wt || !this.baseBranch) {
      return { ok: false, reverted: 0, reason: 'no worktree run to roll back' };
    }
    return wt.revertCommits(
      this.baseBranch,
      this.mergedCommits.map((c) => c.sha),
    );
  }

  /** Requeue a task to `pending` so the scheduler re-runs it (clears retries + cancel marker). */
  retryTask(taskId: string): boolean {
    if (!this.opts.tracker.getNode(taskId)) return false;
    this.retryMap.delete(taskId);
    this.persistRetries(taskId, 0);
    // Clear any cancel marker so a previously-cancelled task can run again.
    this.cancelledTasks.delete(taskId);
    this.opts.tracker.patchMetadata(taskId, { cancelled: undefined });
    this.opts.tracker.updateNodeStatus(taskId, 'pending', 'manual retry');
    return true;
  }

  /** Reassign a task to a specific agent name (reflected on the board). */
  reassignTask(taskId: string, agentName: string): boolean {
    if (!this.opts.tracker.getNode(taskId)) return false;
    this.opts.tracker.updateNode(taskId, { assignee: agentName });
    return true;
  }

  /**
   * Set/override a task's worker model (and optionally provider) — applied on its
   * NEXT dispatch (a running task must be cancelled + retried to take effect). The
   * assignment lives on node metadata so it survives crash → resume.
   */
  setTaskModel(taskId: string, model: string | undefined, provider?: string | undefined): boolean {
    if (!this.opts.tracker.getNode(taskId)) return false;
    this.opts.tracker.patchMetadata(taskId, {
      model,
      ...(provider !== undefined ? { provider } : {}),
    });
    return true;
  }

  /** Set/override a task's fallback model chain (applied on its next dispatch). */
  setTaskFallbacks(taskId: string, fallbackModels: string[] | undefined): boolean {
    if (!this.opts.tracker.getNode(taskId)) return false;
    this.opts.tracker.patchMetadata(taskId, { fallbackModels });
    return true;
  }

  /**
   * Set/override a task's verification command (the completion gate runs it in
   * the task's cwd and only lets the task complete on exit 0). Empty/undefined
   * clears it. Applied on the task's next verification — i.e. its next dispatch.
   */
  setTaskVerification(taskId: string, verificationCommand: string | undefined): boolean {
    if (!this.opts.tracker.getNode(taskId)) return false;
    const cmd = verificationCommand?.trim();
    this.opts.tracker.patchMetadata(taskId, { verificationCommand: cmd ? cmd : undefined });
    return true;
  }

  /**
   * Cancel a task. If it is currently running, abort its subagent and mark the
   * node terminally failed+cancelled (so the scheduler frees the slot and does
   * NOT retry it). If it has not started, it is simply marked cancelled. Use
   * `retryTask` to bring a cancelled task back. Returns false for an unknown task.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const node = this.opts.tracker.getNode(taskId);
    if (!node) return false;
    // Completed is terminal: the work shipped and its dependents were already
    // unblocked. `updateNodeStatus` applies transitions blindly, so without
    // this guard a cancel racing the task's completion — the user clicks
    // cancel just as it finishes — rewrote `completed` to `failed`, showed
    // finished work as "Cancelled" on the board, and undercounted the run's
    // completed total. Cancelling a *failed* task stays allowed: its cancelled
    // marker is what blocks the end-of-run retry sweep from requeueing it.
    if (node.status === 'completed') return false;
    this.cancelledTasks.add(taskId);
    // Terminal failed + cancel marker: failed keeps dependents un-deadlocked,
    // the marker drives the "Cancelled" board look and blocks retry/auto-redispatch.
    this.opts.tracker.patchMetadata(taskId, { cancelled: true });
    this.opts.tracker.updateNodeStatus(taskId, 'failed', 'cancelled by user');
    this.emit('sdd.task.failed', {
      runId: this.runId,
      taskId,
      subagentId: '',
      error: 'cancelled by user',
    });
    const subagentId = this.taskSubagents.get(taskId);
    if (subagentId && this.coordinator) {
      await this.coordinator.stop(subagentId).catch(() => {});
    }
    return true;
  }

  /**
   * Delete a not-yet-started task from the graph (pending/blocked/failed only —
   * never a running task; cancel it first). Removes the node and every edge
   * touching it; dependents lose this blocker. Returns false if missing or running.
   */
  deleteTask(taskId: string): boolean {
    const node = this.opts.tracker.getNode(taskId);
    if (!node) return false;
    if (node.status === 'in_progress' || this.taskSubagents.has(taskId)) return false;
    this.cancelledTasks.delete(taskId);
    this.retryMap.delete(taskId);
    return this.opts.tracker.removeNode(taskId);
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
    const leafIds = splitGraphNode(this.opts.tracker, taskId, subtasks, {
      isRunning: (id) => this.taskSubagents.has(id),
    });
    if (!leafIds.length) return [];
    this.retryMap.delete(taskId);
    this.persistRetries(taskId, 0);
    this.emit('sdd.task.split', { runId: this.runId, taskId, subtaskIds: leafIds });
    return leafIds;
  }

  private async waitWhilePaused(): Promise<void> {
    // Event-driven instead of polling: park on a promise that `resume()` and
    // `stop()` resolve, so a paused run consumes zero CPU while waiting (the
    // old 100ms poll woke the loop 10×/s for nothing). A bounded fallback
    // timer guarantees progress even if a notifier is missed.
    while (this.paused && !this.stopRequested) {
      await new Promise<void>((resolve) => {
        this.pausedWaiters.add(resolve);
        const safety = setTimeout(() => {
          if (this.pausedWaiters.delete(resolve)) resolve();
        }, 1000);
        safety.unref?.();
      });
    }
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
      if (totalDispatched >= this.maxTotalWaves) break;
      if (this.maxWallClockMs && Date.now() - startTime >= this.maxWallClockMs) break;

      await this.waitWhilePaused();
      if (this.stopRequested) break;

      // Fill free slots with ready (dependency-satisfied) tasks not already running.
      let dispatchedThisRound = 0;
      const ready = this.decomposer.readyNodes().filter((t) => !running.has(t.id));
      for (const task of ready) {
        if (running.size >= this.slots) break;
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
   * Compute the blocking chains for a deadlock: every still-incomplete task and
   * the blockers (by node id) that are NOT completed. Failed blockers are
   * included since they're the usual deadlock cause once retries are exhausted.
   */
  private computeDeadlockChains(): Array<{ blocked: string; blockedBy: string[] }> {
    const tracker = this.opts.tracker;
    const chains: Array<{ blocked: string; blockedBy: string[] }> = [];
    for (const node of tracker.getAllNodes()) {
      if (node.status === 'completed' || node.status === 'failed') continue;
      const blockedBy = tracker
        .getBlockers(node.id)
        .filter((id) => tracker.getNode(id)?.status !== 'completed');
      if (blockedBy.length > 0) chains.push({ blocked: node.id, blockedBy });
    }
    return chains;
  }

  /** Requeue failed tasks that block an incomplete dependent. Returns true if any. */
  private recoverFailedBlockers(): boolean {
    const tracker = this.opts.tracker;
    let recovered = false;
    for (const node of tracker.getAllNodes({ status: ['failed'] })) {
      const blocksIncomplete = tracker.getDependents(node.id).some((d) => {
        const s = tracker.getNode(d)?.status;
        return s !== 'completed' && s !== 'failed';
      });
      if (blocksIncomplete) {
        this.retryMap.delete(node.id);
        this.persistRetries(node.id, 0);
        tracker.updateNodeStatus(node.id, 'pending', 'deadlock recovery');
        recovered = true;
      }
    }
    return recovered;
  }

  /**
   * Requeue every terminal-failed task that the user did NOT cancel, giving each
   * a fresh `maxRetries` budget. Shared by the automatic end-of-run sweep and
   * the manual "retry all failed" control. Returns the number requeued.
   */
  private requeueFailedTasks(reason = 'retry failed sweep'): number {
    const tracker = this.opts.tracker;
    let n = 0;
    for (const node of tracker.getAllNodes({ status: ['failed'] })) {
      if (this.cancelledTasks.has(node.id) || node.metadata?.cancelled) continue;
      this.retryMap.delete(node.id);
      this.persistRetries(node.id, 0);
      tracker.updateNodeStatus(node.id, 'pending', reason);
      this.emit('sdd.task.retrying', {
        runId: this.runId,
        taskId: node.id,
        attempt: 0,
        maxRetries: this.maxRetries,
      });
      n++;
    }
    return n;
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

  /** Restore per-task retry counts persisted in node metadata (resume support). */
  private restoreRetryMap(): void {
    this.retryMap.clear();
    for (const node of this.opts.tracker.getAllNodes()) {
      const r = (node.metadata as { retries?: unknown } | undefined)?.retries;
      if (typeof r === 'number' && r > 0) this.retryMap.set(node.id, r);
    }
  }

  /**
   * Reset orphaned `in_progress` tasks (no agent runs them after a crash) back
   * to `pending` so a fresh run re-executes them. Call before constructing a run
   * from a reloaded graph. Static so callers don't need a run instance.
   */
  static resetOrphans(tracker: TaskTracker): number {
    let n = 0;
    for (const node of tracker.getAllNodes({ status: ['in_progress'] })) {
      tracker.updateNodeStatus(node.id, 'pending', 'resume: orphaned in_progress');
      n++;
    }
    return n;
  }

  /** Clean teardown after a stop: reset interrupted tasks + release worktrees. */
  private async teardown(): Promise<void> {
    for (const node of this.opts.tracker.getAllNodes({ status: ['in_progress'] })) {
      this.opts.tracker.updateNodeStatus(node.id, 'pending', 'run stopped');
    }
    const wt = this.opts.worktrees;
    if (wt) {
      for (const [taskId, handle] of [...this.taskWorktrees]) {
        await wt.release(handle, { keep: true }).catch(() => {});
        this.forgetWorktree(taskId);
      }
    }
  }

  /**
   * Hard-stop the run after an unrecoverable error: the base branch is in a
   * state no retry can fix (e.g. a known-invalid merge that could not be rolled
   * back), so continuing would contaminate every task forked after this point.
   * The reason is surfaced on `run()`'s result and the `sdd.run.finished` event.
   */
  private abortRun(reason: string): void {
    this.fatalError = reason;
    this.stopRequested = true;
    this.coordinator?.stopAll();
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private buildCoordinator(): void {
    const config: MultiAgentConfig = {
      coordinatorId: `sdd-parallel-${randomUUID().slice(0, 8)}`,
      maxConcurrent: this.slots,
      doneCondition: { type: 'all_tasks_done' },
      // Default budget guard for every spawned worker: idle reaper (resets on
      // activity) plus the opt-in wall-clock cap when one was configured. This
      // ensures the reaper applies even if a per-spawn config path is bypassed.
      defaultBudget: {
        idleTimeoutMs: this.idleTimeoutMs,
        ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
      },
    };
    this.coordinator = new DefaultMultiAgentCoordinator(config, {
      sessionId: () => this.currentSessionId(),
    });
    // Wrap factory with disabled tool filtering to prevent subagents from
    // using the delegate tool (or any other disabledTools in their config)
    const baseFactory = this.opts.subagentFactory ?? this.defaultFactory();
    const filteredFactory = withDisabledToolFiltering(baseFactory);
    const runner = makeAgentSubagentRunner({
      factory: filteredFactory,
      hostEvents: this.events,
    } as Parameters<typeof makeAgentSubagentRunner>[0] & { hostEvents?: EventBus });
    this.coordinator.setRunner?.(runner);
  }

  private defaultFactory(): AgentFactory {
    return async (_config: SubagentConfig) => ({
      agent: this.opts.agent,
      events: this.opts.agent.events,
    });
  }

  /**
   * Execute a batch of tasks together. Retained as a thin wrapper over the
   * single-task primitive `executeOne` so the wave-oriented tests and any
   * batch callers keep working; the continuous scheduler in `run()` calls
   * `executeOne` directly. Throws if no coordinator is wired or a spawn fails
   * (surfaced from `executeOne`), preserving the original all-or-nothing contract.
   */
  async executeWave(batch: TaskBatch): Promise<WaveResult> {
    const waveStart = Date.now();
    const outcomes = await Promise.all(batch.tasks.map((task) => this.executeOne(task)));
    const results = outcomes.map((o) => o.result).filter((r): r is TaskResult => Boolean(r));
    const successCount = outcomes.filter((o) => o.success).length;
    const failCount = outcomes.length - successCount;
    return {
      wave: batch.wave,
      batch,
      results,
      successCount,
      failCount,
      durationMs: Date.now() - waveStart,
      stopRequested: this.stopRequested,
    };
  }

  /**
   * Execute one task end-to-end: assign a worker identity, allocate its worktree,
   * spawn + assign the subagent, await its result, then update tracker status
   * (success / retry / terminal-fail / cancelled) and resolve the worktree. This
   * is the unit the continuous scheduler dispatches into a free slot. Throws on a
   * missing coordinator or failed spawn so callers can enforce all-or-nothing.
   */
  async executeOne(task: TaskNode): Promise<TaskOutcome> {
    const outcome = await executeSddTask({
      task,
      opts: this.opts,
      coordinator: this.coordinator,
      usedNicknames: this.usedNicknames,
      idleTimeoutMs: this.idleTimeoutMs,
      timeoutMs: this.timeoutMs,
      runId: this.runId,
      nextSubagentId: () => `sdd-d${this.dispatchSeq++}`,
      emit: (event, payload) => this.emit(event, payload),
      taskCwds: this.taskCwds,
      taskBranches: this.taskBranches,
      taskSubagents: this.taskSubagents,
      cancelledTasks: this.cancelledTasks,
      allocateWorktrees: (tasks) => this.allocateWorktrees(tasks),
      resolveWorktrees: (tasks) => this.resolveWorktrees(tasks),
      integrateWorktree: (taskNode, result) => this.integrateWorktree(taskNode, result),
      applyTaskFailure: (taskId, subagentId, errMsg) =>
        this.applyTaskFailure(taskId, subagentId, errMsg),
    });
    if (outcome.success) {
      this.retryMap.delete(task.id);
      this.persistRetries(task.id, 0);
    }
    return outcome;
  }

  /**
   * Apply a task failure: retry (→ pending, bump retry count) while attempts
   * remain, else consult the optional supervisor (which can rescue via
   * retry/reassign/split), else terminal-fail (→ failed). Shared by the
   * worker-failure, verification-gate, and merge-conflict paths so all three
   * negotiate the same retry budget and emit the same events.
   */
  private async applyTaskFailure(
    taskId: string,
    subagentId: string,
    errMsg: string,
  ): Promise<void> {
    const currentRetries = this.retryMap.get(taskId) ?? 0;
    if (currentRetries < this.maxRetries) {
      this.retryMap.set(taskId, currentRetries + 1);
      this.persistRetries(taskId, currentRetries + 1);
      this.opts.tracker.updateNodeStatus(
        taskId,
        'pending',
        `Retry ${currentRetries + 1}/${this.maxRetries}: ${errMsg}`,
      );
      this.emit('sdd.task.retrying', {
        runId: this.runId,
        taskId,
        attempt: currentRetries + 1,
        maxRetries: this.maxRetries,
      });
      return;
    }

    // Retries exhausted — give the supervisor a bounded chance to rescue the
    // task before it goes terminal, so a run "decides" rather than dead-ends.
    if (await this.trySupervisorRescue(taskId, errMsg)) return;

    this.opts.tracker.updateNodeStatus(taskId, 'failed', errMsg);
    this.emit('sdd.task.failed', { runId: this.runId, taskId, subagentId, error: errMsg });
  }

  /**
   * Consult `superviseFailure` for a task that has exhausted its retries.
   * Applies the verdict (retry / reassign+retry / split) and returns true when
   * the task was rescued (caller must NOT terminal-fail it). Bounded per task by
   * `maxSupervisorEscalations` so an always-"retry" supervisor can't loop forever.
   */
  private async trySupervisorRescue(taskId: string, errMsg: string): Promise<boolean> {
    const supervise = this.opts.superviseFailure;
    if (!supervise) return false;
    const used = this.supervisorEscalations.get(taskId) ?? 0;
    if (used >= this.maxSupervisorEscalations) return false;
    const node = this.opts.tracker.getNode(taskId);
    if (!node) return false;

    let verdict: SddSupervisorVerdict | undefined;
    try {
      verdict = await supervise({ task: node, error: errMsg, attempts: used });
    } catch {
      return false; // a flaky supervisor must not block terminal failure
    }
    if (!verdict || verdict.action === 'fail') return false;

    this.supervisorEscalations.set(taskId, used + 1);
    const requeue = (reason: string) => {
      this.retryMap.delete(taskId);
      this.persistRetries(taskId, 0);
      this.opts.tracker.updateNodeStatus(taskId, 'pending', reason);
    };

    if (verdict.action === 'reassign') {
      this.setTaskModel(taskId, verdict.model, verdict.provider);
      requeue(`supervisor reassign: ${verdict.model ?? 'default'}`);
      this.emit('sdd.supervisor.decision', { runId: this.runId, taskId, action: 'reassign' });
      return true;
    }
    if (verdict.action === 'split') {
      const ids = this.splitTask(taskId, verdict.subtasks);
      if (ids.length === 0) return false; // split refused (e.g. running) → let it fail
      this.emit('sdd.supervisor.decision', { runId: this.runId, taskId, action: 'split' });
      return true;
    }
    // 'retry'
    requeue('supervisor retry');
    this.emit('sdd.supervisor.decision', { runId: this.runId, taskId, action: 'retry' });
    return true;
  }

  /**
   * Integrate a verified-successful task's worktree into the base branch.
   * Commits, squash-merges (optionally running `conflictResolver` first), and on
   * success releases the worktree. On an UNRESOLVED conflict it returns
   * `{ok:false}` with the conflicting files so the caller routes the task into
   * the failure path (a retry forks a fresh worktree off the now-advanced base,
   * which usually clears the conflict). No-op `{ok:true}` when worktrees are
   * disabled or none was allocated for this task. Never throws — a merge hiccup
   * degrades to a (retryable) failure rather than wedging the run.
   */
  private get worktreeState() {
    return {
      taskCwds: this.taskCwds,
      taskBranches: this.taskBranches,
      taskWorktrees: this.taskWorktrees,
      mergedCommits: this.mergedCommits,
    };
  }

  private async integrateWorktree(
    task: TaskNode,
    result?: TaskResult,
  ): Promise<{ ok: boolean; conflictFiles?: string[]; reason?: string; fatal?: boolean }> {
    return integrateTaskWorktree({
      opts: this.opts,
      state: this.worktreeState,
      task,
      result,
      runId: this.runId,
      emit: this.emit.bind(this),
      abortRun: this.abortRun.bind(this),
    });
  }

  /** Allocate a fresh git worktree per task in the batch (no-op without a manager). */
  private async allocateWorktrees(tasks: TaskNode[]): Promise<void> {
    await allocateTaskWorktrees(this.opts, this.worktreeState, tasks);
  }

  /**
   * Resolve each task's worktree after its result is known. Serialized merges
   * (one at a time) keep the base branch consistent; the wave structure already
   * guarantees dependency order (a task's blockers merged in an earlier wave).
   */
  private async resolveWorktrees(tasks: TaskNode[]): Promise<void> {
    await resolveTaskWorktrees(this.opts, this.worktreeState, tasks);
  }

  private forgetWorktree(taskId: string, opts: { keepBranchLabel?: boolean } = {}): void {
    forgetTaskWorktree(this.worktreeState, taskId, opts);
  }

  /** Persist a task's retry count into node metadata (survives crash → resume). */
  private persistRetries(taskId: string, retries: number): void {
    const node = this.opts.tracker.getNode(taskId);
    if (node) node.metadata = { ...node.metadata, retries };
  }

  private buildProgress(): SddProgress {
    const gp = this.opts.tracker.getProgress();
    const isDeadlocked = !this.decomposer.isDone() && this.decomposer.nextBatch().deadlocked;
    return {
      wave: this.decomposer.getWaveCount(),
      total: gp.total,
      completed: gp.completed,
      inProgress: gp.inProgress,
      failed: gp.failed,
      blocked: gp.blocked,
      pending: gp.pending,
      percent: gp.percentComplete,
      deadlocked: isDeadlocked,
    };
  }
}
