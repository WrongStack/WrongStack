import type { Agent, AgentInput, RunResult } from '../core/agent.js';
import type { EventBus } from '../kernel/events.js';
import { setBtwNote } from '../core/btw.js';
import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunOutcome,
  SubagentRunner,
  TaskSpec,
} from '../types/multi-agent.js';
import { AgentError, ERROR_CODES } from '../types/errors.js';
import {
  BudgetExceededError,
  BudgetThresholdSignal,
} from './subagent-budget.js';
import { resolveGracefulFinish } from './subagent-finish.js';
import type { FleetBus } from './fleet-bus.js';
import { readSubagentStructuredReport } from './subagent-result-tool.js';

/**
 * Caller-supplied factory that builds an isolated `Agent` for a subagent.
 * The factory MUST construct a fresh `Context` per call — sharing context
 * between subagents defeats isolation. Each Agent should also use either
 * its own `EventBus` or a forwarded view, so per-subagent metrics can be
 * attributed correctly.
 */
export type AgentFactory = (config: SubagentConfig, task?: TaskSpec) => Promise<AgentFactoryResult>;

/**
 * Wrap a factory to automatically filter out disabled tools from subagent
 * configurations. This provides mechanical enforcement of tool restrictions
 * (e.g., preventing delegation) in addition to the baseline prompt constraint.
 *
 * The wrapper reads `config.disabledTools` and removes those tools from the
 * agent's tool registry before returning.
 *
 * Usage:
 *   const filteredFactory = withDisabledToolFiltering(originalFactory);
 *   const runner = makeAgentSubagentRunner({ factory: filteredFactory });
 */
export function withDisabledToolFiltering(factory: AgentFactory): AgentFactory {
  return async (config: SubagentConfig, task?: TaskSpec) => {
    const result = await factory(config, task);
    const disabled = config.disabledTools ?? [];
    if (disabled.length === 0) return result;

    // Agent.tools is a ToolRegistry with unregister() method
    const registry = result.agent.tools;
    if (registry && typeof registry.unregister === 'function') {
      for (const toolName of disabled) {
        registry.unregister(toolName);
      }
    }
    return result;
  };
}

export interface AgentFactoryResult {
  agent: Agent;
  /** Event bus the factory wired to this agent — required for budget hookup. */
  events: EventBus;
  /**
   * Optional cleanup hook invoked in the runner's `finally` block once
   * the task ends (success, failure, abort — same exit path). Factories
   * that own resources scoped to a single task (per-subagent JSONL
   * writers, transient providers, throwaway containers) implement this
   * to close them deterministically instead of relying on GC. Errors
   * thrown here are swallowed so a flaky cleanup can't mask the task's
   * real result.
   */
  dispose?: ((() => Promise<void> | void)) | undefined;
}

export interface AgentRunnerOptions {
  factory: AgentFactory;
  /**
   * Format a TaskSpec into the user input the agent will receive. Defaults
   * to `task.description ?? ''`. Override when subagents expect structured
   * input (e.g. JSON contracts, role-prefixed prompts).
   */
  formatTaskInput?: (task: TaskSpec, config: SubagentConfig) => AgentInput;
  /**
   * When set, the runner attaches the subagent's EventBus to this FleetBus
   * on task start and detaches it when the task finishes. This is the
   * injection seam that lets the TUI fleet panel observe subagent activity
   * live — without it, FleetBus stays empty.
   */
  fleetBus?: FleetBus | undefined;
  /**
   * Optional parent bus for task-correlated worker telemetry. The worker keeps
   * its own EventBus for isolation; this explicit bridge forwards only the
   * tool/file channels needed by host observability surfaces.
   */
  hostEvents?: EventBus | undefined;
}

/**
 * Builds a `SubagentRunner` that drives a real `Agent` per task while honoring
 * the coordinator's budget and abort signal. This is the production adapter —
 * the coordinator's `runner` option in CLI/TUI assemblies points here.
 *
 * Lifecycle per task:
 *   1. factory(config) → fresh Agent + EventBus.
 *   2. Subscribe to events to feed the budget (tool calls, token usage).
 *   3. Call agent.run(input, { signal }) — the coordinator's signal cancels.
 *   4. Map RunResult.status onto a `SubagentRunOutcome` or throw on failure.
 *   5. Unsubscribe and let the factory's resources be GC'd.
 *
 * The budget is checked synchronously from event handlers — a runaway agent
 * that crosses its tool-call limit triggers `BudgetExceededError`, which the
 * coordinator surfaces as `status: 'failed'` on the task result.
 */
export function makeAgentSubagentRunner(opts: AgentRunnerOptions): SubagentRunner {
  const format = opts.formatTaskInput ?? defaultFormatTaskInput;

  return async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
    const taskStartedAt = Date.now();
    const factoryResult = await opts.factory(ctx.config, task);
    const { agent, events } = factoryResult;
    const taskContext = task.context ?? {};
    const hasExplicitTelemetryTask = typeof taskContext['telemetryTaskId'] === 'string';
    const telemetryTaskId = hasExplicitTelemetryTask
      ? (taskContext['telemetryTaskId'] as string)
      : task.id;
    const telemetryRunId =
      typeof taskContext['telemetryRunId'] === 'string'
        ? taskContext['telemetryRunId']
        : undefined;
    const telemetryBoardId =
      typeof taskContext['telemetryBoardId'] === 'string'
        ? taskContext['telemetryBoardId']
        : undefined;
    // Tool calls such as fleet_emit need authoritative caller/task attribution.
    // The Agent and Context are task-scoped, so this cannot leak into a later
    // assignment even when the coordinator reuses the same logical subagent.
    const agentContext = (
      agent as Agent & {
        ctx?: {
          meta?: Record<string, unknown>;
          setCurrentKanbanTask?: (taskId: string | undefined, boardId?: string) => void;
        };
      }
    ).ctx;
    if (agentContext?.meta) {
      agentContext.meta['subagentTaskId'] = task.id;
      const kanbanContext = taskContext['kanban'];
      if (kanbanContext && typeof kanbanContext === 'object') {
        agentContext.meta['kanban'] = kanbanContext;
      }
      if (hasExplicitTelemetryTask) {
        agentContext.meta['telemetryTaskId'] = telemetryTaskId;
        if (telemetryRunId) agentContext.meta['telemetryRunId'] = telemetryRunId;
      }
    }
    if (hasExplicitTelemetryTask) {
      agentContext?.setCurrentKanbanTask?.(telemetryTaskId, telemetryBoardId);
    } else {
      const kanbanContext = taskContext['kanban'];
      if (kanbanContext && typeof kanbanContext === 'object') {
        const kanban = kanbanContext as Record<string, unknown>;
        const boardId = typeof kanban['boardId'] === 'string' ? kanban['boardId'] : undefined;
        const taskId = typeof kanban['taskId'] === 'string' ? kanban['taskId'] : undefined;
        if (taskId) agentContext?.setCurrentKanbanTask?.(taskId, boardId);
      }
    }

    // Attach subagent EventBus to FleetBus so the TUI fleet panel (and any
    // other FleetBus subscriber) can observe this subagent live. Detach on
    // task finish — each task is a fresh Agent + EventBus, so we never
    // want a stale bus lingering after the run.
    const detachFleet = opts.fleetBus?.attach(ctx.subagentId, events, task.id);

    // Hook budget into the agent's event stream. We capture errors thrown by
    // recordToolCall/recordUsage so the budget can short-circuit the run by
    // aborting the controller — the agent then unwinds cooperatively.
    const aborter = new AbortController();
    // Inject the EventBus into the budget so it can emit budget.threshold_reached
    // events when a soft limit is hit and the handler wants to ask the coordinator.
    ctx.budget._events = events;
    // Wire the threshold-negotiation handler. Without this the soft-limit
    // path is dead code: every budget overrun becomes a hard
    // BudgetExceededError and the subagent dies on its first 120-iteration
    // tick instead of asking the Director for headroom. The Director's
    // FleetBus listener (director.ts) auto-grants +50% up to a per-kind
    // ceiling and per-subagent extension count — wiring this is the
    // missing link that activates that flow.
    ctx.budget.onThreshold = ({ requestDecision }) => requestDecision();
    let budgetError: Error | null = null;

    /**
     * Common error handler for all budget-triggered events. Distinguishes:
     *   - BudgetExceededError → hard stop, set budgetError + abort
     *   - BudgetThresholdSignal → soft stop: await the coordinator's
     *     decision. If 'stop', abort. If 'extend', the signal handler
     *     has already patched the budget so we can continue without
     *     actually aborting the agent.
     */
    const onBudgetError = (err: unknown): void => {
      if (err instanceof BudgetThresholdSignal) {
        // Defer the stop/extend decision to the post-finally block below.
        // The coordinator's verdict may arrive after agent.run() returns;
        // awaiting it there (rather than in this fire-and-forget handler)
        // avoids a race where both this callback and the post-finally
        // block try to mutate `budgetError` concurrently.
        budgetError = err;
        return;
      }
      // Hard stop (BudgetExceededError or other)
      aborter.abort();
      budgetError =
        err instanceof BudgetExceededError
          ? err
          : new BudgetExceededError(
              'tool_calls',
              0,
              0,
            );
      // Attach the real error detail so the task result surfaces
      // something actionable instead of a generic budget message.
      if (budgetError !== err && err instanceof Error) {
        budgetError.message += ` (caused by: ${err.message})`;
      }
    };

    // Track the name of the most recent tool that returned ok:false so
    // we can lift it into the SubagentError when the agent ends without
    // recovering. Cleared on every successful tool execution so a tool
    // that later succeeded doesn't taint the final report.
    let lastToolFailed: string | null = null;

    const unsub: Array<() => void> = [];
    unsub.push(
      events.on('tool.executed', (e) => {
        if (hasExplicitTelemetryTask) {
          opts.hostEvents?.emit('subagent.tool_executed', {
            sessionId: e.sessionId,
            subagentId: ctx.subagentId,
            agentSessionId: e.sessionId,
            agentName: e.agentName ?? ctx.config.name,
            taskId: telemetryTaskId,
            runId: telemetryRunId,
            traceId: e.traceId,
            id: e.id,
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            // Raw tool inputs may contain credentials or sensitive arguments.
            // Task telemetry crosses from the isolated worker bus to the shared
            // host bus, so expose only execution metadata at this boundary.
            outputBytes: e.outputBytes,
            outputTokens: e.outputTokens,
            outputLines: e.outputLines,
          });
        }
        // Count tool calls on the PAIRED 'tool.executed' event rather
        // than 'tool.started'. A tool can fire start then crash before
        // emitting executed (process killed, signal aborted mid-exec);
        // counting only the paired event keeps the budget tally honest
        // and matches what the model actually saw in its turn.
        try {
          ctx.budget.recordToolCall();
        } catch (eb) {
          onBudgetError(eb);
        }
        // Track ok:false so we can fail the subagent if it ends without
        // recovering. Successful runs clear it — the model may try a
        // tool, get an error, and self-heal on the next iteration; that
        // path should still report success.
        if (e.ok === false) {
          lastToolFailed = e.name;
        } else if (e.ok === true) {
          lastToolFailed = null;
        }
      }),
      events.on('file.event', (e) => {
        if (!hasExplicitTelemetryTask) return;
        // The fallback factory can reuse the host EventBus. Do not recursively
        // re-bridge the already-correlated copy on that shared-bus path.
        if (e.runId === telemetryRunId && e.taskId === telemetryTaskId) return;
        opts.hostEvents?.emit('file.event', {
          ...e,
          scope: 'task',
          taskId: telemetryTaskId,
          boardId: telemetryBoardId,
          runId: telemetryRunId,
        });
      }),
      events.on('provider.response', (e) => {
        try {
          ctx.budget.recordUsage(e.usage);
        } catch (e2) {
          void onBudgetError(e2);
        }
      }),
      events.on('iteration.started', () => {
        try {
          ctx.budget.recordIteration();
        } catch (e) {
          void onBudgetError(e);
        }
        // Emit a periodic progress snapshot every SUMMARY_INTERVAL
        // iterations so the leader can surface "AGENT#2 ● L25 · 47 tools"
        // in the main chat history without needing the FleetPanel open.
        const u = ctx.budget.usage();
        const since = u.iterations - lastSummaryAtIteration;
        if (since >= SUMMARY_INTERVAL) {
          lastSummaryAtIteration = u.iterations;
          events.emit('subagent.iteration_summary', {
            subagentId: ctx.subagentId,
            iteration: u.iterations,
            toolCalls: u.toolCalls,
            costUsd: u.costUsd,
            currentTool: currentToolName,
            partialText: streamingTextAcc.trim() || undefined,
          });
        }
      }),
      // D3: cooperative timeout enforcement DURING a long tool call.
      // The iteration-loop checkTimeout() only fires between agent
      // iterations — a single `bash sleep 3600` call would otherwise
      // park inside one tool execution while the timeout silently
      // passes, relying solely on the coordinator's hard Promise.race
      // to interrupt. Tools that emit `tool.progress` (bash chunks,
      // fetch byte progress, spawn-stream stdout) give us a heartbeat
      // we can hang the check on. When the budget trips here:
      //   1. onBudgetError sets budgetError + aborter.abort()
      //   2. aborter signal propagates to agent.run → tool executor
      //   3. tool's own signal listener kills the child process
      // Cheap: O(1) per progress event, and the budget short-circuits
      // when timeoutMs is unset (most subagents have one set anyway).
      events.on('tool.progress', () => {
        // Streamed progress (bash chunks, fetch bytes, spawn stdout) is forward
        // motion — reset the idle clock so a long-but-working tool is never
        // mistaken for a stall, THEN check whether a genuine timeout tripped.
        ctx.budget.markActivity();
        try {
          ctx.budget.checkTimeout();
        } catch (e) {
          void onBudgetError(e);
        }
      }),
    );

    // Track current tool name + streaming text for the periodic summary.
    let currentToolName: string | undefined;
    let streamingTextAcc = '';
    let lastSummaryAtIteration = 0;
    const SUMMARY_INTERVAL = 25;

    unsub.push(
      events.on('tool.started', (e) => {
        currentToolName = e.name;
      }),
      events.on('provider.text_delta', (e) => {
        // Streamed assistant text is forward motion too — keep the idle
        // clock fresh while the model is actively generating.
        ctx.budget.markActivity();
        // Accumulate last ~2000 chars for the partial text snapshot.
        streamingTextAcc = (streamingTextAcc + e.text).slice(-2000);
        const text = streamingTextAcc.trim();
        if (text) {
          ctx.reportProgress?.({ text, source: 'stream', capturedAt: Date.now() });
        }
      }),
    );

    // Forward the coordinator signal so stop() from outside also aborts.
    const onParentAbort = () => aborter.abort();
    ctx.signal.addEventListener('abort', onParentAbort);

    // In-band graceful finish (see coordination/subagent-finish.ts). When the
    // watchdog's deadline crossing or an explicit leader request fires
    // `subagent.finish_requested` on this subagent's bus, stash the notice as
    // a `/btw` note on the agent's live Context. The agent loop folds it into
    // the conversation at the TOP of its next iteration — between tool
    // batches, no abort, no restart — and the model completes its task in its
    // own turn. Legacy spawns (no `gracefulFinish`) never receive the event,
    // so this listener is dead weight only for opted-in subagents.
    if (resolveGracefulFinish(ctx.config)) {
      unsub.push(
        events.on('subagent.finish_requested', (e) => {
          if (e.subagentId && e.subagentId !== ctx.subagentId) return;
          setBtwNote(agent.ctx, e.notice);
        }),
      );
    }

    let result: RunResult;
    try {
      result = await agent.run(format(task, ctx.config), { signal: aborter.signal });
      const finalText = result.finalText?.trim();
      if (finalText) {
        ctx.reportProgress?.({ text: finalText, source: 'run_result', capturedAt: Date.now() });
      }
      // Emit task_completed BEFORE the finally block unsubscribes the
      // FleetBus — this lets the WebUI see the subagent's final output.
      events.emit('subagent.task_completed', {
        subagentId: ctx.subagentId,
        taskId: task.id,
        status: result.status === 'done' ? 'success' : 'failed',
        iterations: result.iterations,
        toolCalls: ctx.budget.usage().toolCalls,
        durationMs: Date.now() - taskStartedAt,
        finalText: result.finalText?.trim() || undefined,
      });
    } finally {
      detachFleet?.();
      ctx.signal.removeEventListener('abort', onParentAbort);
      for (const u of unsub) u();
      // Per-task resource cleanup. Closes JSONL writers, throwaway
      // providers, etc. that the factory wired up. Swallowed errors —
      // a flaky cleanup must not mask the real task result. The
      // caller can re-emit via observability if needed.
      if (factoryResult.dispose) {
        try {
          await factoryResult.dispose();
        } catch {
          // intentional swallow — see comment above
        }
      }
    }

    // A budget violation is the signal — surface it so the coordinator can
    // tag the task with the right failure kind ('failed' for budget; the
    // coordinator separately recognises 'timeout' from BudgetExceededError).
    if (budgetError) {
      // BudgetThresholdSignal: the soft limit was hit but the coordinator
      // hasn't resolved the extension decision yet. If the decision was
      // 'extend', the coordinator patched limits and the agent finished
      // normally — no error to surface. If 'stop', budgetError becomes
      // a BudgetExceededError thrown below.
      // instanceof check on Error subtypes requires 'any' intersection
      // on the union — use a property guard instead.
      if ('decision' in budgetError) {
        try {
          const decision = await (budgetError as BudgetThresholdSignal).decision;
          if (decision === 'stop') {
            budgetError = new BudgetExceededError(
              (budgetError as BudgetThresholdSignal).kind,
              (budgetError as BudgetThresholdSignal).limit,
              (budgetError as BudgetThresholdSignal).used,
            );
          } else {
            budgetError = null;
          }
        } catch {
          // Decision promise rejected — treat as hard stop.
          budgetError = new BudgetExceededError(
            (budgetError as BudgetThresholdSignal).kind,
            (budgetError as BudgetThresholdSignal).limit,
            (budgetError as BudgetThresholdSignal).used,
          );
        }
      }
      if (budgetError) throw budgetError;
    }

    if (result.status === 'failed') {
      throw result.error instanceof AgentError
        ? result.error
        : new AgentError({
            message: result.error instanceof Error ? result.error.message : String(result.error ?? 'agent failed'),
            code: ERROR_CODES.AGENT_RUN_FAILED,
            cause: result.error,
          });
    }
    // 'aborted' and 'max_iterations' aren't successes — let the coordinator
    // classify them. When the parent signal was aborted, coordinator marks
    // the task 'stopped' (matched against subagent.abortController.aborted).
    if (result.status === 'aborted') {
      throw new AgentError({
        message: 'agent aborted',
        code: ERROR_CODES.AGENT_ABORTED,
      });
    }
    if (result.status === 'max_iterations') {
      throw new AgentError({
        message: 'agent exhausted iteration limit',
        code: ERROR_CODES.AGENT_ITERATION_LIMIT,
        recoverable: true,
      });
    }

    const usage = ctx.budget.usage();
    // Empty-response guard. A "successful" run with no text AND no tool
    // calls is almost always a prompt / config issue, not a real
    // success — the agent burned an iteration to say nothing. Surface
    // it as a classified failure so callers can show "✗ empty_response"
    // instead of a confusing green ✓ with no output. We only trip on
    // the (no-text AND no-tools) intersection because text-less runs
    // with tool calls are legit (e.g. "run npm test then end_turn").
    const finalText = (result.finalText ?? '').trim();
    if (finalText.length === 0 && usage.toolCalls === 0) {
      throw new AgentError({
        message: 'empty response — agent produced no text and no tool calls',
        code: ERROR_CODES.AGENT_RUN_FAILED,
        context: { iterations: result.iterations },
      });
    }
    // Unrecovered-tool-failure guard. If the last executed tool came
    // back ok:false AND the agent ended its turn with no closing text,
    // the agent never acknowledged or recovered from the failure — the
    // task is effectively broken. A model that handles a tool error
    // emits SOME text on the next iteration ("the read failed, trying
    // an alternate path…") which clears `lastToolFailed`; the only way
    // both signals can be live at end-of-run is if the model gave up
    // silently. Surface as `tool_failed` so callers see the actual
    // failure mode instead of a clean ✓ with no output.
    if (finalText.length === 0 && lastToolFailed !== null) {
      throw new AgentError({
        message: `unrecovered tool failure: ${lastToolFailed} — agent ended turn without acknowledging the error`,
        code: ERROR_CODES.AGENT_RUN_FAILED,
        context: { tool: lastToolFailed, iterations: result.iterations },
      });
    }
    return {
      result: result.finalText,
      report: readSubagentStructuredReport(agentContext),
      iterations: result.iterations,
      toolCalls: usage.toolCalls,
    };
  };
}

function defaultFormatTaskInput(task: TaskSpec): AgentInput {
  return task.description ?? '';
}
