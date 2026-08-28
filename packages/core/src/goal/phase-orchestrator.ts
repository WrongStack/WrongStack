import { noOpLogger } from '../infrastructure/logger.js';
import type { EventBus } from '../kernel/events.js';
import { DefaultTaskStore, TaskTracker } from '../tasking/index.js';
import type { Logger } from '../types/logger.js';
import type { TaskNode } from '../types/task-graph.js';
import { toErrorMessage } from '../utils/error.js';
import type { WorktreeHandle, WorktreeManager } from '../worktree/worktree-manager.js';
import {
  addPhaseTask,
  findPhaseOfTaskInGraph,
  movePhaseTask,
  requeuePhaseTask,
  setPhaseTaskAssignee,
} from './phase-board-mutations.js';
import {
  commitAndEnqueueMerge,
  failPhaseAfterTasks,
  type IntegrationContext,
  keepWorktreeForReview,
  worktreeEnv,
} from './phase-orchestrator-integration.js';
import {
  getActivePhases,
  getCompletedTaskCount,
  getExecutableTasks,
  getFailedTaskCount,
  getProgress,
  getReadyPhases,
  isGraphComplete,
  truncate,
} from './phase-orchestrator-queries.js';
import { createNoopEventBus, normalizePhaseGraphForResume } from './phase-orchestrator-runtime.js';
import type {
  NormalizedGoalOptions,
  PhaseOrchestratorOptions,
} from './phase-orchestrator-types.js';
import type {
  PhaseEventMap,
  PhaseEventName,
  PhaseExecutionContext,
  PhaseGraph,
  PhaseNode,
  PhaseProgress,
  PhaseStatus,
} from './types.js';

export type { PhaseOrchestratorOptions } from './phase-orchestrator-types.js';

/**
 * PhaseOrchestrator - dependency-aware engine for running phases autonomously.
 *
 * Features:
 * - Automatically starts the next phase as each phase completes in autonomous mode
 * - Supports parallel phases with parallelizable=true
 * - Assigns and releases agents
 * - Integrates with the event bus
 * - Supports pause and resume
 */
export class PhaseOrchestrator {
  private graph: PhaseGraph;
  private ctx: PhaseExecutionContext;
  private opts: NormalizedGoalOptions;
  private events: EventBus;
  private stopped = false;
  private paused = false;
  /**
   * Run-wide abort source. stop() aborts it; every in-flight
   * ctx.executeTask call observes the abort through its per-task signal
   * (composed from this controller and the task's own timeout controller).
   * Recreated by start() so a stopped orchestrator can be reused.
   */
  private stopController = new AbortController();
  private runningPhases = new Set<string>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private trackerCache = new Map<string, TaskTracker>();
  private taskRetryCounts = new Map<string, number>();

  // ── Git-worktree isolation (optional) ──────────────────────────────────────
  private readonly worktrees?: WorktreeManager | undefined;
  private readonly logger: Logger;
  /** Per-phase worktree handles, keyed by phase id. */
  private readonly phaseWorktrees = new Map<string, WorktreeHandle>();
  /** Serializes all merges back to the base branch (one at a time). */
  private mergeQueue: Promise<void> = Promise.resolve();
  /** Per-phase merge promise, so a phase merges only after its deps do. */
  private readonly phaseMergePromise = new Map<string, Promise<void>>();

  constructor(opts: PhaseOrchestratorOptions) {
    this.graph = opts.graph;
    this.ctx = opts.ctx;
    this.events = opts.events ?? createNoopEventBus();
    this.worktrees = opts.worktrees;
    this.logger = opts.logger ?? noOpLogger;
    this.opts = {
      maxConcurrentPhases: opts.maxConcurrentPhases ?? 1,
      maxConcurrentTasks: opts.maxConcurrentTasks ?? 2,
      maxRetries: opts.maxRetries ?? 2,
      maxVerifyAttempts: opts.maxVerifyAttempts ?? 2,
      autonomous: opts.autonomous ?? true,
      phaseDelayMs: opts.phaseDelayMs ?? 0,
      // Autonomous goals must fail closed. Continuing after a terminal task or
      // gate failure can make dependent phases look complete without their
      // required evidence.
      stopOnFailure: opts.stopOnFailure ?? true,
      taskTimeoutMs: opts.taskTimeoutMs ?? 600_000,
      events: this.events,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the full phase flow.
   * In autonomous mode, starts root phases and automatically starts the next phase when they finish.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.paused = false;
    // Fresh run-wide abort source: a previous stop() aborted the old one, and
    // reusing it would instantly abort every task of this new run.
    this.stopController = new AbortController();
    this.normalizeForResume();
    this.graph.startedAt = Date.now();
    this.graph.updatedAt = Date.now();

    // Run phases in order; later phases still start when autonomous=false.
    let readyPhases = this.getReadyPhases();
    while (readyPhases.length > 0 && !this.stopped) {
      await this.waitWhilePaused();
      if (this.stopped) break;

      const batch = readyPhases.slice(0, this.opts.maxConcurrentPhases);
      await Promise.all(batch.map((p) => this.startPhase(p)));

      // Apply phase delay.
      if (this.opts.phaseDelayMs > 0) {
        await this.delay(this.opts.phaseDelayMs);
      }

      await this.waitWhilePaused();
      if (this.stopped) break;

      // Check for newly ready phases after a phase completes.
      readyPhases = this.getReadyPhases().filter(
        (p) => !this.runningPhases.has(p.id) && p.status !== 'completed' && p.status !== 'failed',
      );
    }

    // Wait for all queued worktree merges to finish in the background so
    // changes reach the base branch before the graph is declared completed.
    await this.drainMerges();

    // Autonomous tick loop for real-time monitoring. Guarded so a stop() that
    // landed during start() cannot leave a ticking timer behind: tick()
    // early-returns when stopped, but nothing would ever clear this interval.
    if (this.opts.autonomous && !this.stopped) {
      if (this.tickInterval) clearInterval(this.tickInterval);
      this.tickInterval = setInterval(() => this.tick(), 1000);
    }
  }

  /**
   * Make a (possibly resumed) graph runnable. A graph loaded from disk after an
   * interrupted run can carry transient state from the dead process: phases left
   * `running` and tasks left `in_progress`. The scheduler only starts `pending`
   * phases (getReadyPhases) and only runs `pending` tasks (getExecutableTasks),
   * so without this a resumed phase/task would stall forever. Reset that
   * transient state to `pending`; terminal phases (completed/failed/skipped) and
   * already-completed tasks are untouched, so completed work is never re-run.
   * For a freshly built graph this is a no-op.
   */
  private normalizeForResume(): void {
    normalizePhaseGraphForResume(this.graph);
  }

  /** Wait for all pending phase merges, dependency-ordered and globally serialized. */
  private async drainMerges(): Promise<void> {
    await Promise.allSettled([...this.phaseMergePromise.values()]);
    await this.mergeQueue.catch((err) => {
      const msg = toErrorMessage(err);
      this.logger.warn(msg, { event: 'orchestrator.merge_queue_failed' });
    });
  }

  /** Pause: active phases continue, but no new phase starts. */
  pause(): void {
    this.paused = true;
  }

  /** Resume: new phases may start again. */
  resume(): void {
    this.paused = false;
    this.tick().catch((err) => {
      const msg = toErrorMessage(err);
      this.logger.error(msg, { event: 'orchestrator.tick_failed' });
    });
  }

  /** Stop completely, including active phases. */
  stop(): void {
    this.stopped = true;
    // Cancel every in-flight task execution BEFORE releasing worktrees: the
    // abort propagates through ctx.executeTask's signal so agent runs reject
    // promptly instead of continuing to write into worktrees that are about
    // to be released underneath them.
    this.stopController.abort();
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    for (const phaseId of this.runningPhases) {
      const phase = this.graph.phases.get(phaseId);
      if (phase) {
        this.updatePhaseStatus(phase, 'paused');
      }
    }
    // Release per-phase/task caches — they are no longer needed once stopped.
    this.trackerCache.clear();
    this.taskRetryCounts.clear();
    // Preserve any live worktrees for inspection rather than discarding work.
    if (this.worktrees) {
      for (const handle of this.worktrees.list()) {
        void this.worktrees.release(handle, { keep: true }).catch(() => {});
      }
    }
  }

  // ─── Tick Loop (Autonomous) ───────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped || this.paused) return;

    const active = this.getActivePhases();
    const queued = this.getReadyPhases();

    this.emit('autonomous.tick', {
      activePhases: active.map((p) => p.id),
      queuedPhases: queued.map((p) => p.id),
    });

    this.ctx.onTick?.({ activePhases: active, readyPhases: queued });

    // Is there a slot to start a new phase?
    const availableSlots = this.opts.maxConcurrentPhases - active.length;
    if (availableSlots > 0 && queued.length > 0) {
      for (const phase of queued.slice(0, availableSlots)) {
        if (phase.status === 'pending') {
          await this.startPhase(phase);
        }
      }
    }

    // Are all phases complete?
    if (this.isComplete()) {
      this.onGraphComplete();
      return;
    }

    // Did a phase fail while stopOnFailure is enabled?
    if (this.opts.stopOnFailure && this.graph.failedPhaseIds.length > 0) {
      const failedPhase = this.graph.phases.get(this.graph.failedPhaseIds[0] ?? '');
      if (failedPhase) {
        this.onGraphFailed(failedPhase);
      }
      return;
    }
  }

  // ─── Phase Execution ──────────────────────────────────────────────────────

  private async startPhase(phase: PhaseNode): Promise<void> {
    if (phase.status !== 'pending' && phase.status !== 'ready') return;

    this.updatePhaseStatus(phase, 'running');
    phase.startedAt = Date.now();
    this.runningPhases.add(phase.id);
    this.graph.activePhaseIds.push(phase.id);

    // Allocate an isolated git worktree for this phase, if a manager is wired.
    // Allocation failure degrades gracefully to the shared working tree.
    if (this.worktrees && !this.phaseWorktrees.has(phase.id)) {
      try {
        const handle = await this.worktrees.allocate(phase.id, {
          slugHint: phase.name,
          ownerLabel: phase.name,
        });
        if (handle.status === 'active') this.phaseWorktrees.set(phase.id, handle);
      } catch {
        // Manager already emitted worktree.failed; run on the shared tree.
      }
    }

    this.emit('phase.started', { phaseId: phase.id, name: phase.name });

    try {
      if (phase.taskGraph.nodes.size === 0) {
        await this.failPhaseAfterTasks(
          phase,
          'Phase has no executable tasks. Add task evidence before starting this phase.',
        );
        return;
      }
      await this.executePhaseTasks(phase);

      // stop() marks running phases 'paused' before the aborted batch
      // settles; continuing to the completion gate would overwrite that with
      // 'completed' and merge a phase whose tasks were aborted mid-flight.
      if (this.stopped) return;

      const failedTasks = this.getFailedTaskCount(phase);
      const completedTasks = this.getCompletedTaskCount(phase);

      this.emit('phase.allTasksDone', {
        phaseId: phase.id,
        completed: completedTasks,
        failed: failedTasks,
      });

      if (failedTasks > 0 && this.opts.stopOnFailure) {
        await this.failPhaseAfterTasks(phase, `${failedTasks} task(s) failed`);
        return;
      }

      // Verification gate: all tasks succeeded, but the produced code must still
      // pass (typecheck/test/…) before we mark the phase done and merge it back.
      // Skipped entirely when no verifyPhase callback is wired (back-compat).
      const verdict = await this.runVerifyGate(phase);
      if (!verdict.ok) {
        await this.failPhaseAfterTasks(
          phase,
          `verification failed${verdict.output ? `: ${this.truncate(verdict.output)}` : ''}`,
        );
        return;
      }

      this.updatePhaseStatus(phase, 'completed');
      phase.completedAt = Date.now();
      phase.actualDurationMs = Date.now() - (phase.startedAt ?? Date.now());
      this.runningPhases.delete(phase.id);
      this.graph.activePhaseIds = this.graph.activePhaseIds.filter((id) => id !== phase.id);
      this.graph.completedPhaseIds.push(phase.id);
      this.emit('phase.completed', {
        phaseId: phase.id,
        name: phase.name,
        durationMs: phase.actualDurationMs,
      });
      this.ctx.onPhaseComplete?.(phase);
      // Commit the phase's work in its worktree and queue the merge back into
      // the base branch (dependency-ordered + globally serialized).
      await this.commitAndEnqueueMerge(phase);
    } catch (error) {
      this.updatePhaseStatus(phase, 'failed');
      phase.completedAt = Date.now();
      phase.actualDurationMs = Date.now() - (phase.startedAt ?? Date.now());
      this.runningPhases.delete(phase.id);
      this.graph.activePhaseIds = this.graph.activePhaseIds.filter((id) => id !== phase.id);
      this.graph.failedPhaseIds.push(phase.id);
      this.emit('phase.failed', {
        phaseId: phase.id,
        name: phase.name,
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.onPhaseFail?.(phase, error instanceof Error ? error : new Error(String(error)));
      await this.keepWorktreeForReview(phase);
    }
  }

  // ─── Verification gate ──────────────────────────────────────────────────────

  /**
   * Run the verification gate for a phase whose tasks all succeeded. Verifies in
   * the phase's worktree; on failure, runs the repair pass and re-verifies, up to
   * `maxVerifyAttempts` repairs. Returns the final verdict. When no `verifyPhase`
   * callback is wired the gate is a no-op and always passes.
   */
  private async runVerifyGate(
    phase: PhaseNode,
  ): Promise<{ ok: boolean; output?: string | undefined }> {
    if (!this.ctx.verifyPhase) return { ok: true };
    const env = this.worktreeEnv(phase);

    for (let attempt = 0; attempt <= this.opts.maxVerifyAttempts; attempt++) {
      if (this.stopped) return { ok: false, output: 'stopped before verification completed' };

      this.emit('phase.verifying', { phaseId: phase.id, name: phase.name, attempt });
      let verdict: { ok: boolean; output?: string | undefined };
      try {
        verdict = await this.ctx.verifyPhase(phase, env);
      } catch (err) {
        verdict = { ok: false, output: toErrorMessage(err) };
      }
      if (verdict.ok) return { ok: true };

      this.emit('phase.verifyFailed', {
        phaseId: phase.id,
        name: phase.name,
        attempt,
        error: verdict.output,
      });

      // Out of attempts, no repair pass available, or aborted → give up.
      if (attempt >= this.opts.maxVerifyAttempts || !this.ctx.repairPhase || this.stopped) {
        return { ok: false, output: verdict.output };
      }

      this.emit('phase.repairing', { phaseId: phase.id, name: phase.name, attempt: attempt + 1 });
      try {
        await this.ctx.repairPhase(
          phase,
          verdict.output ?? 'verification failed',
          attempt + 1,
          env,
        );
      } catch {
        // A failed repair is non-fatal: the next verifyPhase run will observe the
        // still-broken tree and the loop will exit with ok:false.
      }
    }
    return { ok: false };
  }

  /** Worktree env (cwd/branch) for a phase, or undefined if it runs on the shared tree. */
  /** Bundle of orchestrator state the worktree-integration steps drive. */
  private integrationCtx(): IntegrationContext {
    return {
      graph: this.graph,
      ctx: this.ctx,
      logger: this.logger,
      worktrees: this.worktrees,
      phaseWorktrees: this.phaseWorktrees,
      phaseMergePromise: this.phaseMergePromise,
      runningPhases: this.runningPhases,
      getMergeQueue: () => this.mergeQueue,
      setMergeQueue: (queue) => {
        this.mergeQueue = queue;
      },
      emit: (event, payload) => this.emit(event, payload),
      updatePhaseStatus: (phase, status) => this.updatePhaseStatus(phase, status),
    };
  }

  private worktreeEnv(
    phase: PhaseNode,
  ): { cwd?: string | undefined; branch?: string | undefined } | undefined {
    return worktreeEnv(this.integrationCtx(), phase);
  }

  private async failPhaseAfterTasks(phase: PhaseNode, error: string): Promise<void> {
    await failPhaseAfterTasks(this.integrationCtx(), phase, error);
  }

  /** Trim long verifier output so it fits cleanly in an event/error message. */
  private truncate(text: string, max = 500): string {
    return truncate(text, max);
  }

  // ─── Worktree integration ───────────────────────────────────────────────────

  private async commitAndEnqueueMerge(phase: PhaseNode): Promise<void> {
    await commitAndEnqueueMerge(this.integrationCtx(), phase);
  }
  /** A failed phase keeps its worktree on disk for inspection (no merge). */
  private async keepWorktreeForReview(phase: PhaseNode): Promise<void> {
    await keepWorktreeForReview(this.integrationCtx(), phase);
  }

  private async executePhaseTasks(phase: PhaseNode): Promise<void> {
    const pendingTasks = this.getExecutableTasks(phase);

    while (pendingTasks.length > 0 && !this.stopped) {
      const batch = pendingTasks.splice(0, this.opts.maxConcurrentTasks);

      const results = await Promise.allSettled(
        batch.map((task) => this.executeSingleTask(task, phase)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const task = batch[i];
        if (!result || !task) continue;

        if (result.status === 'fulfilled') {
          this.markTaskCompleted(phase, task);
        } else {
          this.markTaskFailed(phase, task, result.reason);
        }
      }

      const newReady = this.getExecutableTasks(phase);
      pendingTasks.length = 0;
      pendingTasks.push(...newReady);
    }
  }

  private async executeSingleTask(task: TaskNode, phase: PhaseNode): Promise<unknown> {
    const tracker = this.getTrackerForPhase(phase);
    tracker.updateNodeStatus(task.id, 'in_progress');
    // Signal the start so boards can move the card to "in progress" and show the
    // worker. `executeTask` may assign/refine the agent right after (taskAssigned).
    this.emit('phase.taskStarted', {
      phaseId: phase.id,
      taskId: task.id,
      taskTitle: task.title,
      agentName: task.assignee,
    });
    const handle = this.phaseWorktrees.get(phase.id);
    // Per-task abort source, fired by this task's own timeout below. Composed
    // with the run-wide stopController so either stop() or the timeout
    // actually cancels the execution — previously a timed-out task kept
    // running (and kept writing to the phase worktree) after its retry had
    // already been queued.
    const timeoutController = this.opts.taskTimeoutMs > 0 ? new AbortController() : undefined;
    const signal = timeoutController
      ? AbortSignal.any([this.stopController.signal, timeoutController.signal])
      : this.stopController.signal;
    const taskPromise = this.ctx.executeTask(
      task,
      phase.id,
      { cwd: handle?.dir, branch: handle?.branch },
      signal,
    );
    if (!timeoutController) return taskPromise;

    const timeoutMs = this.opts.taskTimeoutMs;
    const timedOut = Symbol('timed_out');
    const result = await Promise.race([
      taskPromise,
      new Promise<typeof timedOut>((resolve) => {
        const timer = setTimeout(() => {
          timeoutController.abort();
          resolve(timedOut);
        }, timeoutMs);
        // Let the timer be freed if the task finishes first.
        taskPromise.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
      }),
    ]);
    if (result !== timedOut) return result;

    this.emit('phase.taskTimedOut', {
      phaseId: phase.id,
      taskId: task.id,
      taskTitle: task.title,
      timeoutMs,
    });
    // Wait (bounded) for the aborted execution to settle before throwing:
    // the throw requeues this task via markTaskFailed, and starting the retry
    // while the timed-out instance is still writing to the same worktree is
    // exactly the duplicate-concurrent-instance race. Signal-honoring
    // implementors settle in milliseconds; the bound keeps an implementor
    // that ignores the signal from hanging the phase forever.
    const settled = taskPromise.then(
      () => undefined,
      () => undefined,
    );
    // Clear the grace timer when the task settles first, and unref it so a
    // pending timer cannot hold the event loop open during shutdown.
    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
      void settled.then(() => clearTimeout(timer));
    });
    await Promise.race([settled, grace]);
    throw new Error(`Task "${task.title}" (${task.id}) exceeded timeout of ${timeoutMs} ms`);
  }

  private markTaskCompleted(phase: PhaseNode, task: TaskNode): void {
    const tracker = this.getTrackerForPhase(phase);
    tracker.updateNodeStatus(task.id, 'completed');
    this.emit('phase.taskCompleted', {
      phaseId: phase.id,
      taskId: task.id,
      taskTitle: task.title,
    });
  }

  private markTaskFailed(phase: PhaseNode, task: TaskNode, error: unknown): void {
    const tracker = this.getTrackerForPhase(phase);
    const taskKey = `${phase.id}:${task.id}`;
    const currentRetries = this.taskRetryCounts.get(taskKey) ?? 0;

    if (this.stopped) {
      // A stop()-initiated abort is a user action, not a task failure: leave
      // the node resumable-pending without burning a retry attempt.
      tracker.updateNodeStatus(task.id, 'pending', 'Stopped before completion');
      return;
    }

    if (currentRetries < this.opts.maxRetries) {
      this.taskRetryCounts.set(taskKey, currentRetries + 1);
      tracker.updateNodeStatus(
        task.id,
        'pending',
        `Retry ${currentRetries + 1}/${this.opts.maxRetries}`,
      );
      this.emit('phase.taskRetrying', {
        phaseId: phase.id,
        taskId: task.id,
        taskTitle: task.title,
        attempt: currentRetries + 1,
        maxRetries: this.opts.maxRetries,
      });
    } else {
      tracker.updateNodeStatus(
        task.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      this.emit('phase.taskFailed', {
        phaseId: phase.id,
        taskId: task.id,
        taskTitle: task.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getReadyPhases(): PhaseNode[] {
    return getReadyPhases(this.graph);
  }

  private getActivePhases(): PhaseNode[] {
    return getActivePhases(this.graph);
  }

  private getExecutableTasks(phase: PhaseNode): TaskNode[] {
    return getExecutableTasks((p) => this.getTrackerForPhase(p), phase);
  }

  private getTrackerForPhase(phase: PhaseNode): TaskTracker {
    const cached = this.trackerCache.get(phase.id);
    if (cached) return cached;

    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    tracker.setGraph(phase.taskGraph);
    this.trackerCache.set(phase.id, tracker);
    return tracker;
  }

  private getFailedTaskCount(phase: PhaseNode): number {
    return getFailedTaskCount((p) => this.getTrackerForPhase(p), phase);
  }

  private getCompletedTaskCount(phase: PhaseNode): number {
    return getCompletedTaskCount((p) => this.getTrackerForPhase(p), phase);
  }

  private updatePhaseStatus(phase: PhaseNode, status: PhaseStatus): void {
    const from = phase.status;
    phase.status = status;
    phase.updatedAt = Date.now();
    this.graph.updatedAt = Date.now();
    this.emit('phase.statusChange', { phaseId: phase.id, from, to: status });
  }

  private isComplete(): boolean {
    return isGraphComplete(this.graph);
  }

  private onGraphComplete(): void {
    this.graph.completedAt = Date.now();
    const durationMs = this.graph.completedAt - (this.graph.startedAt ?? this.graph.completedAt);
    this.emit('graph.completed', { graphId: this.graph.id, durationMs });
    this.stop();
  }

  private onGraphFailed(failedPhase: PhaseNode): void {
    this.emit('graph.failed', {
      graphId: this.graph.id,
      failedPhaseId: failedPhase.id,
      error: `Phase "${failedPhase.name}" failed`,
    });
    this.stop();
  }

  // ─── Progress ─────────────────────────────────────────────────────────────

  getProgress(): PhaseProgress {
    return getProgress(this.graph, (p) => this.getTrackerForPhase(p));
  }

  getGraph(): PhaseGraph {
    return this.graph;
  }

  isRunning(): boolean {
    return !this.stopped && this.runningPhases.size > 0;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ─── Agent Assignment ─────────────────────────────────────────────────────

  assignAgent(phaseId: string, agentId: string): void {
    const phase = this.graph.phases.get(phaseId);
    if (!phase) return;
    if (!phase.assignedAgents.includes(agentId)) {
      phase.assignedAgents.push(agentId);
      this.emit('agent.assigned', { phaseId, agentId });
    }
  }

  releaseAgent(phaseId: string, agentId: string): void {
    const phase = this.graph.phases.get(phaseId);
    if (!phase) return;
    phase.assignedAgents = phase.assignedAgents.filter((id) => id !== agentId);
    this.emit('agent.released', { phaseId, agentId });
  }

  // ─── Interactive board mutations ──────────────────────────────────────────
  //
  // These are driven by an interactive board (WebUI/TUI), not the autonomous
  // loop. Each mutates the live graph, emits a typed event so every surface
  // stays in sync, and bumps updatedAt so the host re-persists.

  /** Find the phase whose task graph currently holds `taskId`. */
  findPhaseOfTask(taskId: string): PhaseNode | undefined {
    return findPhaseOfTaskInGraph(this.graph, taskId);
  }

  /**
   * Move a task to another phase's task graph. Edges that referenced the task
   * are dropped (cross-phase dependencies are not modeled). No-op when the task
   * or target phase is missing, or it is already in the target phase.
   */
  moveTask(taskId: string, toPhaseId: string): boolean {
    return movePhaseTask(this.boardMutationContext(), taskId, toPhaseId);
  }

  /** (Re)assign a task to a specific agent (or clear with agentName/agentId omitted). */
  setTaskAssignee(taskId: string, agentId?: string, agentName?: string): boolean {
    return setPhaseTaskAssignee(this.boardMutationContext(), taskId, agentId, agentName);
  }

  /** Add a new task to a phase. Returns the created task id, or null if the phase is missing. */
  addTask(
    phaseId: string,
    spec: {
      title: string;
      description?: string | undefined;
      type?: TaskNode['type'] | undefined;
      priority?: TaskNode['priority'] | undefined;
    },
  ): string | null {
    return addPhaseTask(this.boardMutationContext(), phaseId, spec);
  }

  /**
   * Requeue a task to `pending` (clearing its retry counter) and nudge a
   * terminal/paused phase back to `ready` so the loop re-runs it. Backs both the
   * board's "retry" and "start" affordances.
   */
  requeueTask(taskId: string): boolean {
    return requeuePhaseTask(this.boardMutationContext(), taskId);
  }

  private boardMutationContext() {
    return {
      graph: this.graph,
      trackerCache: this.trackerCache,
      taskRetryCounts: this.taskRetryCounts,
      phaseWorktrees: this.phaseWorktrees,
      getTrackerForPhase: (phase: PhaseNode) => this.getTrackerForPhase(phase),
      updatePhaseStatus: (phase: PhaseNode, status: PhaseStatus) =>
        this.updatePhaseStatus(phase, status),
      emit: (event: string, payload: unknown) =>
        this.emit(event as PhaseEventName, payload as PhaseEventMap[PhaseEventName]),
    };
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  private emit<K extends PhaseEventName>(event: K, payload: PhaseEventMap[K]): void {
    (this.events.emit as (event: string, payload: unknown) => void)(event, payload);
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.stopped) {
      await this.delay(100);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
