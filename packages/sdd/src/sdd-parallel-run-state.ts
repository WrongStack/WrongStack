import { randomUUID } from 'node:crypto';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  MultiAgentConfig,
  SubagentConfig,
  TaskNode,
  TaskResult,
} from '@wrongstack/contracts/types';
import type { AgentFactory } from '@wrongstack/core/coordination';
import {
  DefaultMultiAgentCoordinator,
  makeAgentSubagentRunner,
  withDisabledToolFiltering,
} from '@wrongstack/core/coordination';
import type { WorktreeHandle } from '@wrongstack/core/worktree';
import { requireSessionId } from '@wrongstack/primitives';
import type { SddParallelControlsHost } from './sdd-parallel-controls.js';
import type {
  SddParallelRunOptions,
  SddProgress,
  SddSubtaskSpec,
  TaskOutcome,
} from './sdd-parallel-run-types.js';
import { SddTaskDecomposer } from './sdd-task-decomposer.js';
import {
  applyTaskFailure as applyTaskFailureFromHost,
  type SddTaskDispatchHost,
  trySupervisorRescue as trySupervisorRescueFromHost,
} from './sdd-task-dispatch.js';
import {
  computeDeadlockChains as delegateComputeDeadlockChains,
  recoverFailedBlockers as delegateRecoverFailedBlockers,
  requeueFailedTasks as delegateRequeueFailedTasks,
  restoreRetryMap as delegateRestoreRetryMap,
  type SddTaskRecoveryHost,
} from './sdd-task-recovery.js';
import {
  allocateTaskWorktrees,
  forgetTaskWorktree,
  integrateTaskWorktree,
  resolveTaskWorktrees,
} from './sdd-worktree-integration.js';

/**
 * Run state and internal machinery behind `SddParallelRun`: limits and
 * per-task bookkeeping, event emission, pause parking, recovery/requeue
 * delegates, coordinator construction, failure handling, worktree
 * integration and the host views the `sdd-task-*` / `sdd-parallel-controls`
 * modules take. `SddParallelRun` (sdd-parallel-run.ts) extends this with the
 * public control API and the scheduler loop; the members the host views need
 * from it are declared abstract here.
 */
export abstract class SddParallelRunState {
  protected readonly slots: number;
  /** Opt-in hard wall-clock cap (undefined → no cap; idle reaper guards instead). */
  protected readonly timeoutMs: number | undefined;
  /** Idle reaper window (ms) — resets on activity; reaps only a genuine stall. */
  protected readonly idleTimeoutMs: number;
  protected readonly maxRetries: number;
  /** Max supervisor rescues per task before it must terminal-fail (loop guard). */
  protected readonly maxSupervisorEscalations: number;
  /** Per-task count of supervisor rescues used (resets nothing — bounds the loop). */
  protected supervisorEscalations = new Map<string, number>();
  /** Max end-of-run failed-task sweeps (see `maxFailedRetrySweeps`). */
  protected readonly maxFailedSweeps: number;
  /** How many failed-task sweeps have run this `run()` so far. */
  protected failedSweeps = 0;
  /** Completed-count snapshot at the last sweep, to detect a no-progress sweep. */
  protected lastSweepCompleted = 0;
  protected decomposer: SddTaskDecomposer;
  protected coordinator: DefaultMultiAgentCoordinator | null = null;
  protected stopRequested = false;
  protected retryMap = new Map<string, number>();
  readonly runId: string;
  protected readonly events?: EventBus | undefined;
  protected readonly sessionIdSource: string | (() => string | undefined) | undefined;
  protected readonly maxTotalWaves: number;
  protected readonly maxWallClockMs?: number | undefined;
  protected readonly maxRecoveryRounds: number;
  protected recoveryRounds = 0;
  /** Per-run worker identities, so the board shows "who is on what". */
  protected usedNicknames = new Set<string>();
  /** Per-task git worktree cwd (Layer 2 worktree isolation; empty otherwise). */
  protected taskCwds = new Map<string, string>();
  /** Per-task git worktree branch, for board display. */
  protected taskBranches = new Map<string, string>();
  /** Live worktree handles keyed by task id (for commit/merge/release). */
  protected taskWorktrees = new Map<string, WorktreeHandle>();
  /** Live subagent id per running task — lets cancelTask() abort exactly one. */
  protected taskSubagents = new Map<string, string>();
  /** Tasks the user cancelled mid-flight — skip retry, mark terminal-cancelled. */
  protected cancelledTasks = new Set<string>();
  /**
   * Base branch the run's squash commits land on (captured once at start when
   * worktrees are enabled). Anchors a later `rollback()`.
   */
  protected baseBranch: string | undefined;
  /**
   * Squash-merge commits this run landed on the base branch, in landing order.
   * `rollback()` reverts these (newest → oldest). Persisted via the board
   * snapshot so a post-run rollback can read them off disk.
   */
  protected mergedCommits: Array<{ taskId: string; sha: string; title: string }> = [];
  /**
   * Fatal, non-recoverable run error — set together with `stopRequested` when
   * the run hard-stops (e.g. a known-invalid merge that could not be rolled
   * back). Surfaced on `run()`'s result so the caller can see WHY it stopped.
   */
  protected fatalError: string | undefined;
  /** Monotonic dispatch counter (unique subagent ids) + dispatch-round counter. */
  protected dispatchSeq = 0;
  protected round = 0;
  /**
   * True once `run()` has returned. A FINISHED run is not "running" even when
   * the graph is left unsettled (deadlock exit): `isRunning()` gates
   * `cleanupWorktrees()` / `rollback()` / the Ctrl+C ladders, and a returned
   * run kept reporting live, silently no-oping cleanup and refusing rollback
   * with "run still active" until the user called `stop()` on a run that had
   * already ended. Cleared again at the top of `run()` so a re-run re-arms.
   */
  protected runReturned = false;

  constructor(protected readonly opts: SddParallelRunOptions) {
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
  protected emit<K extends keyof import('@wrongstack/contracts/kernel').EventMap>(
    event: K,
    payload: import('@wrongstack/contracts/kernel').EventMap[K],
  ): void {
    const sessionId = this.currentSessionId();
    this.events?.emit(event, {
      ...payload,
      sessionId,
    } as import('@wrongstack/contracts/kernel').EventMap[K]);
  }

  protected currentSessionId(): string {
    const value =
      typeof this.sessionIdSource === 'function' ? this.sessionIdSource() : this.sessionIdSource;
    return requireSessionId(value, 'SDD session operation');
  }

  protected paused = false;
  /** Resolvers for tasks parked in `waitWhilePaused`, woken on resume/stop. */
  protected pausedWaiters = new Set<() => void>();

  protected notifyPausedWaiters(): void {
    for (const resolve of this.pausedWaiters) resolve();
    this.pausedWaiters.clear();
  }

  protected async waitWhilePaused(): Promise<void> {
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
   * Compute the blocking chains for a deadlock: every still-incomplete task and
   * the blockers (by node id) that are NOT completed. Failed blockers are
   * included since they're the usual deadlock cause once retries are exhausted.
   */
  protected computeDeadlockChains(): Array<{ blocked: string; blockedBy: string[] }> {
    return delegateComputeDeadlockChains(this.sddTaskRecoveryHost());
  }

  /** Requeue failed tasks that block an incomplete dependent. Returns true if any. */
  protected recoverFailedBlockers(): boolean {
    return delegateRecoverFailedBlockers(this.sddTaskRecoveryHost());
  }

  /**
   * Requeue every terminal-failed task that the user did NOT cancel, giving each
   * a fresh `maxRetries` budget. Shared by the automatic end-of-run sweep and
   * the manual "retry all failed" control. Returns the number requeued.
   */
  protected requeueFailedTasks(reason = 'retry failed sweep'): number {
    return delegateRequeueFailedTasks(this.sddTaskRecoveryHost(), reason);
  }

  /** Restore per-task retry counts persisted in node metadata (resume support). */
  protected restoreRetryMap(): void {
    delegateRestoreRetryMap(this.sddTaskRecoveryHost());
  }

  /** Clean teardown after a stop: reset interrupted tasks + release worktrees. */
  protected async teardown(): Promise<void> {
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
  protected abortRun(reason: string): void {
    this.fatalError = reason;
    this.stopRequested = true;
    this.coordinator?.stopAll();
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  protected buildCoordinator(): void {
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

  protected defaultFactory(): AgentFactory {
    return async (_config: SubagentConfig) => ({
      agent: this.opts.agent,
      events: this.opts.agent.events,
    });
  }

  /**
   * Apply a task failure: retry (→ pending, bump retry count) while attempts
   * remain, else consult the optional supervisor (which can rescue via
   * retry/reassign/split), else terminal-fail (→ failed). Shared by the
   * worker-failure, verification-gate, and merge-conflict paths so all three
   * negotiate the same retry budget and emit the same events.
   */
  protected async applyTaskFailure(
    taskId: string,
    subagentId: string,
    errMsg: string,
  ): Promise<void> {
    return applyTaskFailureFromHost.call(this.sddTaskDispatchHost(), taskId, subagentId, errMsg);
  }

  /**
   * Consult `superviseFailure` for a task that has exhausted its retries.
   * Applies the verdict (retry / reassign+retry / split) and returns true when
   * the task was rescued (caller must NOT terminal-fail it). Bounded per task by
   * `maxSupervisorEscalations` so an always-"retry" supervisor can't loop forever.
   */
  protected async trySupervisorRescue(taskId: string, errMsg: string): Promise<boolean> {
    return trySupervisorRescueFromHost.call(this.sddTaskDispatchHost(), taskId, errMsg);
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
  protected get worktreeState() {
    return {
      taskCwds: this.taskCwds,
      taskBranches: this.taskBranches,
      taskWorktrees: this.taskWorktrees,
      mergedCommits: this.mergedCommits,
    };
  }

  protected async integrateWorktree(
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
  protected async allocateWorktrees(tasks: TaskNode[]): Promise<void> {
    await allocateTaskWorktrees(this.opts, this.worktreeState, tasks);
  }

  /**
   * Resolve each task's worktree after its result is known. Serialized merges
   * (one at a time) keep the base branch consistent; the wave structure already
   * guarantees dependency order (a task's blockers merged in an earlier wave).
   */
  protected async resolveWorktrees(tasks: TaskNode[]): Promise<void> {
    await resolveTaskWorktrees(this.opts, this.worktreeState, tasks);
  }

  protected forgetWorktree(taskId: string, opts: { keepBranchLabel?: boolean } = {}): void {
    forgetTaskWorktree(this.worktreeState, taskId, opts);
  }

  /** Persist a task's retry count into node metadata (survives crash → resume). */
  protected persistRetries(taskId: string, retries: number): void {
    const node = this.opts.tracker.getNode(taskId);
    if (node) node.metadata = { ...node.metadata, retries };
  }

  protected buildProgress(): SddProgress {
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

  protected sddTaskRecoveryHost(): SddTaskRecoveryHost {
    const self = this;
    return {
      opts: self.opts,
      get retryMap() {
        return self.retryMap;
      },
      persistRetries: (...args) => this.persistRetries(...args),
      get cancelledTasks() {
        return self.cancelledTasks;
      },
      emit: (...args) => this.emit(...args),
      runId: this.runId,
      maxRetries: this.maxRetries,
    };
  }

  protected sddTaskDispatchHost(): SddTaskDispatchHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.executeOne satisfies SddTaskDispatchHost['executeOne']);
    void (this.stopRequested satisfies SddTaskDispatchHost['stopRequested']);
    void (this.opts satisfies SddTaskDispatchHost['opts']);
    void (this.coordinator satisfies SddTaskDispatchHost['coordinator']);
    void (this.usedNicknames satisfies SddTaskDispatchHost['usedNicknames']);
    void (this.idleTimeoutMs satisfies SddTaskDispatchHost['idleTimeoutMs']);
    void (this.timeoutMs satisfies SddTaskDispatchHost['timeoutMs']);
    void (this.runId satisfies SddTaskDispatchHost['runId']);
    void (this.dispatchSeq satisfies SddTaskDispatchHost['dispatchSeq']);
    void (this.emit satisfies SddTaskDispatchHost['emit']);
    void (this.taskCwds satisfies SddTaskDispatchHost['taskCwds']);
    void (this.taskBranches satisfies SddTaskDispatchHost['taskBranches']);
    void (this.taskSubagents satisfies SddTaskDispatchHost['taskSubagents']);
    void (this.cancelledTasks satisfies SddTaskDispatchHost['cancelledTasks']);
    void (this.allocateWorktrees satisfies SddTaskDispatchHost['allocateWorktrees']);
    void (this.resolveWorktrees satisfies SddTaskDispatchHost['resolveWorktrees']);
    void (this.integrateWorktree satisfies SddTaskDispatchHost['integrateWorktree']);
    void (this.applyTaskFailure satisfies SddTaskDispatchHost['applyTaskFailure']);
    void (this.retryMap satisfies SddTaskDispatchHost['retryMap']);
    void (this.persistRetries satisfies SddTaskDispatchHost['persistRetries']);
    void (this.maxRetries satisfies SddTaskDispatchHost['maxRetries']);
    void (this.trySupervisorRescue satisfies SddTaskDispatchHost['trySupervisorRescue']);
    void (this.supervisorEscalations satisfies SddTaskDispatchHost['supervisorEscalations']);
    void (this.maxSupervisorEscalations satisfies SddTaskDispatchHost['maxSupervisorEscalations']);
    void (this.setTaskModel satisfies SddTaskDispatchHost['setTaskModel']);
    void (this.splitTask satisfies SddTaskDispatchHost['splitTask']);
    return this as unknown as SddTaskDispatchHost;
  }

  protected sddParallelControlsHost(): SddParallelControlsHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      isRunning: this.isRunning,
      opts: this.opts,
      taskWorktrees: this.taskWorktrees,
      forgetWorktree: this.forgetWorktree,
      baseBranch: this.baseBranch,
      mergedCommits: this.mergedCommits,
      retryMap: this.retryMap,
      persistRetries: this.persistRetries,
      cancelledTasks: this.cancelledTasks,
      emit: this.emit,
      runId: this.runId,
      taskSubagents: this.taskSubagents,
      coordinator: this.coordinator,
    } satisfies SddParallelControlsHost);
    return this as unknown as SddParallelControlsHost;
  }
  abstract isRunning(): boolean;
  abstract executeOne(task: TaskNode): Promise<TaskOutcome>;
  abstract setTaskModel(
    taskId: string,
    model: string | undefined,
    provider?: string | undefined,
  ): boolean;
  abstract splitTask(taskId: string, subtasks: SddSubtaskSpec[]): string[];
}
