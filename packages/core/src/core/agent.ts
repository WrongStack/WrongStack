import { ExtensionRegistry } from '../extension/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import { createAgentToolHandler, type AgentToolHandler } from './agent-tools.js';
import { createAgentResponseHandler, type AgentResponseHandler } from './agent-response.js';
import { createAgentLoopHandler, signalAbortReason, type AgentLoopHandler } from './agent-loop.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ErrorHandler } from '../types/error-handler.js';
import { AgentError, toWrongStackError } from '../types/errors.js';
import type { Logger } from '../types/logger.js';
import type { Tracer } from '../types/observability.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { Plugin, PluginAPI } from '../types/plugin.js';
import type { Renderer } from '../types/renderer.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { Tool } from '../types/tool.js';
import type { ToolExecutorLike } from '../types/tool-executor.js';
import {
  DEFAULT_MAX_ITERATIONS,
  normalizeInput,
  resolveLoopDetection,
  type ResolvedLoopDetectionConfig,
  type RunResult,
  type AgentInit,
  type AgentPipelines,
  type AgentInput,
} from './agent-types.js';
import type { Context, RunOptions } from './context.js';

// Re-export types and utilities from agent-types.ts for backward compatibility
export {
  DEFAULT_MAX_ITERATIONS,
  normalizeInput,
  createDefaultPipelines,
  resolveLoopDetection,
  type ResolvedLoopDetectionConfig,
  type RunResult,
  type AgentInit,
  type AgentPipelines,
  type UserInputPayload,
  type AgentInput,
  type ToolCallPipelinePayload,
} from './agent-types.js';

export class Agent {
  readonly container: Container;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly events: EventBus;
  readonly pipelines: AgentPipelines;
  readonly ctx: Context;
  /** Max agent-loop iterations per run. Mutable so the TUI `/settings` picker
   *  can apply a new value to the live session (takes effect next run). */
  maxIterations: number;
  readonly executionStrategy: 'parallel' | 'sequential' | 'smart';
  readonly perIterationOutputCapBytes: number;
  private readonly plugins: { plugin: Plugin; api: PluginAPI }[] = [];
  readonly toolExecutor: ToolExecutorLike;
  readonly autoExtendLimit: boolean;
  /** Resolved loop-detector settings (see `tools.loopDetection`). */
  readonly loopDetection: ResolvedLoopDetectionConfig;
  private readonly autonomousContinue: boolean;
  readonly tracer: Tracer | undefined;
  readonly extensions: ExtensionRegistry;
  private readonly _toolHandler: AgentToolHandler;
  private readonly _responseHandler: AgentResponseHandler;
  private readonly _loopHandler: AgentLoopHandler;
  private readonly _logger: Logger;

  /**
   * Guards against concurrent `run()` calls on the same Agent instance.
   * `run()` mutates shared state (`ctx.signal`, `ctx.messages`, token
   * bookkeeping, compaction state) and a second concurrent call would
   * interleave those mutations with the first, producing an invalid
   * conversation or racing abort signals.
   */
  private _runInProgress = false;

  constructor(init: AgentInit) {
    this.container = init.container;
    this.tools = init.tools;
    this.providers = init.providers;
    this.events = init.events;
    this.pipelines = init.pipelines;
    this.ctx = init.context;
    this.maxIterations = init.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.executionStrategy = init.executionStrategy ?? 'smart';
    this.perIterationOutputCapBytes = init.perIterationOutputCapBytes ?? 100_000;
    this.autoExtendLimit = init.autoExtendLimit ?? true;
    this.loopDetection = resolveLoopDetection(init.loopDetection);
    this.autonomousContinue = init.autonomousContinue ?? false;
    this.tracer = init.tracer;
    this.extensions = init.extensions ?? new ExtensionRegistry();
    // Create a child logger that auto-carries the session ID so every
    // log entry from provider calls, stream handling, and tool execution
    // is correlated to its session without any call-site plumbing.
    this._logger = this.container.resolve(TOKENS.Logger).child({ sessionId: this.ctx.session.id });
    this.extensions.setLogger(this._logger);
    this.toolExecutor = init.toolExecutor;
    this._toolHandler = createAgentToolHandler(this);
    this._responseHandler = createAgentResponseHandler(this);
    this._loopHandler = createAgentLoopHandler(this, {
      tools: this._toolHandler,
      response: this._responseHandler,
    });
  }

  get logger(): Logger {
    return this._logger;
  }
  get retry(): RetryPolicy {
    return this.container.resolve(TOKENS.RetryPolicy);
  }
  get errorHandler(): ErrorHandler {
    return this.container.resolve(TOKENS.ErrorHandler);
  }
  get permission(): PermissionPolicy {
    return this.container.resolve(TOKENS.PermissionPolicy);
  }
  get renderer(): Renderer | undefined {
    return this.container.safeResolve(TOKENS.Renderer);
  }

  disableInteractiveConfirmation(): void {
    this.toolExecutor.clearConfirmAwaiter();
    if (typeof this.permission.setPromptDelegate === 'function') {
      this.permission.setPromptDelegate(undefined);
    }
  }

  register(tool: Tool): void {
    this.tools.register(tool);
  }

  async use(plugin: Plugin, api: PluginAPI): Promise<void> {
    await plugin.setup(api);
    this.plugins.push({ plugin, api });
  }

  async teardown(): Promise<void> {
    const errors: unknown[] = [];
    for (const { plugin, api } of this.plugins.toReversed()) {
      if (typeof plugin.teardown !== 'function') continue;
      try {
        await plugin.teardown(api);
      } catch (err) {
        errors.push(err);
      }
    }
    this.plugins.length = 0;
    // Drain agent-lifetime hooks (mailbox heartbeat, awareness, HQ publisher,
    // auto-compaction) that persist across runs. Do this AFTER plugin teardown
    // so plugins can still interact with mailbox/HQ during their own shutdown.
    try {
      await this.ctx.drainAgentHooks();
    } catch {
      // best-effort — individual hook errors already swallowed by drainAgentHooks
    }
    if (errors.length > 0) {
      throw new AgentError({
        message: `Agent teardown failed: ${errors.map(String).join('; ')}`,
        code: 'AGENT_RUN_FAILED',
        context: { failures: errors.length, phase: 'plugin-teardown' },
        // Preserve the FIRST underlying failure as the cause so consumers can
        // pull type/code off it via `instanceof` checks. The full list is
        // flattened into the message; we don't keep the array on the error
        // because WrongStackError.context is Record<string, unknown> and
        // arrays of unknown Errors would lose their structured fields.
        cause: errors[0],
      });
    }
  }

  async run(userInput: AgentInput, opts: RunOptions = {}): Promise<RunResult> {
    // Reject concurrent runs: shared mutable state (ctx.signal, messages,
    // session, token bookkeeping, compaction) would race between two
    // simultaneous runs.
    if (this._runInProgress) {
      throw new AgentError({
        message: 'Agent.run() is already in progress on this instance. Concurrent runs are not supported.',
        code: 'AGENT_RUN_FAILED',
        context: { phase: 'concurrency-guard' },
      });
    }
    this._runInProgress = true;
    const controller = new RunController({ parentSignal: opts.signal });
    const signal = controller.signal;
    this.ctx.signal = signal;
    controller.onAbort(() => this.ctx.drainAbortHooks());
    // Abort durability: drain the buffered session writer the moment the run
    // is cancelled. The loop's `finally` clears the in-flight marker, but the
    // buffered JSONL events would otherwise sit in memory until the next
    // periodic flush — a hard exit right after Ctrl+C would lose them.
    controller.onAbort(async () => {
      await this.ctx.session.flush().catch(() => {
        /* best-effort — close()/checkpoint flush remains the backstop */
      });
    });

    // Refresh the live context's tool mirror from the registry. The provider
    // request reads `this.tools.list()` directly, but `ctx.tools` is a separate
    // convenience snapshot — the one tools introspect (tool_search, tool-help,
    // vision adapters) and request-token estimation reads. The Context is
    // constructed before MCP / plugin / fleet tools register, so without this
    // refresh `ctx.tools` stays empty and tool_search reports zero tools.
    // Using the agent's own registry keeps filtered subagent rosters correct.
    this.ctx.tools = this.tools.list();

    const span = this.tracer?.startSpan('agent.run', {
      'agent.model': opts.model ?? this.ctx.model,
      'agent.executionStrategy': opts.executionStrategy ?? this.executionStrategy,
    });

    const { blocks, text } = normalizeInput(userInput);
    const inputPayload = { content: blocks, text, ctx: this.ctx };

    await this.extensions.runBeforeRun(this.ctx, inputPayload);
    const runStartedAt = Date.now();
    const runStartedIso = new Date(runStartedAt).toISOString();
    const sessionId = this.ctx.session.id;

    try {
      this.events.emit('agent.run.started', {
        sessionId,
        ctx: this.ctx,
        model: opts.model ?? this.ctx.model,
        at: runStartedIso,
      });
      const autonomousContinue = opts.autonomousContinue ?? this.autonomousContinue;
      const result = await this._loopHandler.runInner(inputPayload, opts, controller, autonomousContinue);
      span?.setAttribute('agent.status', result.status);
      span?.setAttribute('agent.iterations', result.iterations);
      await this.extensions.runAfterRun(this.ctx, result);
      this._emitRunCompleted(result, sessionId, runStartedAt);
      return result;
    } catch (err) {
      const wse = err instanceof AgentError ? err : toWrongStackError(err);
      const safeError = err instanceof Error
        ? new Error(err.message)
        : new Error(String(err));
      this.events.emit('error', {
        sessionId,
        err: safeError,
        phase: 'agent',
        _original: err instanceof Error ? err : undefined,
      });
      if (err instanceof Error) span?.recordError(err);
      span?.setAttribute('agent.status', 'failed');
      const result: RunResult = {
        status: signal.aborted ? 'aborted' : 'failed',
        iterations: 0,
        error: wse,
        abortReason: signal.aborted ? signalAbortReason(signal) : undefined,
      };
      // runAfterRun must fire before agent.run.error so extensions see the
      // failed result before the error event is emitted to other listeners.
      await this.extensions.runAfterRun(this.ctx, result);
      if (result.status === 'failed') {
        this.events.emit('agent.run.error', {
          sessionId,
          ctx: this.ctx,
          err: safeError,
          at: new Date().toISOString(),
          durationMs: Date.now() - runStartedAt,
        });
      }
      this._emitRunCompleted(result, sessionId, runStartedAt);
      return result;
    } finally {
      this._runInProgress = false;
      span?.end();
      await controller.dispose();
    }
  }

  /**
   * Emit the terminal `agent.run.completed` event. Extracted to eliminate
   * duplication between the try and catch blocks — adding a new field to
   * the event payload only needs one edit.
   */
  private _emitRunCompleted(
    result: RunResult,
    sessionId: string,
    runStartedAt: number,
  ): void {
    this.events.emit('agent.run.completed', {
      sessionId,
      ctx: this.ctx,
      status: result.status,
      iterations: result.iterations,
      at: new Date().toISOString(),
      durationMs: Date.now() - runStartedAt,
    });
  }

  // ── Tool + response execution handled by AgentToolHandler / AgentResponseHandler ──
}
