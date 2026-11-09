import type { TodoItem } from '../core/context.js';
import { coordinateGoalIteration } from '../storage/goal-coordination.js';
import {
  appendJournal,
  type GoalFile,
  goalFilePath,
  type JournalEntry,
  loadGoal,
  parseProgressFromText,
  recordProgress,
  saveGoal,
} from '../storage/goal-store.js';
import { toErrorMessage } from '../utils/error.js';
import { sleep } from '../utils/sleep.js';
import { compactionReportStillCurrent } from './compaction-result-state.js';
import {
  brainstormTask as delegateBrainstormTask,
  buildDirective as delegateBuildDirective,
  pickGitTask as delegatePickGitTask,
  readGitStatus as delegateReadGitStatus,
  type EternalAutonomyDirectivesHost,
} from './eternal-autonomy-directives.js';
import { BRAINSTORM_DONE } from './eternal-autonomy-directives-types.js';
import {
  compactionDue,
  type DecidedAction,
  type DirectiveOutcome,
  DONE_DELIVERABLE_MARKER,
  GOAL_CLEAR_MARKER,
  GOAL_COMPLETE_MARKER,
  iterationUsageDelta,
  runDirective,
} from './eternal-autonomy-run.js';
import type { EternalCompletionHost } from './eternal-completion.js';
import {
  clearGoalManually as clearGoalManuallyFromHost,
  consultBrainForDone as consultBrainForDoneFromHost,
  markGoalCompleted as markGoalCompletedFromHost,
} from './eternal-completion.js';

/**
 * Sense-decide-execute-reflect loop on top of a long-running Goal.
 *
 * Each iteration:
 *   1. Sense   — read goal, pending todos, `git status --porcelain`.
 *   2. Decide  — pick a source (todo / git / brainstorm) and a task.
 *   3. Execute — single agent.run with a directive prompt.
 *   4. Reflect — append a journal entry, persist state to disk.
 *
 * The loop runs forever until `stop()` is called externally (REPL SIGINT
 * handler, /autonomy stop). No internal time/cost cap by design — the
 * user wants "sittin sene". Failures are logged and the loop continues
 * with a different source on the next tick.
 */

export type {
  EternalAutonomyOptions,
  EternalEngineState,
  IterationStage,
} from './eternal-autonomy-types.js';

import type {
  EternalAutonomyOptions,
  EternalEngineState,
  IterationStage,
} from './eternal-autonomy-types.js';

export class EternalAutonomyEngine {
  private state: EternalEngineState = 'idle';
  private stopRequested = false;
  private consecutiveFailures = 0;
  private consecutiveBrainstormDone = 0;
  /**
   * Count of consecutive transient (recoverable) provider failures. Drives
   * the exponential backoff between iterations. Reset on the first
   * successful iteration so a single bad afternoon doesn't permanently
   * slow the loop down.
   */
  private consecutiveTransientRetries = 0;
  private currentCtrl: AbortController | null = null;
  private iterationsSinceCompact = 0;
  private readonly goalPath: string;

  constructor(private readonly opts: EternalAutonomyOptions) {
    this.goalPath = goalFilePath(opts.projectRoot);
  }

  /**
   * Emit a structured error. Uses the configured Logger when available;
   * falls back to console.error(JSON) so events are never silently dropped.
   */
  private logError(msg: string, ctx?: Record<string, unknown>): void {
    if (this.opts.logger) {
      this.opts.logger.error(msg, ctx);
    } else {
      console.error(JSON.stringify({ ...ctx, message: msg, timestamp: new Date().toISOString() }));
    }
  }

  /** Current engine state — readable for UIs. */
  get currentState(): EternalEngineState {
    return this.state;
  }

  /**
   * Load the goal file with structured logging for parse/schema warnings.
   */
  private loadGoal(): Promise<GoalFile | null> {
    return loadGoal(
      this.goalPath,
      this.opts.events,
      this.opts.logger ? (msg) => this.opts.logger!.warn(msg) : undefined,
    );
  }

  /**
   * The engine ended itself (goal gone, completed or cleared). Raises the loop
   * signal AND moves `state`, because REPL/TUI drivers call runOneIteration()
   * directly and stop on `currentState === 'stopped'` — the loop flag alone
   * left them re-entering a finished engine forever.
   */
  private halt(): void {
    this.stopRequested = true;
    this.state = 'stopped';
  }

  /** Synchronously request stop. Resolves once the running iteration aborts. */
  stop(): void {
    this.stopRequested = true;
    this.currentCtrl?.abort();
    // Best-effort: flip the persisted state so the next startup banner
    // doesn't report a phantom "running" engine. Fire-and-forget — if it
    // races with an in-flight iteration's write, the journal write wins
    // (engineState is metadata, not durable correctness).
    void this.persistEngineState('stopped').catch((err) => {
      this.logError('Engine persist state failed', {
        event: 'engine.persist_state_failed',
        message: toErrorMessage(err),
        context: { expectedState: 'stopped' },
      });
    });
    this.state = 'stopped';
  }

  /**
   * Mark the engine as 'running' on disk + reset stop state so a new
   * batch of `runOneIteration()` calls can proceed. Called by the REPL
   * when the user invokes `/autonomy eternal`. Idempotent.
   */
  async prime(): Promise<void> {
    this.stopRequested = false;
    this.state = 'running';
    await this.persistEngineState('running').catch(() => {});
  }

  /**
   * Main loop. Returns when stop() is called or the goal file is removed.
   * Does NOT throw — every iteration is wrapped to keep the loop alive.
   */
  async run(): Promise<void> {
    this.state = 'running';
    await this.persistEngineState('running');

    try {
      while (!this.stopRequested) {
        let iterationOk = false;
        try {
          iterationOk = await this.runOneIteration();
        } catch (err) {
          this.consecutiveFailures++;
          this.opts.onError?.(
            err instanceof Error ? err : new Error(String(err)),
            this.consecutiveFailures,
          );
          await this.appendFailure('engine error', toErrorMessage(err));
        }

        if (iterationOk) {
          this.consecutiveFailures = 0;
        }

        if (this.stopRequested) break;

        // Brief gap so SIGINT can land between iterations even if the
        // agent is bouncing back results fast. 0 by default for 24/7 mode.
        await sleep(this.opts.cycleGapMs ?? 0);
      }
    } finally {
      this.state = 'stopped';
      await this.persistEngineState('stopped').catch(() => {});
    }
  }

  /**
   * Execute a single sense-decide-execute-reflect cycle.
   * Returns true on success, false on handled failure / no-op.
   *
   * Exposed publicly so the REPL can pace iterations from its main loop
   * — running the engine and the REPL as a single sequential consumer of
   * `agent.run()` avoids race conditions on the shared Context.
   */
  async runOneIteration(): Promise<boolean> {
    // Emit stage transitions so UIs can render the engine's live location.
    const emit = (stage: IterationStage) => {
      this.opts.onStage?.(stage);
    };

    const goal = await this.loadGoal();
    if (!goal) {
      // Goal file disappeared — treat as a graceful stop.
      emit({ phase: 'stopped' });
      this.halt();
      return false;
    }

    // Mission-level lifecycle gate. A paused mission only ends this pass: the
    // engine stays 'running' so a driver polling `currentState` keeps waiting
    // for `/goal resume`. Every other non-active state ends the engine.
    const missionState = goal.goalState ?? 'active';
    if (missionState !== 'active') {
      if (missionState === 'paused') {
        emit({ phase: 'paused' });
        this.stopRequested = true;
      } else {
        emit({ phase: 'stopped' });
        this.halt();
      }
      return false;
    }

    emit({ phase: 'decide', reason: 'picking next task' });
    const action = await this.decide(goal);
    if (!action) {
      if (!this.stopRequested) {
        const noTaskCoolDownMs = this.opts.noTaskCoolDownMs ?? 5_000;
        emit({ phase: 'sleep', ms: noTaskCoolDownMs });
        await sleep(noTaskCoolDownMs);
      } else {
        emit({ phase: 'stopped' });
      }
      return false;
    }

    emit({ phase: 'execute', task: action.task });

    const ctrl = new AbortController();
    this.currentCtrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), this.opts.iterationTimeoutMs ?? 5 * 60_000);
    // Snapshot usage before so the iteration delta can be journaled.
    // Token counter is optional in mock/test contexts — guard accordingly.
    const tc = this.opts.agent.ctx?.tokenCounter;
    const beforeUsage = tc?.total?.();
    const beforeCost = tc?.estimateCost?.().total;

    let outcome: DirectiveOutcome;
    try {
      outcome = await runDirective(
        this.opts.agent,
        action.directive,
        ctrl.signal,
        this.opts.iterationMaxAgentSteps ?? 500,
      );
    } finally {
      clearTimeout(timer);
      this.currentCtrl = null;
    }
    const { status, note, finalText, isTransientFailure } = outcome;

    // Per-todo attempt accounting. On failure of a todo-sourced action,
    // bump the persistent counter so `decide()` can rotate past it once
    // it crosses the configured ceiling. Successful runs leave the
    // counter untouched — the LLM is responsible for flipping the todo
    // status to `completed` via the todos tool (directive teaches this).
    if (action.source === 'todo' && action.todoId && status !== 'success') {
      await this.bumpTodoAttempt(action.todoId);
    }

    const { tokens, costUsd } = iterationUsageDelta(
      beforeUsage,
      tc?.total?.(),
      beforeCost,
      tc?.estimateCost?.().total,
    );

    await this.appendIterationEntry({
      source: action.source,
      task: action.task,
      status,
      note,
      tokens,
      costUsd,
    });

    emit({ phase: 'reflect', status, note });

    // Re-read the goal so we can emit the real iteration counter rather
    // than the previous placeholder. If the goal was unlinked mid-flight
    // (graceful stop via /goal clear) the iteration index is still
    // useful — fall back to the in-memory consecutiveFailures-derived
    // approximation only as a last resort.
    let iterationIndex = 0;
    try {
      const reloaded = await this.loadGoal();
      iterationIndex = reloaded?.iterations ?? 0;
    } catch (err) {
      this.logError('Goal reload failed', {
        event: 'autonomy.goal_reload_failed',
        message: toErrorMessage(err),
        context: { goalPath: this.goalPath },
      });
    }
    this.opts.onIteration?.({
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      iteration: iterationIndex,
      source: action.source,
      task: action.task,
      status,
      note,
      tokens,
      costUsd,
    });

    // Transient failure — sleep with interruptible backoff before retry.
    if (status === 'failure') {
      if (isTransientFailure) {
        this.consecutiveTransientRetries++;
        const delay = this.computeTransientBackoffMs();
        if (delay > 0) {
          emit({ phase: 'sleep', ms: delay });
          await this.sleepInterruptible(delay);
        }
        return false;
      }
      this.consecutiveFailures++;
      return false;
    }

    if (status === 'aborted') {
      if (this.stopRequested) return false;
      this.consecutiveFailures++;
      return false;
    }

    // Successful iteration
    this.consecutiveTransientRetries = 0;
    const cycleGapMs = this.opts.cycleGapMs ?? 1000;
    emit({ phase: 'sleep', ms: cycleGapMs });
    await sleep(cycleGapMs);

    // Adaptive deliverable coordination. A successful iteration can mark one
    // or more deliverables with `[DONE: index|prefix]`. The coordinator mirrors
    // those completions into the goal Kanban, recomputes progress from the
    // board, and performs one Brain verification when the checklist reaches
    // 100%. A verified reach is persisted in goal.json instead of deleting it,
    // so TUI/WebUI can keep showing the final 100% bar and `goal reached` note.
    let coordinatedProgress: number | undefined;
    if (DONE_DELIVERABLE_MARKER.test(finalText)) {
      const coordinated = await coordinateGoalIteration({
        projectRoot: this.opts.projectRoot,
        goalPath: this.goalPath,
        finalText,
        brain: this.opts.brain,
        sessionId: this.opts.agent.ctx.eventSessionId(),
        events: this.opts.events,
        now: this.opts.now,
      });
      coordinatedProgress = coordinated?.goal.progress;
      if (coordinated?.reached) {
        this.halt();
        this.opts.onEternalStop?.();
        return true;
      }
    }

    // Goal-complete detection. The model emits `[GOAL_COMPLETE]` on its
    // own line in `finalText` when the overall mission is verifiably done.
    // Combined with a successful iteration this is a strong stop signal:
    // the LLM explicitly claimed completion AND the run did not fail. We
    // mark the goal `completed`, journal it, and stop. No separate
    // verifier round-trip — keeps cost down; if the model lies, the user
    // notices and can re-arm with `/goal set`.
    if (GOAL_COMPLETE_MARKER.test(finalText)) {
      // Treat GOAL_COMPLETE as a full goal clear: remove the goal file and
      // fire onEternalStop so the REPL exits eternal mode. Stronger than
      // just marking completed — the REPL needs both to happen.
      await this.clearGoalManually(finalText);
      this.halt();
      return true;
    }
    // Goal-clear detection — model emits `[goal clear]` equivalent to
    // `/goal clear`. Treat as a manual stop: remove the goal file and fire
    // onEternalStop so the REPL knows to return to normal mode.
    if (GOAL_CLEAR_MARKER.test(finalText)) {
      await this.clearGoalManually(finalText);
      this.halt();
      return true;
    }

    // ── Progress tracking ──
    // Parse [PROGRESS: N%] from the agent's final text and persist it.
    // Also auto-complete the goal when the agent reports 100% progress.
    const parsed = parseProgressFromText(finalText);
    if (parsed) {
      const progress = Math.max(parsed.progress, coordinatedProgress ?? 0);
      await this.updateProgress(progress, parsed.note);
      if (parsed.progress >= 100 && coordinatedProgress === undefined) {
        // Agent claims 100% — add a final journal entry and complete.
        await this.markGoalCompleted(
          { source: action.source, task: action.task, directive: action.directive },
          `progress reached 100%: ${parsed.note ?? 'goal complete'}`,
        );
        this.halt();
        return true;
      }
    }

    // Compaction runs only on successful iterations — there's no point
    // compacting after a failed/aborted iteration that didn't add much to
    // the message history.
    this.iterationsSinceCompact++;
    await this.maybeCompact().catch((err) => {
      // Don't let compaction failure kill the loop; surface via onError.
      this.opts.onError?.(
        err instanceof Error ? err : new Error(String(err)),
        this.consecutiveFailures,
      );
    });
    return true;
  }

  /**
   * Run compaction when either trigger fires:
   *   - We've done >= compactEveryNIterations since the last compact.
   *   - Current request tokens exceed aggressiveCompactRatio * maxContext.
   *
   * The second check uses *aggressive* mode to free more headroom; the
   * cadence check uses non-aggressive (cheaper).
   */
  private async maybeCompact(): Promise<void> {
    const compactor = this.opts.compactor;
    if (!compactor) return;
    const ctx = this.opts.agent.ctx;
    if (!ctx) return;

    const due = compactionDue(this.opts, ctx, this.iterationsSinceCompact);
    if (!due) return;
    const { aggressive } = due;

    const report = await compactor.compact(ctx, { aggressive });
    if (ctx.signal?.aborted || !compactionReportStillCurrent(report, ctx)) return;
    this.iterationsSinceCompact = 0;
    // Journal the compaction event so users see it in /goal journal.
    const saved = report.before - report.after;
    await this.appendIterationEntry({
      source: 'manual',
      task: `compaction (${aggressive ? 'aggressive' : 'cadence'})`,
      status: 'success',
      note: `saved ~${saved} tokens (${report.before}→${report.after})`,
    });
  }

  /**
   * Hybrid idea source.
   *   1. Pending todos on the agent's context.
   *   2. Dirty git working tree → propose a "review and finish this" task.
   *   3. Otherwise: brainstorm via the LLM against the goal.
   *
   * After failureBudget consecutive failures, force brainstorm so the
   * engine doesn't loop on the same broken todo or stuck git state.
   */
  private async decide(goal: GoalFile): Promise<DecidedAction | null> {
    const forceBrainstorm = this.consecutiveFailures >= (this.opts.failureBudget ?? 3);

    if (!forceBrainstorm) {
      const todo = this.pickPendingTodo(goal);
      if (todo) {
        return {
          source: 'todo',
          task: todo.content,
          todoId: todo.id,
          directive: this.buildDirective(goal, 'todo', todo.content),
        };
      }

      const gitTask = await this.pickGitTask();
      // A git task that already succeeded on the same dirty set is done: the
      // tree stays dirty until someone commits, and re-picking it would keep
      // the loop from reaching the goal until the dirty set changes.
      const lastGit = goal.journal.findLast((entry) => entry.source === 'git');
      const gitTaskDone = lastGit?.status === 'success' && lastGit.task === gitTask;
      if (gitTask && !gitTaskDone) {
        return {
          source: 'git',
          task: gitTask,
          directive: this.buildDirective(goal, 'git', gitTask),
        };
      }
    }

    const brainstormed = await this.brainstormTask(goal);
    if (brainstormed === BRAINSTORM_DONE) {
      this.consecutiveBrainstormDone++;
      const threshold = this.opts.brainstormDoneStopThreshold ?? 3;
      if (this.consecutiveBrainstormDone >= threshold) {
        // Consult the brain before stopping — it may decide to continue
        const shouldStop = await this.consultBrainForDone(goal);
        if (shouldStop) {
          await this.markGoalCompleted(
            { source: 'brainstorm', task: 'no further work', directive: '' },
            `brainstorm returned DONE ${this.consecutiveBrainstormDone}x in a row${this.opts.brain ? ', brain confirmed' : ''}`,
          );
          this.halt();
        } else {
          // Brain says keep going — reset the DONE streak
          this.consecutiveBrainstormDone = 0;
        }
      }
      return null;
    }
    if (!brainstormed) return null;
    // Got a real task — reset the DONE streak.
    this.consecutiveBrainstormDone = 0;
    return {
      source: 'brainstorm',
      task: brainstormed,
      directive: this.buildDirective(goal, 'brainstorm', brainstormed),
    };
  }

  private pickPendingTodo(goal: GoalFile): TodoItem | null {
    const todos = this.opts.agent.ctx.todos;
    if (!Array.isArray(todos)) return null;
    const attempts = goal.todoAttempts ?? {};
    const ceiling = this.opts.todoMaxAttempts ?? 3;
    // First-pending strategy with a stuck-task escape hatch: if the
    // first pending todo has already failed `ceiling` times, fall
    // through to later pending todos. Returns null when every pending
    // todo is stuck — the caller will fall through to git/brainstorm.
    for (const t of todos) {
      if (t.status !== 'pending') continue;
      const used = attempts[t.id] ?? 0;
      if (used >= ceiling) continue;
      return t;
    }
    return null;
  }

  private async pickGitTask(): Promise<string | null> {
    return delegatePickGitTask(this.eternalAutonomyDirectivesHost());
  }

  private async readGitStatus(): Promise<string> {
    return delegateReadGitStatus(this.eternalAutonomyDirectivesHost());
  }

  private async brainstormTask(goal: GoalFile): Promise<string | null | typeof BRAINSTORM_DONE> {
    return delegateBrainstormTask(this.eternalAutonomyDirectivesHost(), goal);
  }

  private buildDirective(goal: GoalFile, source: JournalEntry['source'], task: string): string {
    return delegateBuildDirective(this.eternalAutonomyDirectivesHost(), goal, source, task);
  }

  /**
   * Exponential backoff for transient provider errors. `2^N * base`
   * capped at `transientBackoffMaxMs`. Zero base disables backoff.
   * Public-private to keep `runOneIteration` readable; the value is
   * recomputed each call from the current retry count, so callers
   * don't have to track state.
   */
  private computeTransientBackoffMs(): number {
    const base = this.opts.transientBackoffBaseMs ?? 2_000;
    const cap = this.opts.transientBackoffMaxMs ?? 60_000;
    if (base <= 0) return 0;
    const exponent = Math.max(0, this.consecutiveTransientRetries - 1);
    return Math.min(cap, base * 2 ** exponent);
  }

  /**
   * Sleep that wakes early if `stopRequested` flips. Polls every 250 ms
   * so SIGINT / `/autonomy stop` can land in the middle of a long
   * backoff instead of waiting up to a minute for the timer.
   */
  private async sleepInterruptible(totalMs: number): Promise<void> {
    const step = 250;
    let remaining = totalMs;
    while (remaining > 0 && !this.stopRequested) {
      const chunk = Math.min(step, remaining);
      await sleep(chunk);
      remaining -= chunk;
    }
  }

  private async appendIterationEntry(entry: Omit<JournalEntry, 'iteration' | 'at'>): Promise<void> {
    const current = await this.loadGoal();
    if (!current) {
      // Goal was cleared mid-iteration; nothing to write to.
      return;
    }
    const updated = appendJournal(current, entry);
    await saveGoal(this.goalPath, updated, this.opts.events);
  }

  /**
   * Persistent per-todo failure counter. Skipped silently when the goal
   * file has been removed (graceful clear). Each non-success iteration
   * against a todo source bumps the counter by 1; `pickPendingTodo` reads
   * the counter to rotate past stuck todos once they cross `todoMaxAttempts`.
   */
  private async bumpTodoAttempt(todoId: string): Promise<void> {
    const current = await this.loadGoal();
    if (!current) return;
    const attempts = { ...(current.todoAttempts ?? {}) };
    attempts[todoId] = (attempts[todoId] ?? 0) + 1;
    await saveGoal(this.goalPath, { ...current, todoAttempts: attempts }, this.opts.events);
  }

  /**
   * Flip the mission to `completed` and journal it. Called from two
   * paths: (a) `[GOAL_COMPLETE]` marker in a successful iteration's
   * finalText, (b) `brainstorm` returning DONE consecutively past the
   * configured threshold. Idempotent — re-entry is a no-op once the
   * goal is already `completed`.
   */
  private async markGoalCompleted(
    action: { source: JournalEntry['source']; task: string; directive: string },
    note: string,
  ): Promise<void> {
    return markGoalCompletedFromHost.call(this.eternalCompletionHost(), action, note);
  }

  /**
   * Manually clear the goal — equivalent to `/goal clear` typed by the user.
   * Sets goalState to `abandoned`, removes the goal file, and fires
   * `onEternalStop` so the REPL returns to normal mode.
   */
  private async clearGoalManually(note: string): Promise<void> {
    return clearGoalManuallyFromHost.call(this.eternalCompletionHost(), note);
  }

  private async appendFailure(task: string, note: string): Promise<void> {
    await this.appendIterationEntry({ source: 'manual', task, status: 'failure', note });
  }

  /**
   * Consult the brain on whether the goal is truly complete.
   * Without a brain, always returns true (use heuristic: DONE threshold met = done).
   */
  private async consultBrainForDone(goal: GoalFile): Promise<boolean> {
    return consultBrainForDoneFromHost.call(this.eternalCompletionHost(), goal);
  }

  /**
   * Persist a progress update from the agent's [PROGRESS: N%] output.
   */
  private async updateProgress(progress: number, note?: string): Promise<void> {
    const current = await this.loadGoal();
    if (!current) return;
    const updated = recordProgress(current, progress, note);
    await saveGoal(this.goalPath, updated, this.opts.events);
  }

  private async persistEngineState(state: GoalFile['engineState']): Promise<void> {
    const current = await this.loadGoal();
    if (!current) return;
    if (current.engineState === state) return;
    await saveGoal(this.goalPath, { ...current, engineState: state }, this.opts.events);
  }

  private eternalAutonomyDirectivesHost(): EternalAutonomyDirectivesHost {
    const self = this;
    return {
      get opts() {
        return self.opts;
      },
      readGitStatus: (...args) => this.readGitStatus(...args),
      logError: (...args) => this.logError(...args),
    };
  }

  private eternalCompletionHost(): EternalCompletionHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.loadGoal satisfies EternalCompletionHost['loadGoal']);
    void (this.goalPath satisfies EternalCompletionHost['goalPath']);
    void (this.opts satisfies EternalCompletionHost['opts']);
    void (this.appendIterationEntry satisfies EternalCompletionHost['appendIterationEntry']);
    void (this
      .consecutiveBrainstormDone satisfies EternalCompletionHost['consecutiveBrainstormDone']);
    return this as unknown as EternalCompletionHost;
  }
}
