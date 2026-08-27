import { randomUUID } from 'node:crypto';
import type { AgentFactory } from '../coordination/agent-subagent-runner.js';
import {
  makeAgentSubagentRunner,
  withDisabledToolFiltering,
} from '../coordination/agent-subagent-runner.js';
import type { DispatchClassifier, DispatchResult } from '../coordination/dispatcher.js';
import { dispatchAgent } from '../coordination/dispatcher.js';
import { DefaultMultiAgentCoordinator } from '../coordination/multi-agent-coordinator.js';
import type { Agent } from '../core/agent.js';
import type { EventBus } from '../kernel/events.js';
import type { GoalFile, JournalEntry } from '../storage/goal-store.js';
import { appendJournal, goalFilePath, loadGoal, saveGoal } from '../storage/goal-store.js';
import type { Compactor } from '../types/compactor.js';
import type { Logger } from '../types/logger.js';
import type { MultiAgentConfig, SubagentConfig, TaskResult } from '../types/multi-agent.js';
import { toErrorMessage } from '../utils/error.js';
import { expectDefined } from '../utils/expect-defined.js';
import { sleep } from '../utils/sleep.js';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParallelEngineState = 'idle' | 'running' | 'stopped';

export type ParallelIterationStage =
  | { phase: 'idle' }
  | { phase: 'decompose' }
  | { phase: 'fanout'; slots: number }
  | { phase: 'await'; taskIds: string[] }
  | {
      phase: 'aggregate';
      successCount: number;
      total: number;
      goalComplete: boolean;
    }
  | { phase: 'sleep'; ms: number }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };

export interface ParallelEternalOptions {
  /** The coordinating agent — NOT a subagent. Owns container/tools/providers. */
  agent: Agent;
  /** Project root (used for goal.json path). */
  projectRoot: string;
  /**
   * Override the resolved goal.json path. Defaults to
   * `goalFilePath(projectRoot)` — the canonical per-project goal file under
   * `~/.wrongstack/projects/<slug>/`, shared with `/goal` and the TUI.
   * Primarily for tests that want an isolated goal file under a temp dir.
   */
  goalPath?: string | undefined;
  /**
   * Number of parallel subagent slots per tick.
   * Default: 4. Range 1–16; values >8 are for high-throughput machines.
   */
  parallelSlots?: number | undefined;
  /** Per-subagent default timeout in ms. Default: 300_000 (5 min). */
  iterationTimeoutMs?: number | undefined;
  onIteration?: ((entry: JournalEntry) => void) | undefined;
  onError?: (err: Error | undefined, iteration: number) => void;
  /** Per-tick phase notifications for live UI/status updates. */
  onStage?: ((stage: ParallelIterationStage) => void) | undefined;
  gitStatusReader?: (() => Promise<string>) | undefined;
  now?: (() => Date) | undefined;
  compactor?: Compactor | undefined;
  compactEveryNIterations?: number | undefined;
  aggressiveCompactRatio?: number | undefined;
  maxContextTokens?: number | undefined;
  /** Override the default agent factory (uses main agent if not provided). */
  subagentFactory?: AgentFactory | undefined;
  /**
   * Route each decomposed slot task to the best-fit catalog agent via the
   * smart dispatcher (heuristic keyword scoring). When enabled (default), each
   * slot spawns in-role — the role's budget tier applies and a persona line is
   * injected into the task — instead of as a faceless generic worker. Set
   * false to keep the legacy generic spawn.
   */
  dispatch?: boolean | undefined;
  /**
   * Optional LLM fallback for ambiguous tasks. Passed straight to
   * `dispatchAgent`; when omitted, routing is pure heuristic (instant, no
   * provider call — preferred for a continuously-ticking autonomous loop).
   */
  dispatchClassifier?: DispatchClassifier | undefined;
  /** Optional EventBus for emitting storage.* observability events from goal I/O. */
  events?: EventBus | undefined;
  /** Logger for structured errors. Falls back to console.error when omitted. */
  logger?: Logger | undefined;
}

const GOAL_COMPLETE_MARKER = /^\s*\[goal[_\s-]?complete\]\s*$/im;

// ---------------------------------------------------------------------------
// ParallelEternalEngine
// ---------------------------------------------------------------------------

/**
 * Sense → Decide → Fan-out (4–8 parallel agents) → Aggregate → Loop.
 *
 * Each tick:
 *   1. Sense    — load goal, todos, git status
 *   2. Decide   — decompose goal into N parallel sub-tasks
 *   3. Fan-out  — spawn N subagents simultaneously, await all
 *   4. Aggregate — write journal, update todos, check [GOAL_COMPLETE]
 *   5. Loop     — continue until stop() or mission complete
 *
 * Uses DefaultMultiAgentCoordinator + AgentSubagentRunner for subagent lifecycle.
 */
export class ParallelEternalEngine {
  private state: ParallelEngineState = 'idle';
  private stopRequested = false;
  private iterationsSinceCompact = 0;
  private iterations = 0;
  private consecutiveFailures = 0;
  private readonly goalPath: string;
  private readonly slots: number;
  private readonly timeoutMs: number;
  private coordinator: DefaultMultiAgentCoordinator | null = null;
  private agentFactory: AgentFactory;
  private readonly dispatchEnabled: boolean;
  private readonly dispatchClassifier?: DispatchClassifier | undefined;

  constructor(private readonly opts: ParallelEternalOptions) {
    this.goalPath = opts.goalPath ?? goalFilePath(opts.projectRoot);
    this.slots = Math.min(16, Math.max(1, opts.parallelSlots ?? 4));
    this.timeoutMs = opts.iterationTimeoutMs ?? 300_000;
    this.dispatchEnabled = opts.dispatch !== false;
    this.dispatchClassifier = opts.dispatchClassifier;
    this.agentFactory =
      opts.subagentFactory ??
      (async (_config: SubagentConfig) => ({
        agent: this.opts.agent,
        events: this.opts.agent.events,
      }));
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

  get currentState(): ParallelEngineState {
    return this.state;
  }

  /**
   * Get the underlying coordinator for stats/monitoring.
   */
  getCoordinator(): DefaultMultiAgentCoordinator | null {
    return this.coordinator;
  }

  stop(): void {
    this.stopRequested = true;
    void this.persistState('stopped').catch((err) => {
      this.logError('Engine persist state failed', {
        event: 'engine.persist_state_failed',
        message: toErrorMessage(err),
        context: { expectedState: 'stopped' },
      });
    });
    this.state = 'stopped';
  }

  async prime(): Promise<void> {
    this.stopRequested = false;
    this.state = 'running';
    await this.persistState('running');
  }

  async run(): Promise<void> {
    this.state = 'running';
    await this.persistState('running');

    const config: MultiAgentConfig = {
      coordinatorId: `parallel-${randomUUID().slice(0, 8)}`,
      maxConcurrent: this.slots,
      doneCondition: { type: 'all_tasks_done' },
    };
    this.coordinator = new DefaultMultiAgentCoordinator(config, {
      sessionId: () => this.opts.agent.ctx.eventSessionId(),
    });
    // Wrap factory with disabled tool filtering to prevent subagents from
    // using the delegate tool (or any other disabledTools in their config)
    const filteredFactory = withDisabledToolFiltering(this.agentFactory);
    const runner = makeAgentSubagentRunner({ factory: filteredFactory });
    this.coordinator.setRunner?.(runner);

    try {
      while (!this.stopRequested) {
        try {
          await this.runOneIteration();
        } catch (err) {
          this.consecutiveFailures++;
          this.opts.onError?.(
            err instanceof Error ? err : new Error(String(err)),
            this.consecutiveFailures,
          );
          await this.appendFailure('engine error', toErrorMessage(err));
        }
        if (this.stopRequested) break;
        await sleep(2000);
      }
    } finally {
      this.state = 'stopped';
      await this.persistState('stopped').catch(() => {});
    }
  }

  /**
   * Execute one tick: decompose → fan-out → aggregate → compact.
   * Called by the REPL in its main loop (REPL drives, engine is stateless per tick).
   */
  async runOneIteration(): Promise<boolean> {
    const emit = (stage: ParallelIterationStage) => {
      this.opts.onStage?.(stage);
    };

    this.iterations++;

    const goal = await this.loadGoal();
    if (!goal) {
      this.stopRequested = true;
      emit({ phase: 'stopped' });
      return false;
    }
    if (goal.goalState !== 'active') {
      this.stopRequested = true;
      emit({ phase: 'stopped' });
      return false;
    }

    // Build coordinator on first tick.
    if (!this.coordinator) {
      const config: MultiAgentConfig = {
        coordinatorId: `parallel-${randomUUID().slice(0, 8)}`,
        maxConcurrent: this.slots,
        doneCondition: { type: 'all_tasks_done' },
      };
      this.coordinator = new DefaultMultiAgentCoordinator(config, {
        sessionId: () => this.opts.agent.ctx.eventSessionId(),
      });
      // Wrap factory with disabled tool filtering to prevent subagents from
      // using the delegate tool (or any other disabledTools in their config)
      const filteredFactory = withDisabledToolFiltering(this.agentFactory);
      const runner = makeAgentSubagentRunner({ factory: filteredFactory });
      this.coordinator.setRunner?.(runner);
    }

    emit({ phase: 'decompose' });
    const tasks = await this.decomposeGoal(goal);
    if (!tasks || tasks.length === 0) {
      // Nothing to do this tick. The run() loop paces idle iterations itself
      // (see its sleep), so a single runOneIteration() must return promptly.
      emit({ phase: 'sleep', ms: 2000 });
      return false;
    }

    emit({ phase: 'fanout', slots: Math.min(this.slots, tasks.length) });
    const fanOut = await this.fanOut(goal, tasks);
    this.iterationsSinceCompact++;

    const successCount = fanOut.results.filter((r) => r.status === 'success').length;
    const status: JournalEntry['status'] = fanOut.goalComplete
      ? 'success'
      : fanOut.allSuccessful
        ? 'success'
        : 'failure';
    const note = [
      `${successCount}/${fanOut.results.length} subagents succeeded`,
      fanOut.goalComplete ? '[GOAL_COMPLETE]' : '',
      fanOut.partialOutput ? `Output: ${fanOut.partialOutput.slice(0, 120)}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    // Surface routing in the journal: "role→task-snippet" per slot so /goal
    // journal shows which agent handled what.
    const routeSummary =
      fanOut.routes.length > 0
        ? fanOut.routes
            .slice(0, 3)
            .map((r) => `${r.role}→${r.task.slice(0, 28)}`)
            .join(', ')
        : tasks.slice(0, 3).join(', ');
    await this.appendIterationEntry({
      source: 'parallel',
      task: `parallel:${tasks.length} slots — ${routeSummary}${tasks.length > 3 ? '...' : ''}`,
      status,
      note,
    });
    emit({
      phase: 'aggregate',
      successCount,
      total: fanOut.results.length,
      goalComplete: fanOut.goalComplete,
    });

    if (fanOut.goalComplete) {
      this.stopRequested = true;
      this.state = 'stopped';
      emit({ phase: 'stopped' });
      return true;
    }

    await this.maybeCompact();
    emit({ phase: 'sleep', ms: 2000 });
    return fanOut.allSuccessful;
  }

  // -------------------------------------------------------------------------
  // Fan-out
  // -------------------------------------------------------------------------

  private async fanOut(
    goal: GoalFile,
    tasks: string[],
  ): Promise<{
    results: TaskResult[];
    allSuccessful: boolean;
    goalComplete: boolean;
    partialOutput: string;
    routes: Array<{ slot: number; task: string; role: string; method: string }>;
  }> {
    const coordinator = expectDefined(this.coordinator);
    const slotCount = Math.min(this.slots, tasks.length);

    // Route each slot task to the best-fit catalog agent. Heuristic by default
    // (instant, no provider call); an injected classifier enables LLM fallback.
    // A dispatch failure for one slot is non-fatal — that slot stays generic.
    const routes: (DispatchResult | null)[] = this.dispatchEnabled
      ? await Promise.all(
          tasks
            .slice(0, slotCount)
            .map((t) =>
              dispatchAgent(t, { classifier: this.dispatchClassifier }).catch(() => null),
            ),
        )
      : [];

    const recentJournal = goal.journal
      .slice(-5)
      .map(
        (e) =>
          `  #${e.iteration} [${e.status}] ${e.task}${e.note ? ` — ${e.note.slice(0, 80)}` : ''}`,
      )
      .join('\n');

    const directivePreamble = [
      '═══ ETERNAL AUTONOMY — parallel task slot ═══',
      '',
      `Mission: ${goal.goal}`,
      `Total parallel slots: ${slotCount}`,
      '',
      recentJournal ? `Recent journal (last 5):\n${recentJournal}` : 'No prior iterations.',
      '',
      '── EXECUTION PROTOCOL ──',
      '• Execute the assigned task end-to-end using multiple tool calls.',
      '• Emit `[done]` on its own line when the task is complete.',
      '• Do not ask before tool use — YOLO is active unless an explicit deny rule blocks the call.',
      '• If the overall Mission is accomplished, emit `[GOAL_COMPLETE]` followed by a verification recipe.',
      '• Keep output concise — summarize findings, do not transcribe files.',
    ].join('\n');

    const taskIds: string[] = [];
    const subagentIds: string[] = [];
    const routeInfo: Array<{ slot: number; task: string; role: string; method: string }> = [];

    const spawnPromises: Array<Promise<void>> = [];
    for (let i = 0; i < slotCount; i++) {
      const task = expectDefined(tasks[i]);
      const route = routes[i] ?? null;
      const subagentId = `parallel-${this.iterations}-${i}`;
      const taskId = randomUUID();

      // Persona injection — works even with the default factory (which reuses
      // the shared main agent and ignores config.prompt/tools), so the agent
      // adopts the routed role's stance for this slot.
      const personaLine = route
        ? `Acting agent: ${route.definition.config.name} — ${route.definition.capability.summary}\n`
        : '';
      const spec = {
        id: taskId,
        description: `${directivePreamble}\n\n── SLOT ${i + 1}/${slotCount} ──\n${personaLine}Task: ${task}\n`,
        subagentId,
      };

      routeInfo.push({
        slot: i,
        task,
        role: route?.role ?? 'generic',
        method: route?.method ?? 'none',
      });

      spawnPromises.push(
        (async () => {
          try {
            // Spawn in-role when routed: `role` lets applyRosterBudget resolve the
            // role's budget tier; name/tools/systemPromptOverride specialize the
            // worker if a real per-role factory is wired (forward-compatible).
            await coordinator.spawn(
              route
                ? {
                    id: subagentId,
                    name: route.definition.config.name,
                    role: route.role,
                    tools: route.definition.config.tools,
                    systemPromptOverride: route.definition.config.prompt,
                    timeoutMs: this.timeoutMs,
                    // Disable delegation — subagents are leaf workers, not orchestrators
                    disabledTools: ['delegate'],
                  }
                : {
                    id: subagentId,
                    name: `slot-${subagentId.slice(-6)}`,
                    // Let the coordinator apply its default budget (roster or generic).
                    // Hardcoding low limits here defeats the x10 budget improvement.
                    timeoutMs: this.timeoutMs,
                    // Disable delegation — subagents are leaf workers, not orchestrators
                    disabledTools: ['delegate'],
                  },
            );
            subagentIds.push(subagentId);
            taskIds.push(taskId);
            await coordinator.assign(spec);
          } catch (err) {
            this.logError('Parallel spawn failed', {
              event: 'parallel_engine.spawn_failed',
              message: toErrorMessage(err),
              context: { slot: i, task, subagentId },
            });
          }
        })(),
      );
    }
    await Promise.all(spawnPromises);

    if (taskIds.length === 0) {
      return {
        results: [],
        allSuccessful: false,
        goalComplete: false,
        partialOutput: '',
        routes: routeInfo,
      };
    }

    this.opts.onStage?.({ phase: 'await', taskIds: [...taskIds] });

    let results: TaskResult[] = [];
    try {
      // Wait up to 2 hours for subagents to complete. This should cover
      // most subagent tasks since the roster budgets go up to 10 hours.
      // The outer eternal loop manages actual iteration limits.
      //
      // Passed as an explicit per-call timeout: awaitTasks otherwise caps at
      // coordinator.config.timeoutMs (300s default), which would cut a
      // legitimately long subagent short of this window. (The previous
      // AbortController here was dead — awaitTasks takes no signal.)
      results = await coordinator.awaitTasks(taskIds, {
        timeoutMs: Math.max(this.timeoutMs * 2, 7200_000),
      });
    } catch (err) {
      this.logError('Brainstorm results failed', {
        event: 'parallel_engine.brainstorm_results_failed',
        message: toErrorMessage(err),
        context: { slotCount, taskIds },
      });
      results = coordinator.results().slice(-taskIds.length);
    }

    // Free each per-tick subagent now that its task has resolved. Without this,
    // an eternal-parallel run accumulates dead subagent entries (and their
    // nickname slots) in the coordinator forever — a slow but unbounded leak
    // over multi-day loops. remove() is idempotent and non-throwing per id.
    await Promise.allSettled(subagentIds.map((id) => coordinator.remove(id)));

    const allSuccessful = results.length > 0 && results.every((r) => r.status === 'success');
    const goalComplete = results.some(
      (r) =>
        r.status === 'success' &&
        typeof r.result === 'string' &&
        GOAL_COMPLETE_MARKER.test(r.result),
    );
    const partialOutput = results
      .map((r) => (typeof r.result === 'string' ? r.result : ''))
      .filter(Boolean)
      .join('\n\n');

    return { results, allSuccessful, goalComplete, partialOutput, routes: routeInfo };
  }

  // -------------------------------------------------------------------------
  // Goal decomposition
  // -------------------------------------------------------------------------

  private async decomposeGoal(goal: GoalFile): Promise<string[] | null> {
    // Strategy 1: pending todos as sub-tasks
    const todos = this.opts.agent.ctx?.todos;
    const tasks: string[] = [];
    if (Array.isArray(todos)) {
      const pending = todos.filter((t) => t.status === 'pending').slice(0, this.slots);
      for (const t of pending) {
        tasks.push(`[todo] ${t.content}`);
      }
    }

    // Strategy 2: git dirty files
    if (tasks.length < this.slots) {
      try {
        const gitStatus = await (this.opts.gitStatusReader?.() ?? this.readGitStatus());
        const dirty = gitStatus.trim();
        if (dirty) {
          const lines = dirty.split('\n').slice(0, this.slots - tasks.length);
          for (const line of lines) {
            const file = line.replace(/^[ MADRUC?]{2}\s*/, '').trim();
            if (file) tasks.push(`[git] inspect and fix: ${file}`);
          }
        }
      } catch (err) {
        this.logError('Git status failed', {
          event: 'parallel_engine.git_status_failed',
          message: toErrorMessage(err),
          context: { projectRoot: this.opts.projectRoot },
        });
      }
    }

    // Strategy 3: leader-brainstormed sub-tasks for remaining slots
    if (tasks.length < this.slots) {
      const remaining = this.slots - tasks.length;
      const brainstormed = await this.brainstormSubtasks(goal, remaining);
      tasks.push(...brainstormed);
    }

    return tasks.length > 0 ? tasks.slice(0, this.slots) : null;
  }

  private async readGitStatus(): Promise<string> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileP = promisify(execFile);
    const { stdout } = await execFileP('git', ['status', '--porcelain'], {
      cwd: this.opts.projectRoot,
      timeout: 5_000,
    });
    return stdout;
  }

  private async brainstormSubtasks(goal: GoalFile, count: number): Promise<string[]> {
    const lastFew = goal.journal
      .slice(-5)
      .map((e) => `  - [${e.status}] ${e.task}`)
      .join('\n');
    const directive = [
      `Decompose this goal into exactly ${count} independent sub-tasks for parallel execution.`,
      '',
      `Goal: ${goal.goal}`,
      '',
      lastFew ? `Recent:\n${lastFew}` : 'No prior iterations.',
      '',
      `Output exactly ${count} tasks, one per line, under 120 chars each.`,
      'Format: TASK-1 | TASK-2 | ... (pipe-separated, no numbering, no preamble).',
      'Each task must be independently actionable with no shared dependencies.',
    ].join('\n');

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const result = await this.opts.agent.run([{ type: 'text' as const, text: directive }], {
          signal: ctrl.signal,
          maxIterations: 1,
        });
        if (result.status !== 'done') return [];
        const text = (result.finalText ?? '').trim();
        if (!text) return [];
        const tasks = text
          .split('|')
          .map((t) => t.trim())
          .filter((t) => t.length > 10 && t.length < 240);
        return tasks.slice(0, count);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // The leader agent failed to brainstorm. Surface it to onError so the
      // failure is visible, but keep the loop alive (return no tasks — the
      // next tick retries) rather than crashing the autonomous engine.
      this.opts.onError?.(
        err instanceof Error ? err : new Error(String(err)),
        this.consecutiveFailures,
      );
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  private async maybeCompact(): Promise<void> {
    const compactor = this.opts.compactor;
    if (!compactor) return;
    const ctx = this.opts.agent.ctx;
    if (!ctx) return;

    const shouldRun = this.iterationsSinceCompact >= (this.opts.compactEveryNIterations ?? 25);
    if (!shouldRun) return;

    const report = await compactor.compact(ctx, { aggressive: false });
    this.iterationsSinceCompact = 0;
    await this.appendIterationEntry({
      source: 'manual',
      task: 'compaction (cadence)',
      status: 'success',
      note: `saved ~${report.before - report.after} tokens`,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async appendIterationEntry(entry: Omit<JournalEntry, 'iteration' | 'at'>): Promise<void> {
    const current = await this.loadGoal();
    if (!current) return;
    const updated = appendJournal(current, entry);
    await saveGoal(this.goalPath, updated, this.opts.events);
    const entryWithMeta: JournalEntry = {
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      iteration: updated.iterations,
      ...entry,
    };
    this.opts.onIteration?.(entryWithMeta);
  }

  private async appendFailure(task: string, note: string): Promise<void> {
    await this.appendIterationEntry({ source: 'manual', task, status: 'failure', note });
  }

  private async persistState(state: GoalFile['engineState']): Promise<void> {
    const current = await this.loadGoal();
    if (!current) return;
    if (current.engineState === state) return;
    await saveGoal(this.goalPath, { ...current, engineState: state }, this.opts.events);
  }
}
