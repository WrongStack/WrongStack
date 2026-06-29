import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentBridge, BridgeMessage } from '../types/agent-bridge.js';
import type {
  CoordinatorStatus,
  MultiAgentConfig,
  MultiAgentCoordinator,
  SpawnResult,
  SubagentConfig,
  SubagentContext,
  SubagentRunContext,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import {
  type BudgetSessionIdSource,
  BudgetExceededError,
  DECISION_TIMEOUT_MS,
  SubagentBudget,
  TIMEOUT_PREEMPT_FRACTION as _preemptFraction,
} from './subagent-budget.js';
import { classifySubagentError } from './coordinator/error-classifier.js';
import { applyRosterBudget } from './fleet.js';
import { assignNickname } from './subagent-nicknames.js';

type SubagentStatus = 'running' | 'idle' | 'stopped' | 'error';

interface SubagentEntry {
  config: SubagentConfig;
  context: SubagentContext;
  status: SubagentStatus;
  currentTask?: string | undefined;
  abortController: AbortController;
  /** Lazily created on first dispatch — budget is per-task, not per-subagent. */
  activeBudget?: SubagentBudget | undefined;
}

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
  /** Prevents completedResults from growing unbounded in long-running coordinators. */
  private static readonly MAX_COMPLETED_RESULTS = 10_000;
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
    // MaxListenersExceededWarning that also masks genuine leaks. These waiters
    // are bounded and self-removing, so lift the cap.
    this.setMaxListeners(0);
    this.coordinatorId = config.coordinatorId;
    this.config = config;
    this.runner = options.runner;
    this.sessionId = options.sessionId;
  }

  private currentSessionId(): string | undefined {
    const value = typeof this.sessionId === 'function' ? this.sessionId() : this.sessionId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
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
    const role = subagent.role ?? 'subagent';
    const name = subagent.name?.trim() ?? '';
    const isPlaceholder =
      name === '' ||
      name.toLowerCase() === role.toLowerCase() ||
      name === 'subagent' ||
      name === 'adhoc' ||
      name === 'generic' ||
      /^slot-/.test(name);
    if (!isPlaceholder) return subagent;
    const { key, display } = assignNickname(role, this.usedNicknames);
    this.usedNicknames.add(key);
    this.subagentNicknames.set(subagentId, key);
    return { ...subagent, name: display };
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

    this.subagents.set(id, {
      config: { ...cfg, id },
      context,
      status: 'idle',
      abortController: new AbortController(),
    });

    this.emit('subagent.started', { subagent: { ...cfg, id } });

    this.fleetBus?.emit({
      subagentId: id,
      ts: Date.now(),
      type: 'subagent.assigned',
      payload: {
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

    this.fleetBus?.emit({
      subagentId,
      ts: Date.now(),
      type: 'subagent.stopped',
      payload: { subagentId, reason: 'stopped by coordinator' },
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
    let running = 0;
    let idle = 0;
    let stopped = 0;
    for (const [, entry] of this.subagents) {
      if (entry.status === 'running') running++;
      else if (entry.status === 'idle') idle++;
      else stopped++;
    }
    return {
      total: this.subagents.size,
      running,
      idle,
      stopped,
      inFlight: this.inFlight,
      pending: this.pendingTasks.length,
      completed: this.completedResults.length,
    };
  }

  /** Emit a reactive coordinator.stats event on FleetBus so the TUI can subscribe. */
  private emitCoordinatorStats(): void {
    const stats = this.getStats();
    const subagentStatuses = Array.from(this.subagents.entries()).map(([id, s]) => ({
      subagentId: id,
      taskId: s.currentTask ?? '',
      status: s.status,
      assigned: s.context.parentBridge !== null,
    }));
    const sessionId = this.currentSessionId();
    this.fleetBus?.emit({
      subagentId: this.coordinatorId,
      ts: Date.now(),
      type: 'coordinator.stats',
      payload: {
        ...(sessionId ? { sessionId } : {}),
        ...stats,
        subagentStatuses,
      },
    });
  }

  getStatus(): CoordinatorStatus {
    return {
      coordinatorId: this.coordinatorId,
      subagents: Array.from(this.subagents.entries()).map(([id, s]) => ({
        id,
        name: s.config.name,
        status: s.status,
        currentTask: s.currentTask,
      })),
      pendingTasks: this.pendingTasks.length,
      completedTasks: this.completedResults.length,
      totalIterations: this.totalIterations,
      done: this.isDone(),
    };
  }

  /** Expose snapshot of completed results — useful for callers awaiting all done. */
  results(): readonly TaskResult[] {
    return this.completedResults;
  }

  /**
   * Wait for one or more tasks to complete and return their results.
   * If a task is already done when called, returns immediately.
   * Resolves to an array in the same order as `taskIds`.
   */
  async awaitTasks(taskIds: string[]): Promise<TaskResult[]> {
    return Promise.all(
      taskIds.map((id) => {
        const cached = this.completedResults.find((r) => r.taskId === id);
        if (cached) return cached;
        // Fallback: poll until the task completes (up to timeoutMs).
        // The coordinator fires 'task.completed' on every result, so
        // we use a promise-based waiter tied to that event.
        return new Promise<TaskResult>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.off('task.completed', handler);
            reject(new Error(`awaitTasks timed out waiting for task "${id}"`));
          }, this.config.timeoutMs ?? 300_000);
          const handler = ({ result }: { task: TaskSpec; result: TaskResult }) => {
            if (result.taskId === id) {
              clearTimeout(timeout);
              this.off('task.completed', handler);
              resolve(result);
            }
          };
          this.on('task.completed', handler);
        });
      }),
    );
  }

  /**
   * Manual completion — for callers that drive subagents without a runner
   * (e.g. external orchestrators). When a runner is configured the coordinator
   * calls this itself.
   */
  completeTask(result: TaskResult): void {
    this.recordCompletion(result);
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
          this.drainPendingAsAborted(
            'No live subagent available — all stopped or mid-termination',
          );
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
    const max = this.config.maxConcurrent ?? 16;
    return this.inFlight < max && this.pendingTasks.length > 0;
  }

  private takeNextDispatchableTask(): { subagentId: string; task: TaskSpec } | null {
    for (let i = 0; i < this.pendingTasks.length; i++) {
      const task = this.pendingTasks[i];
      if (!task) continue;
      const subagentId = task.subagentId
        ? this.isIdleSubagent(task.subagentId)
          ? task.subagentId
          : null
        : this.findIdleSubagent();
      if (!subagentId) continue;
      this.pendingTasks.splice(i, 1);
      return { subagentId, task };
    }
    return null;
  }

  private findIdleSubagent(): string | null {
    for (const [id, s] of this.subagents) {
      // Skip subagents that are mid-termination — `stop()` set the
      // `terminating` flag and aborted the controller, but the
      // status mutation happens synchronously after; checking both
      // is belt-and-suspenders against any race where status is
      // transiently still 'idle' while termination is in flight.
      if (s.status === 'idle' && !this.terminating.has(id)) return id;
    }
    return null;
  }

  private isIdleSubagent(id: string): boolean {
    const subagent = this.subagents.get(id);
    return !!subagent && subagent.status === 'idle' && !this.terminating.has(id);
  }

  /**
   * Returns true iff at least one spawned subagent could still
   * process a task. A "live" subagent is one that is not stopped
   * AND not mid-termination — `running` workers count because they
   * will eventually finish and become idle.
   *
   * When no subagent has ever been spawned, returns `true` so a
   * pre-spawn `assign()` simply queues (legacy behaviour). The
   * dead-end detection only fires after `stop()` has retired every
   * spawned worker.
   *
   * Used by `tryDispatchNext` to detect a dead-end pending queue.
   */
  private hasLiveSubagent(): boolean {
    if (this.subagents.size === 0) return true;
    for (const [id, s] of this.subagents) {
      if (s.status !== 'stopped' && !this.terminating.has(id)) return true;
    }
    return false;
  }

  /**
   * Drain every pending task with a synthetic `aborted_by_parent`
   * completion event. Same shape as the `stopAll()` drain — we go
   * around `recordCompletion` because pending tasks were never
   * counted in `inFlight` and routing them through would trip the
   * underflow guard on every task after the first.
   */
  private drainPendingAsAborted(message: string): void {
    const dropped = this.pendingTasks.splice(0, this.pendingTasks.length);
    for (const t of dropped) this.emitPendingAborted(t, message);
  }

  /**
   * Emit a synthetic `stopped`/`aborted_by_parent` completion for a single
   * PENDING task — one that was never counted in `inFlight`. This MUST bypass
   * `recordCompletion`: that path does `inFlight--`, which for a pending task
   * steals a decrement from a genuinely in-flight task and trips the underflow
   * guard — suppressing that real task's `task.completed` and hanging its
   * `awaitTasks()` caller. Pushes the result and fires the event directly.
   */
  private emitPendingAborted(task: TaskSpec, message: string): void {
    const synthetic: TaskResult = {
      subagentId: task.subagentId ?? 'unassigned',
      taskId: task.id,
      status: 'stopped',
      error: {
        kind: 'aborted_by_parent',
        message,
        retryable: false,
      },
      iterations: 0,
      toolCalls: 0,
      durationMs: 0,
    };
    this.completedResults.push(synthetic);
    this.emit('task.completed', { task, result: synthetic });
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
    subagent.context.tasks.push(task);

    this.fleetBus?.emit({
      subagentId,
      taskId: task.id,
      ts: Date.now(),
      type: 'subagent.running',
      payload: { subagentId, taskId: task.id },
    });

    this.emit('task.assigned', { task, subagentId });
    this.emitCoordinatorStats();

    // Budget combines coordinator defaults with per-subagent and per-task overrides.
    // Precedence: task > subagent (raw, no roster fills) > coordinator default > roster default.
    // We intentionally call applyRosterBudget LATE — only as a final fallback after
    // the coordinator's defaultBudget has had a chance to apply. This prevents
    // GENERIC_SUBAGENT_BUDGET (5000 iter) from shadowing the coordinator's explicit default.
    const rawMaxIterations = subagent.config.maxIterations;
    const rawMaxToolCalls = subagent.config.maxToolCalls;
    const rawMaxTokens = subagent.config.maxTokens;
    const rawMaxCostUsd = subagent.config.maxCostUsd;
    const rawTimeoutMs = subagent.config.timeoutMs;
    const rawIdleTimeoutMs = subagent.config.idleTimeoutMs;
    const configWithRosterDefaults = applyRosterBudget(subagent.config);
    const budget = new SubagentBudget(
      {
        maxIterations:
          rawMaxIterations ?? this.config.defaultBudget?.maxIterations ?? configWithRosterDefaults.maxIterations,
        maxToolCalls:
          rawMaxToolCalls ??
          this.config.defaultBudget?.maxToolCalls ??
          configWithRosterDefaults.maxToolCalls,
        maxTokens:
          rawMaxTokens ?? this.config.defaultBudget?.maxTokens ?? configWithRosterDefaults.maxTokens,
        maxCostUsd:
          rawMaxCostUsd ?? this.config.defaultBudget?.maxCostUsd ?? configWithRosterDefaults.maxCostUsd,
        // Wall-clock cap is opt-in (explicit config / defaultBudget only); the
        // roster no longer supplies one. Idle is the default reaper.
        timeoutMs:
          rawTimeoutMs ?? this.config.defaultBudget?.timeoutMs ?? configWithRosterDefaults.timeoutMs,
        idleTimeoutMs:
          rawIdleTimeoutMs ??
          this.config.defaultBudget?.idleTimeoutMs ??
          configWithRosterDefaults.idleTimeoutMs,
      },
      'auto',
      { sessionId: () => this.currentSessionId() },
    );
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

    const startTime = Date.now();
    const runCtx: SubagentRunContext = {
      subagentId,
      config: subagent.config,
      budget,
      signal: subagent.abortController.signal,
      bridge: subagent.context.parentBridge || null,
    };

    let result: TaskResult;

    budget.start();
    try {
      const outcome = await this.executeWithTimeout(
        this.runner,
        task,
        runCtx,
        budget,
        subagent.config.preemptFraction,
      );
      result = {
        subagentId,
        taskId: task.id,
        status: 'success',
        result: outcome.result,
        iterations: outcome.iterations,
        toolCalls: outcome.toolCalls,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      // Order matters: a timeout calls abort() to signal cooperative runners,
      // which also flips `signal.aborted=true`. Inspect the error first so we
      // surface 'timeout' rather than masking it as 'stopped'.
      const status: TaskResult['status'] =
        err instanceof BudgetExceededError && (err.kind === 'timeout' || err.kind === 'idle_timeout')
          ? 'timeout'
          : subagent.abortController.signal.aborted
            ? 'stopped'
            : 'failed';
      const usage = budget.usage();
      result = {
        subagentId,
        taskId: task.id,
        status,
        error: classifySubagentError(err, {
          parentAborted: subagent.abortController.signal.aborted,
        }),
        iterations: usage.iterations,
        toolCalls: usage.toolCalls,
        durationMs: Date.now() - startTime,
      };
    }

    this.recordCompletion(result);
  }

  private async executeWithTimeout(
    runner: SubagentRunner,
    task: TaskSpec,
    ctx: SubagentRunContext,
    budget: SubagentBudget,
    preemptFraction: number = _preemptFraction,
  ) {
    const initialTimeoutMs = budget.limits.timeoutMs;
    const idleLimitMs = budget.limits.idleTimeoutMs;
    if (initialTimeoutMs === undefined && idleLimitMs === undefined) {
      return runner(task, ctx);
    }

    // Re-armable watchdog. The default guard is IDLE-based: while the agent
    // keeps producing activity (iterations / tool calls / streamed progress),
    // `budget.idleMs()` stays below the window and we simply re-arm — an
    // actively-working subagent is never killed by the clock. Only a genuine
    // stall (no activity for `idleTimeoutMs`) reaps it. An explicit wall-clock
    // `timeoutMs` (rare, opt-in) keeps the original soft-warning behaviour: it
    // negotiates an extension via the Director's auto-extend listener and
    // re-arms rather than hard-killing a task solely for running long.
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Pre-empt arm state machine:
    //   ACTIVE  — pre-empt can fire for the current ceiling window
    //   LOCKED  — pre-empt is locked; cannot fire until ceiling changes
    enum PreemptState {
      ACTIVE = 'active',
      LOCKED = 'locked',
    }
    // The wall-clock ceiling value at the moment the state was locked.
    // Compared against the current wallLimit to detect stale locks caused by
    // external calls to budget.patchLimits().
    let preemptedCeiling: number | null = null;
    let preemptState: PreemptState = PreemptState.ACTIVE;
    // Heartbeat gate for the proactive pre-empt: the timestamp of the subagent's
    // last activity at the moment of the most recent grant. A later pre-empt is
    // only negotiated if there has been NEW activity since then — a stalled
    // agent (no progress since its last grant) gets no further extension and is
    // left to the real deadline. `-1` until the first grant so the first
    // pre-empt always fires. Activity time is derived from `budget.idleMs()`
    // (reset by tool calls / iterations / streamed progress), so it works even
    // for runners that don't increment the budget's usage counters directly.
    let lastGrantActivityTs = -1;

    const timeoutPromise = new Promise<never>((_, reject) => {
      // Terminate the subagent, classifying by whether a negotiation listener
      // is wired. A listener-observed stop (explicit deny at the deadline, or an
      // idle reap while observed) surfaces as 'stopped' — reject with a
      // non-budget error so the coordinator's catch falls to `signal.aborted →
      // 'stopped'`. With no listener it is an unattended budget breach →
      // BudgetExceededError → 'timeout'. This keeps a bare /spawn reporting
      // 'timeout' while a director/observer-driven stop reads as 'stopped'.
      const terminate = (kind: 'timeout' | 'idle_timeout', limit: number, used: number) => {
        this.subagents.get(ctx.subagentId)?.abortController.abort();
        reject(
          budget._events?.hasListenerFor('budget.threshold_reached')
            ? new Error(`subagent stopped: budget ${kind} (limit=${limit}, used=${used})`)
            : new BudgetExceededError(kind, limit, used),
        );
      };
      const armFor = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(onTick, Math.max(0, ms));
      };
      // Re-arm for whichever deadline is sooner — the idle window (counted
      // from last activity), the explicit wall-clock cap, or the PROACTIVE
      // pre-empt point (a fraction of the wall cap, see TIMEOUT_PREEMPT_FRACTION)
      // at which we negotiate an extension BEFORE the deadline is crossed. Any
      // being unset/already-asked drops out of the min, so single-limit configs
      // behave exactly as that limit alone.
      const scheduleNext = () => {
        const wallLimit = budget.limits.timeoutMs ?? initialTimeoutMs;
        const wallRemaining =
          initialTimeoutMs === undefined
            ? Number.POSITIVE_INFINITY
            : (wallLimit as number) - (Date.now() - start);
        const idleRemaining =
          idleLimitMs === undefined
            ? Number.POSITIVE_INFINITY
            : (budget.limits.idleTimeoutMs ?? idleLimitMs) - budget.idleMs();
        const preemptRemaining =
          initialTimeoutMs === undefined || preemptedCeiling === wallLimit
            ? Number.POSITIVE_INFINITY
            : (wallLimit as number) * preemptFraction - (Date.now() - start);
        // Floor at a small positive so a near-zero remainder can't busy-loop.
        armFor(Math.max(25, Math.min(wallRemaining, idleRemaining, preemptRemaining)));
      };

      // Drive a timeout extension negotiation (used by BOTH the proactive
      // pre-empt and the at-deadline path). Resolves to the coordinator's
      // verdict: `{ extend: { timeoutMs } }` to grant, or a string to decline.
      // The budget's requestDecision falls back to 'stop' on no response, so
      // this never hangs.
      // Safety net: if no listener responds to the budget.threshold_reached event
      // within DECISION_TIMEOUT_MS (60 s), default to 'stop' so the watchdog
      // never hangs. Uses the exported DECISION_TIMEOUT_MS so both paths share
      // the same value — coordinator and budget agree on the ceiling.
      const negotiateTimeout = async (
        used: number,
        limit: number,
      ): Promise<'stop' | 'continue' | 'throw' | { extend: { timeoutMs?: number | undefined } }> => {
        const handler = budget.onThreshold;
        if (!handler) return 'stop';
        const result = handler({
          kind: 'timeout',
          used,
          limit,
          requestDecision: () => {
            // No listener wired (bare /spawn, no director) → nobody can grant an
            // extension, so resolve to 'stop' immediately. Without this the emit
            // below goes unanswered and the run parks on the 60 s fallback timer
            // before stopping — the deadline must reap promptly instead. Mirrors
            // SubagentBudget._busRequestDecision so both agree on the default.
            if (!budget._events?.hasListenerFor('budget.threshold_reached')) {
              return Promise.resolve<'stop' | { extend: { timeoutMs?: number | undefined } }>('stop');
            }
            return new Promise<'stop' | { extend: { timeoutMs?: number | undefined } }>((resolveDecision) => {
              let settled = false;
              const resolve = (d: 'stop' | { extend: { timeoutMs?: number | undefined } }) => {
                if (settled) return;
                settled = true;
                resolveDecision(d);
              };
              const fallback = setTimeout(() => resolve('stop'), DECISION_TIMEOUT_MS);
              const sessionId = this.currentSessionId();
              budget._events?.emit('budget.threshold_reached', {
                ...(sessionId ? { sessionId } : {}),
                kind: 'timeout',
                used,
                limit,
                // Informational: the budget's own decision deadline. Listeners may use
                // this to display a countdown. The coordinator does NOT enforce it —
                // it is the budget's own `setTimeout(fallback)` that races against
                // the listener's `extend()`/`deny()` call to guarantee progress.
                timeoutMs: DECISION_TIMEOUT_MS,
                // deny() wins over a same-dispatch extend(): defer the grant a
                // microtask so a synchronous deny in the same emit pre-empts it
                // (a listener that both grants and denies, or two listeners
                // disagreeing, resolves as a stop). Async grants still resolve.
                extend: (extra) => {
                  clearTimeout(fallback);
                  queueMicrotask(() => resolve({ extend: extra }));
                },
                deny: () => {
                  clearTimeout(fallback);
                  resolve('stop');
                },
              });
            });
          },
        });
        return typeof result === 'string' ? result : await result;
      };

      const onTick = async () => {
        const elapsed = Date.now() - start;
        const wallLimit =
          initialTimeoutMs === undefined ? undefined : budget.limits.timeoutMs ?? initialTimeoutMs;
        const idleLimit =
          idleLimitMs === undefined ? undefined : budget.limits.idleTimeoutMs ?? idleLimitMs;
        const wallExceeded = wallLimit !== undefined && elapsed >= wallLimit;
        const idleExceeded = idleLimit !== undefined && budget.idleMs() >= idleLimit;

        // Idle stall with no wall-clock cap also due: a genuinely hung agent
        // (no activity for the whole window). Reap it directly — idle is NOT
        // negotiable; the point of the default is to free a stuck slot. We still
        // emit the threshold event first so observers (director / monitor) can
        // record the reap, but any extension a listener offers is ignored.
        if (idleExceeded && !wallExceeded) {
          const sessionId = this.currentSessionId();
          budget._events?.emit('budget.threshold_reached', {
            ...(sessionId ? { sessionId } : {}),
            kind: 'idle_timeout',
            used: budget.idleMs(),
            limit: idleLimit ?? 0,
            timeoutMs: DECISION_TIMEOUT_MS,
            extend: () => {},
            deny: () => {},
          });
          // An idle stall is a passive TIMEOUT (the agent hung), not an explicit
          // coordinator stop — surface it as 'timeout' regardless of any
          // listener. (Contrast the wall-clock deadline below, where an explicit
          // listener deny is a deliberate stop → 'stopped'.)
          this.subagents.get(ctx.subagentId)?.abortController.abort();
          reject(new BudgetExceededError('idle_timeout', idleLimit ?? 0, budget.idleMs()));
          return;
        }

        // PROACTIVE pre-empt: we've passed TIMEOUT_PREEMPT_FRACTION of the wall
        // window but NOT the deadline itself. Negotiate an extension now, while
        // the agent is still under its limit, so a progressing subagent gets its
        // ceiling raised and never enters a timed-out state. Heartbeat-gated on
        // the granting side (director / attachAutoExtend): no progress ⇒ decline,
        // and we fall through to the real-deadline behaviour below at the cap.
        // Asked at most once per window (preemptState === ACTIVE).
        if (
          wallLimit !== undefined &&
          !wallExceeded &&
          budget.onThreshold &&
          preemptState === PreemptState.ACTIVE &&
          elapsed >= wallLimit * preemptFraction
        ) {
          // Heartbeat gate: only negotiate a pre-empt extension if the agent has
          // made progress (a tool call / iteration / streamed output) SINCE the
          // last grant. A stalled agent — no new activity since its last
          // extension — gets no further pre-empt; we lock and let the real
          // deadline reap it. `activityTs` is the wall-clock time of the last
          // activity (now − idleMs). Without this gate an always-granting
          // listener would extend a wedged agent forever and the deadline would
          // never fire (T1).
          const activityTs = Date.now() - budget.idleMs();
          if (activityTs <= lastGrantActivityTs) {
            preemptState = PreemptState.LOCKED;
            preemptedCeiling = wallLimit;
            scheduleNext();
            return;
          }
          // C1 fix: register the watchdog as active BEFORE calling onThreshold so
          // that any concurrent tool.progress → checkTimeout() path sees the flag
          // and skips its own wall-clock emission. Cleared on every exit path so
          // checkTimeout() resumes normal operation after negotiation completes.
          budget.setWatchdogNegotiation(wallLimit);
          try {
            const decision = await negotiateTimeout(elapsed, wallLimit);
            if (typeof decision !== 'string' && decision.extend.timeoutMs !== undefined) {
              // Granted ahead of the deadline — raise the ceiling and open a
              // fresh window (a later pre-empt becomes eligible again, but only
              // if there is fresh activity by then — see the heartbeat gate).
              budget.patchLimits({ timeoutMs: decision.extend.timeoutMs });
              lastGrantActivityTs = Date.now() - budget.idleMs();
              preemptState = PreemptState.ACTIVE;
              preemptedCeiling = null;
            } else {
              // Declined proactively (no progress / no listener). Don't re-ask
              // until the real deadline — the wallExceeded path below handles the
              // at-cap behaviour (warn+continue or hard stop).
              preemptState = PreemptState.LOCKED;
              preemptedCeiling = wallLimit;
            }
          } catch {
            preemptState = PreemptState.LOCKED;
            preemptedCeiling = wallLimit;
          } finally {
            budget.clearWatchdogNegotiation();
          }
          scheduleNext();
          return;
        }

        // Neither deadline actually tripped — we woke early because activity
        // pushed the idle deadline out (or a pre-empt was just resolved).
        // Re-arm for the new soonest deadline.
        if (!wallExceeded) {
          scheduleNext();
          return;
        }

        // Wall-clock cap hit. This is opt-in and keeps the original
        // soft-warning behaviour: negotiate an extension rather than
        // hard-killing a task solely for running long.
        const limit = wallLimit ?? 0;
        // Without an onThreshold handler the original behaviour stands:
        // abort the signal and hard-reject. This preserves the contract
        // for direct SubagentBudget consumers that don't wire negotiation.
        if (!budget.onThreshold) {
          this.subagents.get(ctx.subagentId)?.abortController.abort();
          reject(new BudgetExceededError('timeout', limit, elapsed));
          return;
        }
        // C1 fix: same guard as the pre-empt branch — register before onThreshold
        // so concurrent tool.progress → checkTimeout() skips its wall-clock emission.
        budget.setWatchdogNegotiation(limit);
        try {
          const decision = await negotiateTimeout(elapsed, limit);
          if (decision === 'throw') {
            // 'throw' is an explicit signal from the handler: end now rather
            // than silently keeping the subagent alive past its deadline.
            terminate('timeout', limit, elapsed);
            return;
          }
          if (decision === 'continue') {
            // 'continue' — timeout denied but coordinator wants the agent to keep
            // running. Re-arm for a full wall window so we ask again later.
            // This makes wall-clock timeout a pure warning event: the subagent
            // keeps running until it naturally finishes, the next deadline fires,
            // or the user stops it.
            //
            // IMPORTANT: we must lock the pre-empt arm (set preemptState =
            // LOCKED) so it does NOT fire again until the ceiling changes.
            // The ceiling only changes if a future negotiation returns 'extend'
            // and patches budget.limits.timeoutMs. Without the lock, the
            // pre-empt would re-arm for ~1 s (Math.max(1_000, limit)) and
            // immediately fire again at elapsed > wallLimit × 0.85, creating
            // a ping-pong loop of spurious budget.threshold_reached events.
            preemptState = PreemptState.LOCKED;
            preemptedCeiling = wallLimit;
            armFor(Math.max(1_000, limit));
            return;
          }
          if (decision === 'stop') {
            // 'stop' — coordinator explicitly denied the extension and wants
            // the agent to end. This is a terminal decision: end now.
            terminate('timeout', limit, elapsed);
            return;
          }
          // 'extend' — patch budget and re-arm for the new remainder.
          if (decision.extend.timeoutMs !== undefined) {
            budget.patchLimits({ timeoutMs: decision.extend.timeoutMs });
            lastGrantActivityTs = Date.now() - budget.idleMs();
            preemptState = PreemptState.ACTIVE;
            preemptedCeiling = null;
            scheduleNext();
            return;
          }
          // No timeoutMs in extend — nothing to grant → end.
          terminate('timeout', limit, elapsed);
          return;
        } catch (err) {
          this.subagents.get(ctx.subagentId)?.abortController.abort();
          reject(
            err instanceof BudgetExceededError
              ? err
              : new BudgetExceededError('timeout', limit, elapsed),
          );
          return;
        } finally {
          // Always clear the watchdog flag so checkTimeout() resumes wall-clock
          // checking on the next tool.progress event.
          budget.clearWatchdogNegotiation();
        }
      };
      // First arm: whichever of the idle window / pre-empt point / wall cap is sooner.
      scheduleNext();
    });

    try {
      return await Promise.race([runner(task, ctx), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private recordCompletion(result: TaskResult): void {
    this.completedResults.push(result);
    // Trim oldest entries when the cap is exceeded — keep the most recent
    // results so /fleet and roll_up still have data to work with.
    if (this.completedResults.length > DefaultMultiAgentCoordinator.MAX_COMPLETED_RESULTS) {
      this.completedResults.splice(
        0,
        this.completedResults.length - DefaultMultiAgentCoordinator.MAX_COMPLETED_RESULTS,
      );
    }
    this.totalIterations += result.iterations;
    if (this.inFlight > 0) {
      this.inFlight--;
    } else if (this.runner) {
      // Runner-driven path completed without an outstanding inFlight slot —
      // shouldn't happen unless completeTask was called externally.
      this.emit('warning', {
        type: 'inFlight_underflow',
        taskId: result.taskId,
        subagentId: result.subagentId,
      });
      return;
    }

    const subagent = this.subagents.get(result.subagentId);
    if (subagent && subagent.status !== 'stopped') {
      const failed = result.status === 'failed' || result.status === 'timeout';
      // Synchronously reset the worker to idle after either a clean
      // finish or a transient failure. The previous code parked the
      // subagent in 'error' and used a `queueMicrotask` to flip it
      // back to 'idle' — that opened a window where `assign()` +
      // `tryDispatchNext` could race the microtask, leaving the
      // worker stuck in 'running' state while actually idle. By
      // resetting now, no async gap can leak the state machine.
      subagent.status = 'idle';
      void failed; // kept for future telemetry hooks
      subagent.currentTask = undefined;
      // If the run aborted (timeout or explicit stop), the subagent's
      // signal is now permanently aborted — recycling the controller lets
      // the next dispatched task start with a fresh cancellation scope.
      if (subagent.abortController.signal.aborted) {
        subagent.abortController = new AbortController();
      }

      this.fleetBus?.emit({
        subagentId: result.subagentId,
        ts: Date.now(),
        type: 'subagent.idle',
        payload: { subagentId: result.subagentId },
      });
    }
    // Clear the terminating flag now that the worker has a terminal
    // TaskResult on record. Subsequent stop() calls re-add it; new
    // assign() calls can flow normally.
    this.terminating.delete(result.subagentId);

    this.emit('task.completed', {
      task: subagent?.context.tasks.find((t) => t.id === result.taskId) ?? { id: result.taskId },
      result,
    });

    this.fleetBus?.emit({
      subagentId: result.subagentId,
      taskId: result.taskId,
      ts: Date.now(),
      type: 'subagent.completed',
      payload: {
        subagentId: result.subagentId,
        taskId: result.taskId,
        status: result.status,
        result: result.result,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
      },
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
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;

    // Gracefully stop first — same logic as stop() but don't block on it.
    if (subagent.status === 'running' || subagent.status === 'idle') {
      this.terminating.add(subagentId);
      subagent.abortController.abort();
      subagent.status = 'stopped';
    }

    // Release all resources associated with this subagent.
    this.subagents.delete(subagentId);
    this.terminating.delete(subagentId);
    // Free the nickname slot so the same name can be reused by a future spawn.
    const nicknameKey = this.subagentNicknames.get(subagentId);
    if (nicknameKey) {
      this.usedNicknames.delete(nicknameKey);
      this.subagentNicknames.delete(subagentId);
    }

    // Clean up any pending tasks assigned to this subagent — emit synthetic
    // 'stopped' completions so callers awaiting them via awaitTasks() unblock
    // instead of hanging forever. Without this, a task queued for a removed
    // subagent would leave its waiter permanently unresolved.
    const orphaned = this.pendingTasks.filter((t) => t.subagentId === subagentId);
    this.pendingTasks = this.pendingTasks.filter((t) => t.subagentId !== subagentId);
    for (const t of orphaned) {
      // Inline-emit, NOT recordCompletion: these are PENDING tasks that were
      // never counted in inFlight. Routing them through recordCompletion would
      // decrement inFlight on behalf of a still-running task and suppress that
      // task's own completion via the underflow guard, hanging its awaiter.
      this.emitPendingAborted(
        t,
        `Subagent "${subagentId}" was removed while task "${t.id}" was pending`,
      );
    }

    this.fleetBus?.emit({
      subagentId,
      ts: Date.now(),
      type: 'subagent.removed',
      payload: { subagentId },
    });

    this.emitCoordinatorStats();
  }

  private isDone(): boolean {
    if (this.config.doneCondition.type === 'all_tasks_done') {
      return this.pendingTasks.length === 0 && this.inFlight === 0;
    }
    if (
      this.config.doneCondition.maxIterations !== undefined &&
      this.totalIterations >= this.config.doneCondition.maxIterations
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Map any raw exception thrown out of a subagent's runner into a
 * structured `SubagentError`. Delegates to the shared classifier.
 * Re-exported for backward compatibility.
 */
export { classifySubagentError } from './coordinator/error-classifier.js';
