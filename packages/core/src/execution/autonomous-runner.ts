import type { Agent, RunResult } from '../core/agent.js';
import type { Context } from '../core/context.js';
import { toWrongStackError } from '../types/errors.js';
import type { Logger } from '../types/logger.js';
import type { DoneCondition } from '../types/multi-agent.js';
import { assertNever } from '../utils/assert-never.js';
import { compileUserRegex } from '../utils/regex-guard.js';

type AutonomousResult = RunResult & { toolCalls: number; reason?: string | undefined };

export interface DoneCheckResult {
  done: boolean;
  reason?: string | undefined;
  iterations: number;
  toolCalls: number;
}

export class DoneConditionChecker {
  private readonly compiledRegex: RegExp | null;
  private readonly logger: Logger | undefined;

  constructor(
    private readonly condition: DoneCondition,
    opts?: { logger?: Logger | undefined },
  ) {
    this.logger = opts?.logger;
    if (condition.type === 'output_match' && condition.pattern) {
      const result = compileUserRegex(condition.pattern, '');
      this.compiledRegex = result.ok ? result.regex : null;
      if (!result.ok) {
        // Log warning but don't throw — the done condition simply won't match
        if (this.logger) {
          this.logger.warn(
            'Done condition has invalid regex — will never match',
            { event: 'autonomous.done_condition_invalid_regex', pattern: condition.pattern, reason: result.reason },
          );
        } else {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'autonomous.done_condition_invalid_regex',
            pattern: condition.pattern,
            reason: result.reason,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    } else {
      this.compiledRegex = null;
    }
  }

  check(state: { iterations: number; toolCalls: number; lastOutput?: string | undefined }): DoneCheckResult {
    switch (this.condition.type) {
      case 'iterations':
        if (
          this.condition.maxIterations !== undefined &&
          state.iterations >= this.condition.maxIterations
        ) {
          return {
            done: true,
            reason: `max iterations (${this.condition.maxIterations}) reached`,
            ...state,
          };
        }
        break;

      case 'tool_calls':
        if (
          this.condition.maxToolCalls !== undefined &&
          state.toolCalls >= this.condition.maxToolCalls
        ) {
          return {
            done: true,
            reason: `max tool calls (${this.condition.maxToolCalls}) reached`,
            ...state,
          };
        }
        break;

      case 'output_match':
        if (this.compiledRegex && state.lastOutput && this.compiledRegex.test(state.lastOutput)) {
          return {
            done: true,
            reason: `output matched pattern "${this.condition.pattern}"`,
            ...state,
          };
        }
        break;

      case 'directive':
        // Model-driven: the agent manages its own continuation via [continue]/[done].
        // The done condition is never satisfied by the checker — the agent returns
        // `status: 'done'` when the model emits [done] or naturally finishes.
        // The runner's outer loop uses maxIterations/maxToolCalls as hard caps.
        if (
          this.condition.maxIterations !== undefined &&
          state.iterations >= this.condition.maxIterations
        ) {
          return { done: true, reason: `max iterations (${this.condition.maxIterations}) reached`, ...state };
        }
        if (
          this.condition.maxToolCalls !== undefined &&
          state.toolCalls >= this.condition.maxToolCalls
        ) {
          return { done: true, reason: `max tool calls (${this.condition.maxToolCalls}) reached`, ...state };
        }
        break;

      case 'all_tasks_done':
        // Coordinator-managed: completion is decided by the multi-agent
        // coordinator's pending-task queue, not by per-iteration state here.
        break;

      case 'custom':
        // Reserved for future extension
        break;
      default:
        return assertNever(this.condition.type);
    }

    return { done: false, iterations: state.iterations, toolCalls: state.toolCalls };
  }
}

export interface AutonomousRunnerOptions {
  agent: Agent;
  context: Context;
  doneCondition: DoneCondition;
  iterationTimeoutMs?: number | undefined;
  onIteration?: (state: { iteration: number | undefined; toolCalls: number }) => void;
  onDone?: (((result: AutonomousResult) => void)) | undefined;
  /**
   * When true and `doneCondition.type === 'directive'`, the runner
   * runs the agent with `autonomousContinue: true` so the agent loop
   * handles its own [continue]/[done] markers internally (no outer
   * re-invocation needed). The runner still provides iteration/timeouts.
   */
  enableAutonomousContinue?: boolean | undefined;
  /** Logger for structured warnings. Falls back to console.warn when omitted. */
  logger?: Logger | undefined;
}

export class AutonomousRunner {
  private iterations = 0;
  private toolCalls = 0;
  private lastOutput?: string | undefined;
  private stopped = false;
  private readonly doneChecker: DoneConditionChecker;

  constructor(private readonly opts: AutonomousRunnerOptions) {
    this.doneChecker = new DoneConditionChecker(opts.doneCondition, { logger: opts.logger });
  }

  async run(): Promise<AutonomousResult> {
    // Subscribe to `tool.executed` so the per-tool budget (`tool_calls`
    // done-condition) actually counts each tool invocation rather than
    // each `agent.run()` call. Without this, a single iteration that
    // fires 5 tools only bumps the counter once, and a `maxToolCalls: 3`
    // budget would fire after 3 iterations (typically 3×N tools) instead
    // of after 3 tools. Unsubscribed in the `finally` so the listener
    // doesn't outlive this run instance. Mock agents in tests may pass
    // null/undefined for `events`; gracefully skip when missing — those
    // tests don't exercise the tool-count budget path.
    const offToolExecuted = this.opts.agent.events?.on?.('tool.executed', () => {
      this.toolCalls++;
    });
    // When autonomous continue is enabled, also count internal agent-loop
    // iterations. Each iteration.started within a single agent.run() call
    // counts toward the runner's maxIterations cap. We listen to the event
    // through the agent's EventBus.
    const offIterationCompleted = this.opts.agent.events?.on?.('iteration.completed', () => {
      // Only count if we're in autonomous continue mode (agent loop
      // handles multiple iterations internally before returning).
      if (this.opts.enableAutonomousContinue && this.opts.doneCondition.type === 'directive') {
        // Each internal iteration completed — bump the outer iteration counter.
        // This ensures maxIterations on the runner actually limits total work.
        this.iterations++;
      }
    });
    try {
      return await this.runLoop();
    } finally {
      offToolExecuted?.();
      offIterationCompleted?.();
    }
  }

  private async runLoop(): Promise<AutonomousResult> {
    while (!this.stopped) {
      const check = this.doneChecker.check({
        iterations: this.iterations,
        toolCalls: this.toolCalls,
        lastOutput: this.lastOutput,
      });

      if (check.done) {
        const result: AutonomousResult = {
          status: 'done',
          iterations: this.iterations,
          toolCalls: this.toolCalls,
          reason: check.reason,
        };
        this.opts.onDone?.(result);
        return result;
      }

      this.opts.onIteration?.({ iteration: this.iterations, toolCalls: this.toolCalls });

      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), this.opts.iterationTimeoutMs ?? 30_000);

      try {
        // In directive mode with autonomous continue, pass it through so the
        // agent loop handles its own [continue]/[done] markers internally.
        // The runner provides iteration caps and timeouts; the agent handles
        // the continuation decision within each agent.run() call.
        const isDirectiveMode =
          this.opts.doneCondition.type === 'directive' &&
          this.opts.enableAutonomousContinue;

        const result = await this.opts.agent.run('', {
          signal: ctrl.signal,
          maxIterations: isDirectiveMode ? (this.opts.doneCondition.maxIterations ?? 100) : 1,
          executionStrategy: 'sequential',
          autonomousContinue: isDirectiveMode ? true : undefined,
        });

        // Only increment iterations if we're NOT counting via iteration.completed
        // (i.e., not in autonomous continue directive mode). In that mode,
        // the offIterationCompleted listener in run() bumps this counter
        // per internal iteration so the runner's maxIterations cap is respected.
        if (!isDirectiveMode) this.iterations++;
        // Only access finalText when the run actually succeeded. Failed/aborted
        // runs may have undefined finalText — accessing it unconditionally would
        // produce garbage output for the done-condition matchers.
        if (result.status === 'done') {
          this.lastOutput = result.finalText;
        }
        // `toolCalls` is bumped by the `tool.executed` listener installed
        // in run() — no manual increment here.

        if (result.status === 'failed' || result.status === 'aborted') {
          const failedResult: AutonomousResult = {
            status: result.status,
            error: result.error,
            iterations: this.iterations,
            toolCalls: this.toolCalls,
          };
          this.opts.onDone?.(failedResult);
          return failedResult;
        }
      } catch (e) {
        // Be precise about what constitutes a timeout error — matching on
        // 'timeout' substring is too loose (an error message containing
        // "timeout exceeded" from the LLM is not the same as an abort).
        const isAbort =
          (e instanceof DOMException && e.name === 'AbortError') ||
          (e instanceof Error && e.name === 'AbortError') ||
          (e instanceof Error && e.message.includes('iteration timeout'));
        if (isAbort) {
          const timeoutResult: AutonomousResult = {
            status: 'failed',
            error: toWrongStackError(e),
            iterations: this.iterations,
            toolCalls: this.toolCalls,
            reason: 'iteration timeout',
          };
          this.opts.onDone?.(timeoutResult);
          return timeoutResult;
        }
        // Any other throw (TypeError, tool crash propagation, etc.) must
        // stop the loop — silently continuing would spin forever on the
        // same error and burn provider tokens with no progress.
        this.stopped = true;
        const failedResult: AutonomousResult = {
          status: 'failed',
          error: toWrongStackError(e),
          iterations: this.iterations,
          toolCalls: this.toolCalls,
          reason: e instanceof Error ? e.message : String(e),
        };
        this.opts.onDone?.(failedResult);
        return failedResult;
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      status: 'aborted',
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      reason: 'stopped externally',
    };
  }

  stop(): void {
    this.stopped = true;
  }
}
