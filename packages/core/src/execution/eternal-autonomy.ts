import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Agent } from '../core/agent.js';
import type { TodoItem } from '../core/context.js';
import type { EventBus } from '../kernel/events.js';
import type { Compactor } from '../types/compactor.js';
import type { BrainArbiter } from '../coordination/brain.js';
import {
  appendJournal,
  loadGoal,
  saveGoal,
  goalFilePath,
  parseProgressFromText,
  recordProgress,
  type GoalFile,
  type JournalEntry,
} from '../storage/goal-store.js';
import { sleep } from '../utils/sleep.js';
import { toErrorMessage } from '../utils/error.js';
import { formatDecisionSummary } from './autonomy-brain.js';

const execFileP = promisify(execFile);

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

export interface EternalAutonomyOptions {
  agent: Agent;
  projectRoot: string;
  /**
   * Per-iteration agent timeout. Defaults to 5 minutes. A single hung
   * provider call should not freeze the whole eternal loop.
   */
  iterationTimeoutMs?: number | undefined;
  /**
   * Maximum number of internal agent.run iterations the engine grants per
   * eternal-loop tick. The engine sets `autonomousContinue: true` so the
   * agent can run multi-step tasks end-to-end within one tick instead of
   * bouncing back to the engine after every single tool call. Default 500.
   * Previous 50 was far too low — agents hit the limit and restart constantly.
   */
  iterationMaxAgentSteps?: number | undefined;
  /**
   * Minimum sleep between iterations. Defaults to 1 s — enough for
   * SIGINT handlers to fire mid-loop without pegging a core when the
   * provider is being rate-limited.
   */
  cycleGapMs?: number | undefined;
  /**
   * Maximum consecutive failures before the source rotation forces a
   * brainstorm cycle. Default 3. Acts as a soft-recovery, not a stop.
   */
  failureBudget?: number | undefined;
  /**
   * Per-todo failed-attempt ceiling. When the engine picks the same todo
   * and the iteration fails this many times in total, the todo is taken
   * out of rotation (engine prefers other sources) until it changes
   * status. Default 3. Prevents the loop from spinning forever on one
   * stuck task.
   */
  todoMaxAttempts?: number | undefined;
  /**
   * Consecutive brainstorm-DONE responses required to consider the goal
   * complete and stop the engine. When the LLM's brainstorm step keeps
   * answering `DONE`, the engine treats that as "no more work" and, after
   * this many in a row, marks the goal as completed instead of sleeping
   * forever. Default 3.
   */
  brainstormDoneStopThreshold?: number | undefined;
  /** Side-channel notifications (logging, UI updates). */
  onIteration?: (((entry: JournalEntry) => void)) | undefined;
  onError?: (err: Error | undefined, iteration: number) => void;
  /**
   * Per-iteration phase notifications for live UI updates (TUI status bar,
   * etc.). Fires at each major stage transition: idle → decide → execute →
   * reflect → (sleep | paused | stopped). Fire-and-forget — the engine
   * does not await the callback.
   */
  onStage?: (((stage: IterationStage) => void)) | undefined;
  /**
   * Optional injected git status reader — production code uses git, tests
   * stub this out so they don't shell out.
   */
  gitStatusReader?: ((() => Promise<string>)) | undefined;
  /**
   * Optional clock — tests stub for deterministic timestamps.
   */
  now?: ((() => Date)) | undefined;
  /**
   * Optional compactor. When provided, the engine runs compaction every
   * `compactEveryNIterations` iterations to keep the agent's message
   * history under control during multi-day eternal loops. Without
   * compaction, an infinite loop will eventually overflow the provider's
   * context window and start failing.
   */
  compactor?: Compactor | undefined;
  /** How many iterations between compaction calls. Default 25. */
  compactEveryNIterations?: number | undefined;
  /**
   * Aggressive compaction threshold. When ctx token usage exceeds this
   * fraction of `maxContextTokens`, compaction runs in aggressive mode
   * regardless of the iteration cadence. 0.85 by default.
   */
  aggressiveCompactRatio?: number | undefined;
  /**
   * Model's max context window in tokens. When set, the engine watches
   * `currentRequestTokens()` against this and triggers aggressive compact
   * before the next iteration would overflow. Omit to disable threshold
   * checks (iteration cadence still applies).
   */
  maxContextTokens?: number | undefined;
  /**
   * Base delay (ms) for the first transient-error backoff. Subsequent
   * transient failures double this, capped at `transientBackoffMaxMs`.
   * Default 2_000.
   *
   * "Transient" means the underlying error is recoverable per
   * `WrongStackError.recoverable` (ProviderError sets this for 429/529/5xx
   * /network errors). Permanent errors (auth/invalid request) skip the
   * backoff and count toward `failureBudget` like before — backing off
   * on a permanent failure is wasted time.
   */
  transientBackoffBaseMs?: number | undefined;
  /** Ceiling for the exponential backoff. Default 60_000 (60 s). */
  transientBackoffMaxMs?: number | undefined;
  /** Called when the eternal loop stops for any reason (manual stop, goal complete, etc.). */
  onEternalStop?: ((() => void)) | undefined;
  /**
   * Optional brain arbiter for autonomous decision-making. When wired,
   * the engine consults the brain instead of auto-stopping on:
   * - Brainstorm DONE threshold reached
   * - Consecutive failures exceeding failure budget
   * - Goal completion verification
   * Without a brain, the engine uses its built-in heuristics.
   */
  brain?: BrainArbiter | undefined;
  /** Optional EventBus for emitting storage.* observability events from goal I/O. */
  events?: EventBus | undefined;
}

export type EternalEngineState = 'idle' | 'running' | 'stopped';

/**
 * Per-iteration phase emitted via `onStage` so UIs can render the
 * engine's live location in the sense-decide-execute-reflect loop.
 */
export type IterationStage =
  | { phase: 'idle' }
  | { phase: 'decide'; reason: string }
  | { phase: 'execute'; task: string }
  | { phase: 'reflect'; status: 'success' | 'failure' | 'aborted' | 'skipped'; note?: string | undefined }
  | { phase: 'sleep'; ms: number }
  | { phase: 'paused' }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };

interface DecidedAction {
  source: JournalEntry['source'];
  task: string;
  directive: string;
  /** Set when source === 'todo' so the engine can attribute failures. */
  todoId?: string | undefined;
}

/**
 * Sentinel returned by `brainstormTask` when the LLM declares the goal
 * fully accomplished. Distinct from `null` (which means "brainstorm
 * failed / no actionable task right now") so the engine can count
 * consecutive DONE answers toward a real stop.
 */
const BRAINSTORM_DONE = Symbol('brainstorm-done');

/**
 * Free-text marker the model can emit (on its own line) to declare the
 * overall mission accomplished. Detected in the successful iteration's
 * `finalText`. When present, the engine flips `goalState='completed'`
 * and stops — the model has explicitly claimed completion AND the
 * iteration succeeded, which together is the most reliable stop signal
 * we can get without a separate verifier round-trip.
 */
const GOAL_COMPLETE_MARKER = /^\s*\[goal[_\s-]*complete\]\s*$/im;

/**
 * Free-text marker for the `/goal clear` command equivalent — when the
 * model emits this, the engine treats it as a manual goal clear (not just
 * completion) so the goal file is removed and onEternalStop fires.
 */
const GOAL_CLEAR_MARKER = /^\s*\[\/?goal\s*clear\]\s*$/im;

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

  /** Current engine state — readable for UIs. */
  get currentState(): EternalEngineState {
    return this.state;
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
      console.error(JSON.stringify({
        level: 'error',
        event: 'engine.persist_state_failed',
        message: toErrorMessage(err),
        context: { expectedState: 'stopped' },
        timestamp: new Date().toISOString(),
      }));
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
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), this.consecutiveFailures);
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

    const goal = await loadGoal(this.goalPath, this.opts.events);
    if (!goal) {
      // Goal file disappeared — treat as a graceful stop.
      emit({ phase: 'stopped' });
      this.stopRequested = true;
      return false;
    }

    // Mission-level lifecycle gate.
    const missionState = goal.goalState ?? 'active';
    if (missionState !== 'active') {
      emit({ phase: missionState === 'paused' ? 'paused' : 'stopped' });
      this.stopRequested = true;
      return false;
    }

    emit({ phase: 'decide', reason: 'picking next task' });
    const action = await this.decide(goal);
    if (!action) {
      if (!this.stopRequested) {
        emit({ phase: 'sleep', ms: 5_000 });
        await sleep(5_000);
      } else {
        emit({ phase: 'stopped' });
      }
      return false;
    }

    emit({ phase: 'execute', task: action.task });

    const ctrl = new AbortController();
    this.currentCtrl = ctrl;
    const timer = setTimeout(
      () => ctrl.abort(),
      this.opts.iterationTimeoutMs ?? 5 * 60_000,
    );
    let status: JournalEntry['status'] = 'success';
    let note: string | undefined;
    let finalText = '';
    // Captured from `result.error?.recoverable` when the agent.run returns
    // a recoverable WrongStackError (ProviderError sets this for 429/529
    // /5xx/network). Drives the engine's exponential backoff so a
    // transient rate-limit storm doesn't burn the failure budget in
    // seconds. Permanent errors leave this false and trip the normal
    // consecutiveFailures path.
    let isTransientFailure = false;

    // Snapshot usage before so the iteration delta can be journaled.
    // Token counter is optional in mock/test contexts — guard accordingly.
    const tc = this.opts.agent.ctx?.tokenCounter;
    const beforeUsage = tc?.total?.();
    const beforeCost = tc?.estimateCost?.().total;

    try {
      const result = await this.opts.agent.run(
        [{ type: 'text' as const, text: action.directive }],
        {
          signal: ctrl.signal,
          // Enable per-call autonomous continuation so the agent can chain
          // multiple internal tool/response cycles end-to-end on one
          // directive instead of returning to the engine after a single
          // round-trip. The model uses `[continue]` / `[done]` markers
          // (or the `continue_to_next_iteration` tool) to control the
          // inner loop. Without this flag the engine produced shallow
          // iterations and almost never let a real task finish.
          autonomousContinue: true,
          // Cap the inner loop so a runaway agent.run can't burn through
          // the iteration timeout — the engine's own outer loop is the
          // long-running thing, each tick should be bounded.
          maxIterations: this.opts.iterationMaxAgentSteps ?? 500,
        },
      );

      if (result.status === 'aborted') {
        status = 'aborted';
        note = 'stopped by user';
      } else if (result.status === 'failed') {
        status = 'failure';
        note = result.error?.describe?.() ?? 'agent run failed';
        isTransientFailure = result.error?.recoverable === true;
      } else if (result.status === 'max_iterations') {
        status = 'failure';
        note = `max iterations (${result.iterations})`;
      } else {
        status = 'success';
        finalText = result.finalText ?? '';
        const tail = finalText.slice(0, 240).replace(/\s+/g, ' ').trim();
        if (tail) note = tail;
      }
    } catch (err) {
      const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
      status = isAbort ? 'aborted' : 'failure';
      note = toErrorMessage(err);
      // Surface .recoverable on the thrown WrongStackError too — provider
      // errors that escape the agent's catch (rare; usually wrapped into
      // result.error) still classify correctly.
      if (
        !isAbort &&
        typeof (err as { recoverable?: unknown | undefined })?.recoverable === 'boolean'
      ) {
        isTransientFailure = (err as { recoverable: boolean }).recoverable;
      }
    } finally {
      clearTimeout(timer);
      this.currentCtrl = null;
    }

    // Per-todo attempt accounting. On failure of a todo-sourced action,
    // bump the persistent counter so `decide()` can rotate past it once
    // it crosses the configured ceiling. Successful runs leave the
    // counter untouched — the LLM is responsible for flipping the todo
    // status to `completed` via the todos tool (directive teaches this).
    if (action.source === 'todo' && action.todoId && status !== 'success') {
      await this.bumpTodoAttempt(action.todoId);
    }

    // Capture per-iteration usage delta. Cost is always non-negative;
    // if the counter wraps or resets mid-iteration we clamp to 0 so the
    // journal never shows negative spend.
    const afterUsage = tc?.total?.();
    const afterCost = tc?.estimateCost?.().total;
    const tokens =
      beforeUsage && afterUsage
        ? {
            input: Math.max(0, afterUsage.input - beforeUsage.input),
            output: Math.max(0, afterUsage.output - beforeUsage.output),
          }
        : undefined;
    const costUsd =
      typeof beforeCost === 'number' && typeof afterCost === 'number'
        ? Math.max(0, afterCost - beforeCost)
        : undefined;

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
      const reloaded = await loadGoal(this.goalPath, this.opts.events);
      iterationIndex = reloaded?.iterations ?? 0;
    } catch (err) {
      console.error(JSON.stringify({
        level: 'warn',
        event: 'autonomy.goal_reload_failed',
        message: toErrorMessage(err),
        context: { goalPath: this.goalPath },
        timestamp: new Date().toISOString(),
      }));
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
      this.stopRequested = true;
      return true;
    }
    // Goal-clear detection — model emits `[goal clear]` equivalent to
    // `/goal clear`. Treat as a manual stop: remove the goal file and fire
    // onEternalStop so the REPL knows to return to normal mode.
    if (GOAL_CLEAR_MARKER.test(finalText)) {
      await this.clearGoalManually(finalText);
      this.stopRequested = true;
      return true;
    }

    // ── Progress tracking ──
    // Parse [PROGRESS: N%] from the agent's final text and persist it.
    // Also auto-complete the goal when the agent reports 100% progress.
    const parsed = parseProgressFromText(finalText);
    if (parsed) {
      await this.updateProgress(parsed.progress, parsed.note);
      if (parsed.progress >= 100) {
        // Agent claims 100% — add a final journal entry and complete.
        await this.markGoalCompleted(
          { source: action.source, task: action.task, directive: action.directive },
          `progress reached 100%: ${parsed.note ?? 'goal complete'}`,
        );
        this.stopRequested = true;
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

    const cadence = this.opts.compactEveryNIterations ?? 25;
    const threshold = this.opts.aggressiveCompactRatio ?? 0.85;
    const maxCtx = this.opts.maxContextTokens;

    let aggressive = false;
    let shouldRun = false;

    if (this.iterationsSinceCompact >= cadence) {
      shouldRun = true;
    }

    if (maxCtx && maxCtx > 0) {
      const used = ctx.tokenCounter?.currentRequestTokens?.();
      if (used) {
        const total = used.input + used.cacheRead;
        if (total / maxCtx >= threshold) {
          shouldRun = true;
          aggressive = true;
        }
      }
    }

    if (!shouldRun) return;

    const report = await compactor.compact(ctx, { aggressive });
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
      if (gitTask) {
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
          this.stopRequested = true;
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
    let out: string;
    try {
      out = await (this.opts.gitStatusReader?.() ?? this.readGitStatus());
    } catch {
      return null;
    }
    const dirty = out.trim();
    if (!dirty) return null;
    // Surface a concise prompt — the agent will look at the diff itself.
    const lines = dirty.split('\n').slice(0, 8);
    const preview = lines.join(', ');
    return `Inspect the dirty working tree and either finish the in-progress work or revert it. Files: ${preview}`;
  }

  private async readGitStatus(): Promise<string> {
    const { stdout } = await execFileP('git', ['status', '--porcelain'], {
      cwd: this.opts.projectRoot,
      timeout: 5_000,
    });
    return stdout;
  }

  private async brainstormTask(goal: GoalFile): Promise<string | null | typeof BRAINSTORM_DONE> {
    const lastFew = goal.journal
      .slice(-5)
      .map((e) => `  - [${e.status}] ${e.task}`)
      .join('\n');
    const directive = [
      'You are deciding the next action in an autonomous loop pursuing a long-running goal.',
      '',
      `Goal: ${goal.goal}`,
      '',
      lastFew ? `Recent iterations:\n${lastFew}` : 'No prior iterations yet.',
      '',
      'Output ONE concrete, immediately-actionable task that advances the goal.',
      'Constraints:',
      '- One sentence, imperative form, under 200 chars.',
      '- No preamble, no explanation, no markdown — just the task line.',
      '- If recent iterations show repeated failures on the same target, pivot.',
      '- If the goal appears fully accomplished AND you can name a concrete',
      '  artifact / test / output that proves it, output exactly: DONE',
      '- Be conservative with DONE: if the recent journal contains failures',
      '  or aborted entries, the goal is almost certainly NOT done.',
    ].join('\n');

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const result = await this.opts.agent.run(
          [{ type: 'text' as const, text: directive }],
          { signal: ctrl.signal, maxIterations: 1 },
        );
        if (result.status !== 'done') return null;
        const text = (result.finalText ?? '').trim();
        if (!text) return null;
        // Distinct sentinel for DONE so the caller can count consecutive
        // DONE answers toward a real stop. The old `return null` path
        // conflated "no work" with "engine failure" and looped forever.
        if (/^DONE\.?$/i.test(text)) return BRAINSTORM_DONE;
        // Take the first non-empty line and clip to 240 chars.
        const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim();
        if (!firstLine) return null;
        if (/^DONE\.?$/i.test(firstLine)) return BRAINSTORM_DONE;
        return firstLine.slice(0, 240);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: 'warn',
        event: 'autonomy.brainstorm_failed',
        message: toErrorMessage(err),
        context: { goal: goal.goal.slice(0, 100) },
        timestamp: new Date().toISOString(),
      }));
      return null;
    }
  }

  private buildDirective(goal: GoalFile, source: JournalEntry['source'], task: string): string {
    const recentJournal = goal.journal
      .slice(-5)
      .map((e) => `  #${e.iteration} [${e.status}] ${e.task}${e.note ? ` — ${e.note.slice(0, 80)}` : ''}`)
      .join('\n');
    return [
      '═══ ETERNAL AUTONOMY — iteration directive ═══',
      '',
      `Mission: ${goal.goal}`,
      `Iteration: #${goal.iterations + 1}`,
      `Source: ${source}`,
      `Task: ${task}`,
      '',
      recentJournal ? `Recent journal (last 5):\n${recentJournal}` : 'No prior iterations.',
      '',
      '── EXECUTION PROTOCOL ──',
      'You are inside a long-running autonomous loop. Each iteration you',
      'execute ONE concrete task that advances the Mission. No user is',
      'available to clarify — make defensible decisions and move forward.',
      '',
      '1. EXECUTE END-TO-END',
      '   • Use multiple tool calls freely. Emit `[continue]` on its own line',
      '     to chain to the next internal step without returning.',
      '   • When this iteration\'s Task is finished (real artifact / passing',
      '     test / applied diff / clean output), emit `[done]` on its own line.',
      '   • Do not stop on the first obstacle — try at least 3 distinct',
      '     approaches before giving up. YOLO is active for normal project work;',
      '     destructive-gated confirmations still belong to the permission flow.',
      '',
      '2. UPDATE TODO STATE (when Source is `todo`)',
      '   • Mark this todo `in_progress` via the todos tool before tool work.',
      '   • Mark it `completed` on success, with a one-line outcome note.',
      '   • If you cannot make progress after 2 distinct attempts, mark it',
      '     `cancelled` with the obstacle. The loop will skip it next time.',
      '',
      '3. MISSION-COMPLETE PROTOCOL',
      '   • If — and ONLY if — the OVERALL Mission (not just this Task) is',
      '     verifiably accomplished, emit on its own line:',
      '         [GOAL_COMPLETE]',
      '     followed by a one-paragraph verification recipe (artifact path,',
      '     test command, or 10-second reproduction). This halts the loop.',
      '   • NEVER emit [GOAL_COMPLETE] on optimism, partial progress, or',
      '     "looks fine". Required: a concrete artifact that proves it AND',
      '     no recent journal failures contradicting completion.',
      '   • If unsure, emit `[done]` instead and let the next iteration',
      '     decide. The loop is patient; false completion is not.',
      '',
      '4. NO INTERACTIVITY',
      '   • Do not ask questions, do not request confirmation, do not propose',
      '     options. Pick the best path and execute. The user is asleep.',
    ].join('\n');
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
    const current = await loadGoal(this.goalPath, this.opts.events);
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
    const current = await loadGoal(this.goalPath, this.opts.events);
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
    const current = await loadGoal(this.goalPath, this.opts.events);
    if (!current) return;
    if (current.goalState === 'completed') return;
    const withFlag: GoalFile = { ...current, goalState: 'completed' };
    const withEntry = appendJournal(withFlag, {
      source: action.source,
      task: `MISSION COMPLETE — ${action.task}`.slice(0, 240),
      status: 'success',
      note: note.slice(0, 240),
    });
    await saveGoal(this.goalPath, withEntry, this.opts.events);
    // Fire stop callbacks so the REPL knows to exit eternal mode
    // and show a goal-completion banner. Without this the engine
    // stops internally but the REPL keeps spinning in the eternal loop.
    this.opts.onEternalStop?.();
  }

  /**
   * Manually clear the goal — equivalent to `/goal clear` typed by the user.
   * Sets goalState to `abandoned`, removes the goal file, and fires
   * `onEternalStop` so the REPL returns to normal mode.
   */
  private async clearGoalManually(note: string): Promise<void> {
    const current = await loadGoal(this.goalPath, this.opts.events);
    if (current) {
      const abandoned: GoalFile = { ...current, goalState: 'abandoned' };
      await saveGoal(this.goalPath, abandoned, this.opts.events);
    }
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.goalPath);
    } catch {
      // best-effort — file may already be gone
    }
    this.opts.onEternalStop?.();
    void this.appendIterationEntry({
      source: 'manual',
      task: 'goal cleared',
      status: 'success',
      note: note.slice(0, 240),
    });
  }

  private async appendFailure(task: string, note: string): Promise<void> {
    await this.appendIterationEntry({ source: 'manual', task, status: 'failure', note });
  }

  /**
   * Consult the brain on whether the goal is truly complete.
   * Without a brain, always returns true (use heuristic: DONE threshold met = done).
   */
  private async consultBrainForDone(goal: GoalFile): Promise<boolean> {
    if (!this.opts.brain) return true; // No brain — trust the heuristic

    const deliverablesStatus = goal.deliverables?.length
      ? `\nDeliverables: ${goal.deliverables.length} total, progress ${goal.progress ?? 'unknown'}%`
      : '';
    const recentJournal = goal.journal.slice(-5).map(e =>
      `  #${e.iteration} [${e.status}] ${e.task}`
    ).join('\n');

    try {
      const decision = await this.opts.brain.decide({
        id: `goal-done-${goal.iterations}`,
        sessionId: this.opts.agent.ctx.session?.id,
        source: 'system',
        question: `Brainstorm returned DONE ${this.consecutiveBrainstormDone}x. Is the goal truly complete?`,
        context: [
          `Goal: ${goal.goal}`,
          `Iterations: ${goal.iterations}`,
          `Progress: ${goal.progress ?? 'unknown'}%`,
          deliverablesStatus,
          recentJournal ? `\nRecent work:\n${recentJournal}` : '',
        ].join('\n'),
        risk: 'high',
        fallback: 'continue',
      });

      // Log the brain decision into the journal
      const summary = formatDecisionSummary(decision, {
        id: `goal-done-${goal.iterations}`,
        source: 'system',
        question: 'Is the goal complete?',
        risk: 'high',
        fallback: 'continue',
      });
      const rationale = 'rationale' in decision ? decision.rationale : undefined;
      await this.appendIterationEntry({
        source: 'brainstorm',
        task: summary,
        status: 'success',
        note: rationale,
      });

      if (decision.type === 'deny') {
        return false;
      }
      if (decision.type === 'answer') {
        const text = decision.text.toLowerCase();
        return text.includes('complete') || text.includes('done') || text.includes('yes');
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Persist a progress update from the agent's [PROGRESS: N%] output.
   */
  private async updateProgress(progress: number, note?: string): Promise<void> {
    const current = await loadGoal(this.goalPath, this.opts.events);
    if (!current) return;
    const updated = recordProgress(current, progress, note);
    await saveGoal(this.goalPath, updated, this.opts.events);
  }

  private async persistEngineState(state: GoalFile['engineState']): Promise<void> {
    const current = await loadGoal(this.goalPath, this.opts.events);
    if (!current) return;
    if (current.engineState === state) return;
    await saveGoal(this.goalPath, { ...current, engineState: state }, this.opts.events);
  }
}
