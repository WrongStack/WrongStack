import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { requireSessionId } from '@wrongstack/primitives';
import type { AgentBridge, BridgeMessage } from '../types/agent-bridge.js';
import type {
  AwaitAnyResult,
  CoordinatorStatus,
  MultiAgentConfig,
  MultiAgentCoordinator,
  SpawnResult,
  SubagentConfig,
  SubagentContext,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import { classifySubagentError } from './coordinator/error-classifier.js';
import {
  handleRecordCompletionState,
  isCoordinatorDone,
  pushAndTrimCompletedResult,
} from './multi-agent-completion-helpers.js';
import { executeRemoveSubagent, executeStopSession } from './multi-agent-lifecycle-helpers.js';
import { applyRosterBudget } from './fleet.js';
import {
  createPendingAbortedResult,
  hasLiveSubagentInMap,
  type SubagentEntry,
  takeNextDispatchableTaskFromQueue,
} from './multi-agent-queue-helpers.js';
import { createSubagentTaskBudget, executeSubagentTask } from './multi-agent-runner-helpers.js';
import {
  buildCoordinatorStatus,
  computeCoordinatorStats,
  emitCoordinatorStatsEvent,
} from './multi-agent-stats-helpers.js';
import { awaitCoordinatorTasks, awaitCoordinatorTasksAny } from './multi-agent-waiters.js';
import type { BudgetSessionIdSource } from './subagent-budget.js';
import { resolveGracefulFinish } from './subagent-finish.js';
import { applyCoordinatorNickname } from './subagent-nicknames.js';

export interface MultiAgentCoordinatorOptions {
  /**
   * Callback that executes a task on behalf of a subagent. Required for
   * `assign()` to actually run anything — without it, tasks queue forever.
   * The coordinator provides per-subagent isolation (own budget, own signal,
   * own bridge) and enforces timeout + concurrency.
   */
  runner?: SubagentRunner | undefined;
  /**
   * Session id for EventBus/FleetBus emissions produced by this coordinator.
   * Accepts a getter so a long-lived coordinator follows session resume/new.
   */
  sessionId?: BudgetSessionIdSource | undefined;
}

/**
 * Listener ceiling for the coordinator's own event surface. High enough that
 * no legitimate `awaitTasks()` fan-out reaches it, low enough that a waiter
 * which stops removing itself still trips Node's warning.
 */
const MAX_COORDINATOR_LISTENERS = 512;

export class DefaultMultiAgentCoordinator extends EventEmitter implements MultiAgentCoordinator {
  readonly coordinatorId: string;
  readonly config: MultiAgentConfig;
  private runner?: SubagentRunner | undefined;
  private readonly sessionId: BudgetSessionIdSource | undefined;
  private fleetBus?: import('./fleet-bus.js').FleetBus | undefined;

  private readonly subagents = new Map<string, SubagentEntry>();

  /**
   * Base nickname keys already handed out this run (e.g. `einstein`, `tesla`).
   * Prevents two workers sharing a name. Direct `coordinator.spawn()` callers
   * (parallel/eternal engine, SDD parallel run) don't go through
   * `Director.spawn()` where nicknames are normally assigned, so the
   * coordinator upgrades placeholder names ("Executor", "slot-ab12cd", role
   * names) to memorable ones here — that's what surfaces in the fleet monitor.
   */
  private readonly usedNicknames = new Set<string>();
  /** Maps subagentId → nickname key (e.g. 'einstein'). Used to free the slot on remove(). */
  private readonly subagentNicknames = new Map<string, string>();

  private pendingTasks: TaskSpec[] = [];
  private completedResults: TaskResult[] = [];
  private readonly completedResultsById = new Map<string, TaskResult>();
  /** Prevents completedResults from growing unbounded in long-running coordinators. */
  private static readonly MAX_COMPLETED_RESULTS = 200_000;
  /** Caps each subagent's retained task history (see assign()); bounds RAM + the recordCompletion lookup. */
  private static readonly MAX_SUBAGENT_TASK_HISTORY = 64;
  private totalIterations = 0;
  private inFlight = 0;
  /**
   * Subagents currently being stopped. Set on entry to `stop()`, cleared
   * once `recordCompletion` lands the terminal TaskResult. Used by
   * `runDispatched` and `findIdleSubagent` to refuse mid-flight dispatch
   * to a subagent the caller has already asked to terminate — closes the
   * assign+terminate race where a fresh task could land on a worker that
   * was about to be killed.
   */
  private readonly terminating = new Set<string>();

  constructor(config: MultiAgentConfig, options: MultiAgentCoordinatorOptions = {}) {
    super();
    // awaitTasks() registers one short-lived 'task.completed' listener per
    // awaited id; a single call awaiting >10 ids (or several concurrent
    // callers) crosses Node's default 10-listener cap and prints a spurious
    // MaxListenersExceededWarning. These waiters are bounded and
    // self-removing, so the default is too low.
    //
    // Raised, NOT lifted. `setMaxListeners(0)` means unlimited, which silences
    // the warning for a real leak too — a waiter that stopped unwinding would
    // accumulate forever with nothing to notice. This ceiling sits far above
    // any legitimate fan-out (fleet concurrency times awaited ids) while still
    // failing loudly if one ever does.
    this.setMaxListeners(MAX_COORDINATOR_LISTENERS);
    this.coordinatorId = config.coordinatorId;
    this.config = config;
    this.runner = options.runner;
    this.sessionId = options.sessionId;
  }

  private currentSessionId(): string {
    const value = typeof this.sessionId === 'function' ? this.sessionId() : this.sessionId;
    return requireSessionId(value, 'subagent operation');
  }

  /**
   * The session that owns a subagent — its spawn-time stamp.
   *
   * Every per-subagent emission routes through here instead of
   * `currentSessionId()`. The fallback covers ids the coordinator never
   * spawned (a caller reporting `completeTask` for an unknown worker); a
   * subagent this coordinator created always has its own stamp.
   */
  sessionOf(subagentId: string): string {
    const entry = this.subagents.get(subagentId);
    if (entry) return entry.sessionId;
    return this.currentSessionId();
  }

  /** Every subagent this coordinator holds for one session. */
  subagentIdsForSession(sessionId: string): string[] {
    if (!sessionId) return [];
    const ids: string[] = [];
    for (const [id, entry] of this.subagents) {
      if (entry.sessionId === sessionId) ids.push(id);
    }
    return ids;
  }

  /**
   * Stop every subagent belonging to ONE session, and drop that session's
   * still-queued tasks.
   *
   * This is what a tab's Stop button needs. `stopAll()` is the wrong tool with
   * four tabs live — it would kill three other tabs' work — and until subagents
   * carried a session stamp there was no way to express the narrower intent, so
   * stopping a run left its workers grinding on in the background.
   *
   * Pending tasks pinned to those subagents are drained as aborted so anything
   * awaiting them (the delegate tool, report-back) resolves instead of hanging.
   */
  async stopSession(sessionId: string): Promise<void> {
    return executeStopSession({
      sessionId,
      subagents: this.subagents,
      pendingTasks: this.pendingTasks,
      emitPendingAborted: (task, message) => this.emitPendingAborted(task, message),
      stopSubagent: (id) => this.stop(id),
    });
  }

  /**
   * Replace the runner after construction. Used when the runner depends
   * on infrastructure (e.g. FleetBus) that isn't available until after
   * the coordinator's owning Director is built.
   */
  setRunner(runner: SubagentRunner): void {
    this.runner = runner;
  }

  /**
   * Wire a FleetBus for director-mode event emission. Call after the
   * FleetManager is constructed so the coordinator can emit lifecycle
   * events the TUI and monitoring tools subscribe to.
   */
  setFleetBus(fleet: import('./fleet-bus.js').FleetBus): void {
    this.fleetBus = fleet;
  }

  /**
   * Change the in-flight dispatch ceiling at runtime. Lowering does NOT
   * preempt running tasks — already-dispatched subagents finish their
   * current task; only future dispatches respect the new cap. Raising
   * immediately tries to fill the freed slots from the pending queue.
   */
  setMaxConcurrent(n: number): void {
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`maxConcurrent must be a finite integer >= 1, got ${n}`);
    }
    this.config.maxConcurrent = Math.floor(n);
    this.tryDispatchNext();
  }

  /**
   * Upgrade a placeholder/role-derived name to a memorable scientist nickname
   * (e.g. "Einstein (Executor)"). A name is treated as a placeholder when it is
   * empty, equals the role (case-insensitive), is a generic default
   * ("subagent"/"adhoc"/"generic"), or is an auto-generated `slot-…` id.
   * Explicit, human-chosen names — including nicknames already assigned by
   * `Director.spawn()` — are left untouched, so this never double-assigns.
   */
  private withNickname(subagent: SubagentConfig, subagentId: string): SubagentConfig {
    return applyCoordinatorNickname(
      subagent,
      subagentId,
      this.usedNicknames,
      this.subagentNicknames,
    );
  }

  async spawn(subagent: SubagentConfig): Promise<SpawnResult> {
    const id = subagent.id || randomUUID();
    const cfg = this.withNickname(subagent, id);
    // Duplicate-id guard. Previously a second spawn({id}) with the
    // same id silently overwrote the existing entry — orphaning the
    // first subagent's AbortController, Context, and any in-flight
    // task referencing it. Two spawns with the same id are almost
    // always a bug at the caller; refuse and let them surface it.
    if (this.subagents.has(id)) {
      throw new Error(`Subagent id "${id}" already exists — refusing to overwrite`);
    }
    const context: SubagentContext = {
      subagentId: id,
      tasks: [],
      // Wired later by the caller via setSubagentBridge() once the
      // bidirectional bridge is created. Readers must null-check / use
      // hasParentBridge() — the type now reflects this.
      parentBridge: null,
      doneCondition: this.config.doneCondition,
      maxConcurrent: this.config.maxConcurrent ?? 16,
    };

    // Capture the owning session ONCE, here, and keep it. From this line on
    // the worker belongs to that session no matter which tab is in front
    // later. `originSessionId` is the caller's answer — the run-pinned session
    // of whoever asked for the spawn — and it is the only correct one when
    // several conversations share this coordinator: the host's own reading
    // names the process's boot session, not the tab that delegated. Hosts
    // spawning for themselves pass nothing and keep the live reading.
    const sessionId = cfg.originSessionId ?? this.currentSessionId();

    this.subagents.set(id, {
      config: { ...cfg, id },
      context,
      status: 'idle',
      abortController: new AbortController(),
      sessionId,
    });

    this.emit('subagent.started', {
      subagent: { ...cfg, id },
      sessionId,
    });

    this.fleetBus?.emit({
      subagentId: id,
      ts: Date.now(),
      type: 'subagent.assigned',
      payload: {
        sessionId,
        subagentId: id,
        name: subagent.name,
        provider: subagent.provider,
        model: subagent.model,
      },
    });

    this.emitCoordinatorStats();

    return { subagentId: id, agentId: id };
  }

  async assign(task: TaskSpec): Promise<void> {
    this.pendingTasks.push(task);
    this.tryDispatchNext();
  }

  async delegate(to: string, msg: BridgeMessage): Promise<void> {
    const subagent = this.subagents.get(to);
    if (!subagent) throw new Error(`Subagent "${to}" not found`);
    if (!subagent.context.parentBridge) {
      throw new Error(`Subagent "${to}" has no parentBridge — call setSubagentBridge() first`);
    }
    await subagent.context.parentBridge.send(msg);
  }

  /**
   * Wire up the communication bridge for a subagent. Call after spawn() once
   * the caller has created the bidirectional connection.
   */
  setSubagentBridge(subagentId: string, bridge: AgentBridge): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) throw new Error(`Subagent "${subagentId}" not found`);
    subagent.context.parentBridge = bridge;
  }

  async stop(subagentId: string): Promise<void> {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;

    // Mark terminating BEFORE the abort so a synchronous tryDispatchNext
    // observation in another callback path sees the intent and skips
    // this subagent. Cleared by recordCompletion once the runner's
    // catch block lands the terminal TaskResult.
    this.terminating.add(subagentId);

    // Abort any in-flight run, then sever the bridge so further messages fail
    // fast instead of silently queueing on a dead subagent.
    subagent.abortController.abort();
    subagent.status = 'stopped';
    subagent.currentTask = undefined;
    subagent.context.parentBridge = null;

    this.emit('subagent.stopped', { subagentId, reason: 'stopped by coordinator' });

    const sessionId = subagent.sessionId;
    this.fleetBus?.emit({
      subagentId,
      ts: Date.now(),
      type: 'subagent.stopped',
      payload: {
        sessionId,
        subagentId,
        reason: 'stopped by coordinator',
      },
    });

    this.emitCoordinatorStats();
  }

  async stopAll(): Promise<void> {
    // Clear the queue FIRST so no new tasks land on subagents while
    // we're tearing them down. Each dropped task gets a synthetic
    // `aborted_by_parent` completion so any caller awaiting it (e.g.
    // delegate tool's awaitTasks) resolves instead of hanging.
    //
    // Pending tasks never reached `inFlight`, so we cannot route them
    // through `recordCompletion` — its underflow guard would short-
    // circuit on the second pending task and emit a warning instead
    // of the completion event. The shared helper inline-emits.
    this.drainPendingAsAborted('Coordinator stopAll() drained the pending queue');
    // allSettled so one failure doesn't leave other subagents un-stopped.
    await Promise.allSettled([...this.subagents.keys()].map((id) => this.stop(id)));
  }

  /**
   * Get current coordinator stats for monitoring/debugging.
   */
  getStats(): {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
  } {
    return computeCoordinatorStats(
      this.subagents,
      this.inFlight,
      this.pendingTasks.length,
      this.completedResults.length,
    );
  }

  /** Emit a reactive coordinator.stats event on FleetBus so the TUI can subscribe. */
  private emitCoordinatorStats(): void {
    emitCoordinatorStatsEvent({
      fleetBus: this.fleetBus,
      coordinatorId: this.coordinatorId,
      subagents: this.subagents,
      inFlight: this.inFlight,
      pendingCount: this.pendingTasks.length,
      completedCount: this.completedResults.length,
      currentSessionId: () => this.currentSessionId(),
    });
  }

  getStatus(): CoordinatorStatus {
    return buildCoordinatorStatus({
      coordinatorId: this.coordinatorId,
      subagents: this.subagents,
      pendingCount: this.pendingTasks.length,
      completedCount: this.completedResults.length,
      totalIterations: this.totalIterations,
      isDone: this.isDone(),
    });
  }

  /** Expose snapshot of completed results — useful for callers awaiting all done. */
  results(): readonly TaskResult[] {
    return this.completedResults;
  }

  /** Defensive snapshot of the still-queued (not yet dispatched) tasks. */
  listPendingTasks(): readonly TaskSpec[] {
    return this.pendingTasks.map((t) => ({ ...t }));
  }

  /**
   * Re-pin a still-PENDING task to a different subagent (`undefined` =
   * unpin, any idle worker may take it), then try to dispatch. Returns
   * `false` when the task is not in the pending queue — already
   * dispatched, completed, or unknown. Running tasks can never be pulled;
   * they can only be steered or terminated. The mutation is synchronous
   * (same tick as the check), so it cannot race a concurrent dispatch:
   * `tryDispatchNext` runs on this same call stack or a later one.
   *
   * The task keeps its id, so waiters, the report-back notifier, and
   * checkpoint bookkeeping resolve unchanged when it eventually completes.
   */
  retargetPendingTask(taskId: string, subagentId: string | undefined): boolean {
    const task = this.pendingTasks.find((t) => t.id === taskId);
    if (!task) return false;
    if (subagentId !== undefined && !this.subagents.has(subagentId)) return false;
    task.subagentId = subagentId;
    this.tryDispatchNext();
    return true;
  }

  /**
   * Wait for one or more tasks to complete and return their results.
   * If a task is already done when called, returns immediately.
   * Resolves to an array in the same order as `taskIds`.
   */
  async awaitTasks(taskIds: string[], opts?: { timeoutMs?: number }): Promise<TaskResult[]> {
    return awaitCoordinatorTasks({
      emitter: this,
      taskIds,
      completedResultsById: this.completedResultsById,
      defaultTimeoutMs: this.config.timeoutMs,
      opts,
    });
  }

  /**
   * Wait until AT LEAST ONE of the named tasks completes. Returns every
   * requested result already available at that moment (drain-what's-done)
   * plus the ids still outstanding, so callers can loop "handle finishers,
   * re-await the remainder" instead of blocking on the whole batch.
   *
   * Unlike `awaitTasks`, this never rejects and deliberately does NOT
   * inherit `config.timeoutMs` — a "return whatever is done" call has no
   * business timing out unless the caller asks for a window explicitly.
   */
  async awaitTasksAny(taskIds: string[], opts?: { timeoutMs?: number }): Promise<AwaitAnyResult> {
    return awaitCoordinatorTasksAny({
      emitter: this,
      taskIds,
      completedResultsById: this.completedResultsById,
      opts,
    });
  }

  /**
   * Manual completion — for callers that drive subagents without a runner
   * (e.g. external orchestrators). When a runner is configured the coordinator
   * calls this itself.
   */
  completeTask(result: TaskResult): void {
    this.recordCompletion(result);
  }

  /**
   * Ask every RUNNING subagent that opted into `gracefulFinish` to finish its
   * task in its own turn (see coordination/subagent-finish.ts). This is the
   * leader-side entry point for "the leader agent has finished": it delivers
   * an in-band notification between tool batches — never an interrupt, never
   * an abort. Each notified subagent keeps its existing time budget and
   * accelerates; the watchdog still bounds the maximum lifetime.
   *
   * Subagents without the policy opted in are deliberately untouched — their
   * lifecycle remains the legacy watchdog contract.
   *
   * Returns the number of subagents actually notified.
   */
  requestFinish(reason: string): number {
    let notified = 0;
    for (const subagent of this.subagents.values()) {
      if (subagent.status !== 'running') continue;
      if (!resolveGracefulFinish(subagent.config)) continue;
      const budget = subagent.activeBudget;
      if (!budget) continue;
      // "Wrap up," never "skip your work": only subagents that have actually
      // started (an iteration or tool call on record) are asked to accelerate.
      // A just-spawned subagent — typically a post-session reviewer whose
      // runner has only just wired its bus — would otherwise read the finish
      // notice at its FIRST iteration, before it has examined anything, and a
      // compliant model would emit a truncated report. Subagents that have
      // not started yet stay on their normal lifecycle; the watchdog
      // deadline crossing delivers the in-band notice with a grace window,
      // which is the mandatory path for stalled runs.
      const usage = budget.usage();
      if (usage.iterations === 0 && usage.toolCalls === 0) continue;
      // Notify only — no grace grant. A subagent still well inside its
      // wall-clock budget keeps its full legitimate working time; one already
      // past its deadline has (or will) get grace from the watchdog.
      if (budget.notifyFinish(reason)) notified++;
    }
    return notified;
  }

  // --- internal dispatching ---------------------------------------------

  private tryDispatchNext(): void {
    while (this.canDispatch()) {
      const dispatchable = this.takeNextDispatchableTask();
      if (!dispatchable) {
        // No idle worker right now. If every spawned subagent is
        // stopped or mid-termination, the pending queue is dead —
        // a pending task can never start, so synthetic-complete it
        // as `aborted_by_parent`. Without this, an `assign()` after
        // `stop()` would hang forever waiting for `task.completed`.
        // We DO NOT drain when subagents are busy (status='running'):
        // those will free up and accept the work normally.
        if (this.pendingTasks.length > 0 && !this.hasLiveSubagent()) {
          this.drainPendingAsAborted('No live subagent available — all stopped or mid-termination');
        }
        return;
      }
      const { subagentId, task } = dispatchable;
      // Attach a catch so a synchronous throw inside runDispatched (rare —
      // e.g. provider misconfiguration before the first await) becomes a
      // visible failed task instead of an unhandled rejection that leaves
      // `inFlight` permanently elevated.
      this.runDispatched(subagentId, task).catch((err) => {
        this.recordCompletion({
          subagentId,
          taskId: task.id,
          status: 'failed',
          error: classifySubagentError(err),
          iterations: 0,
          toolCalls: 0,
          durationMs: 0,
        });
      });
    }
  }

  private canDispatch(): boolean {
    return this.inFlight < (this.config.maxConcurrent ?? 16) && this.pendingTasks.length > 0;
  }

  private takeNextDispatchableTask(): { subagentId: string; task: TaskSpec } | null {
    return takeNextDispatchableTaskFromQueue(this.pendingTasks, this.subagents, this.terminating);
  }

  /**
   * Returns true iff at least one spawned subagent could still
   * process a task. A "live" subagent is one that is not stopped
   * AND not mid-termination — `running` workers count because they
   * will eventually finish and become idle.
   */
  private hasLiveSubagent(): boolean {
    return hasLiveSubagentInMap(this.subagents, this.terminating);
  }

  /**
   * Drain every pending task with a synthetic `aborted_by_parent`
   * completion event.
   */
  private drainPendingAsAborted(message: string): void {
    const dropped = this.pendingTasks.splice(0, this.pendingTasks.length);
    for (const t of dropped) this.emitPendingAborted(t, message);
  }

  /**
   * Emit a synthetic `stopped`/`aborted_by_parent` completion for a single
   * PENDING task — one that was never counted in `inFlight`.
   */
  private emitPendingAborted(task: TaskSpec, message: string): void {
    const synthetic = createPendingAbortedResult(task, message);
    this.pushCompletedResult(synthetic);
    this.emit('task.completed', { task, result: synthetic });
  }

  private pushCompletedResult(result: TaskResult): void {
    pushAndTrimCompletedResult(
      this.completedResults,
      this.completedResultsById,
      result,
      DefaultMultiAgentCoordinator.MAX_COMPLETED_RESULTS,
    );
  }

  private async runDispatched(subagentId: string, task: TaskSpec): Promise<void> {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;
    // Final race guard: if `stop(subagentId)` ran between dispatch
    // and us arriving here, refuse to start the task and surface it
    // as `aborted_by_parent` so any caller awaiting the task id
    // unblocks. Without this, the task would be marked 'running',
    // collide with the just-completed 'stopped' state, and leak
    // inFlight by 1 because no recordCompletion path covers it.
    if (this.terminating.has(subagentId) || subagent.status === 'stopped') {
      this.recordCompletion({
        subagentId,
        taskId: task.id,
        status: 'stopped',
        error: {
          kind: 'aborted_by_parent',
          message: 'Subagent was terminated before task could start',
          retryable: false,
        },
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
      });
      return;
    }

    subagent.status = 'running';
    subagent.currentTask = task.id;
    task.subagentId = subagentId;
    // Carry the owning session on the task itself. Agent factories receive
    // `(config, task)` and nothing else, so without this the only session they
    // could read was the HOST's live one — which moves every time the user
    // switches tabs, filing a worker's transcript and token spend under
    // whichever tab happened to be in front when it spawned. An explicit
    // stamp on the task already wins; this only fills the gap.
    if (subagent.sessionId) {
      task.context = { sessionId: subagent.sessionId, ...(task.context ?? {}) };
    }
    subagent.context.tasks.push(task);
    // Bound the per-subagent task history: a worker runs one task at a time, so
    // the completing task is always among the most recent entries. This keeps a
    // long-lived worker (idle→assign→complete→…) from accumulating every task it
    // ever ran, and keeps the `.find` at recordCompletion O(cap) instead of O(N).
    if (subagent.context.tasks.length > DefaultMultiAgentCoordinator.MAX_SUBAGENT_TASK_HISTORY) {
      subagent.context.tasks.splice(
        0,
        subagent.context.tasks.length - DefaultMultiAgentCoordinator.MAX_SUBAGENT_TASK_HISTORY,
      );
    }

    const sessionId = subagent.sessionId;
    this.fleetBus?.emit({
      subagentId,
      taskId: task.id,
      ts: Date.now(),
      type: 'subagent.running',
      payload: {
        sessionId,
        subagentId,
        taskId: task.id,
      },
    });

    this.emit('task.assigned', { task, subagentId });
    this.emitCoordinatorStats();

    const budget = createSubagentTaskBudget({
      subagentConfig: subagent.config,
      defaultBudget: this.config.defaultBudget,
      subagentId,
      sessionOf: (id) => this.sessionOf(id),
      applyRosterBudget,
    });
    subagent.activeBudget = budget;

    if (!this.runner) {
      // No runner wired — caller drives execution via completeTask(). Status
      // reverts when the caller reports. We intentionally don't bump
      // `inFlight` here: `completeTask` → `recordCompletion` would then
      // decrement an inFlight that runDispatched never incremented, masking
      // the "no runner" state. With this guard, `isDone()`'s all_tasks_done
      // check still settles correctly once the caller reports.
      return;
    }

    // Only count inFlight when we actually own the execution lifecycle.
    this.inFlight++;

    const result = await executeSubagentTask({
      runner: this.runner,
      task,
      subagentId,
      config: subagent.config,
      budget,
      abortController: subagent.abortController,
      sessionId: subagent.sessionId,
      parentBridge: subagent.context.parentBridge || null,
      abortSubagent: (id) => this.subagents.get(id)?.abortController.abort(),
      sessionOf: (id) => this.sessionOf(id),
    });

    this.recordCompletion(result);
  }

  private recordCompletion(result: TaskResult): void {
    this.pushCompletedResult(result);
    this.totalIterations += result.iterations;

    const outcome = handleRecordCompletionState({
      result,
      subagents: this.subagents,
      terminating: this.terminating,
      inFlight: this.inFlight,
      runner: this.runner,
      fleetBus: this.fleetBus,
      sessionOf: (id) => this.sessionOf(id),
      emitWarning: (warning) => this.emit('warning', warning),
    });

    this.inFlight = outcome.nextInFlight;
    if (outcome.underflow) return;

    this.emit('task.completed', {
      task: outcome.taskObj,
      result,
    });

    this.tryDispatchNext();

    // Emit after tryDispatchNext so the stats reflect the post-dispatch
    // state (either a new running subagent, or idle if the queue is drained).
    this.emitCoordinatorStats();

    if (this.isDone()) {
      this.emit('done', {
        results: this.completedResults,
        totalIterations: this.totalIterations,
      });
    }
  }

  /**
   * Stop a subagent and remove it from the coordinator. Releases all
   * associated resources (AbortController, context, budget state).
   * The subagent entry is deleted so the id can be reused in a future spawn.
   */
  async remove(subagentId: string): Promise<void> {
    executeRemoveSubagent({
      subagentId,
      subagents: this.subagents,
      terminating: this.terminating,
      usedNicknames: this.usedNicknames,
      subagentNicknames: this.subagentNicknames,
      pendingTasks: this.pendingTasks,
      fleetBus: this.fleetBus,
      emitCoordinatorStats: () => this.emitCoordinatorStats(),
      emitPendingAborted: (task, message) => this.emitPendingAborted(task, message),
    });
  }

  private isDone(): boolean {
    return isCoordinatorDone(
      this.config.doneCondition,
      this.pendingTasks.length,
      this.inFlight,
      this.totalIterations,
    );
  }
}

/**
 * Map any raw exception thrown out of a subagent's runner into a
 * structured `SubagentError`. Delegates to the shared classifier.
 * Re-exported for backward compatibility.
 */
export { classifySubagentError } from './coordinator/error-classifier.js';
