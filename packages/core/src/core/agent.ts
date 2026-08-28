import { createHash } from 'node:crypto';
import { ExtensionRegistry } from '../extension/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus } from '../kernel/events.js';
import { RunController } from '../kernel/run-controller.js';
import { TOKENS } from '../kernel/tokens.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ErrorHandler } from '../types/error-handler.js';
import { AgentError, toWrongStackError } from '../types/errors.js';
import type { Logger } from '../types/logger.js';
import type { Span, Tracer } from '../types/observability.js';
import type { PermissionPolicy } from '../types/permission.js';
import type { Plugin, PluginAPI } from '../types/plugin.js';
import type { Renderer } from '../types/renderer.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { BuildContext, SystemPromptBuilder } from '../types/system-prompt.js';
import type { Tool } from '../types/tool.js';
import type { ToolExecutorLike } from '../types/tool-executor.js';
import { type AgentLoopHandler, createAgentLoopHandler, signalAbortReason } from './agent-loop.js';
import { type AgentResponseHandler, createAgentResponseHandler } from './agent-response.js';
import { type AgentToolHandler, createAgentToolHandler } from './agent-tools.js';
import {
  type AgentInit,
  type AgentInput,
  type AgentPipelines,
  DEFAULT_MAX_ITERATIONS,
  normalizeInput,
  type ResolvedLoopDetectionConfig,
  type RunResult,
  resolveLoopDetection,
} from './agent-types.js';
import type { Context, RunOptions } from './context.js';

// Re-export types and utilities from agent-types.ts for backward compatibility
export {
  type AgentInit,
  type AgentInput,
  type AgentPipelines,
  createDefaultPipelines,
  DEFAULT_MAX_ITERATIONS,
  normalizeInput,
  type ResolvedLoopDetectionConfig,
  resolveLoopDetection,
  type RunResult,
  type ToolCallPipelinePayload,
  type UserInputPayload,
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
  private readonly refreshSystemPrompt: boolean;
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

  /**
   * Dedup window for byte-identical consecutive inputs. Only accidental
   * back-to-back duplicates fall inside it — terminal \r\n re-entrancy,
   * stuck-key bursts, client auto-resubmit loops. A deliberate re-send later
   * (the classic "continue" nudge after a model switch, or retyping the same
   * instruction after a failed run) must always execute.
   */
  static readonly INPUT_DEDUP_WINDOW_MS = 1_500;

  /**
   * SHA-256 + submission time of the last committed input content. The pair
   * powers burst-only dedup: identical text skips a run solely when it lands
   * within {@link Agent.INPUT_DEDUP_WINDOW_MS} of the previous submission.
   */
  private _lastInputHash: string | undefined;
  private _lastInputHashAt: number | undefined;

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
    // A missing host policy must not turn a finite iteration budget into an
    // unbounded autonomous run. Hosts/users can still opt in explicitly.
    this.autoExtendLimit = init.autoExtendLimit ?? false;
    this.loopDetection = resolveLoopDetection(init.loopDetection);
    this.autonomousContinue = init.autonomousContinue ?? false;
    this.refreshSystemPrompt = init.refreshSystemPrompt ?? false;
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
        message:
          'Agent.run() is already in progress on this instance. Concurrent runs are not supported.',
        code: 'AGENT_RUN_FAILED',
        context: { phase: 'concurrency-guard' },
      });
    }
    // Deferred hash commit: assigned during dedup below, committed to
    // this._lastInputHash only after setup succeeds inside the try.
    let newInputHash: string | undefined;

    // Dedup: skip a run whose input is byte-identical to the immediately
    // preceding submission AND lands within the burst window — terminal
    // \r\n re-entrancy, stuck-key bursts, client-side resubmission loops.
    // Identical text submitted LATER is a deliberate repeat ("continue"
    // nudges after a model switch, retry-after-error) and must execute;
    // an unbounded dedup used to swallow it silently, leaving the session
    // looking dead until the user typed something different.
    const inputText =
      typeof userInput === 'string'
        ? userInput
        : ((userInput as { prompt?: string })?.prompt ?? '');
    if (inputText.length > 0) {
      const hash = createHash('sha256').update(inputText).digest('hex');
      const elapsed = Date.now() - (this._lastInputHashAt ?? Number.NaN);
      // `elapsed >= 0` guards against wall-clock steps backward (NTP sync or
      // manual adjustment): a negative duration must never extend the burst
      // window, and NaN (no committed timestamp yet) fails both comparisons,
      // so a first-ever input can never be treated as a duplicate.
      const burstDuplicate =
        hash === this._lastInputHash &&
        elapsed >= 0 &&
        elapsed < Agent.INPUT_DEDUP_WINDOW_MS;
      if (burstDuplicate) {
        // Logger.debug is a required method (types/logger.ts); no fallback
        // chain needed — this only has to be observable at debug level.
        this._logger.debug(
          'Duplicate input suppressed: identical text resubmitted inside the dedup burst window.',
        );
        return {
          status: 'done' as const,
          iterations: 0,
        };
      }
      // Defer committing the hash until setup (prompt refresh + beforeRun)
      // succeeds. If it throws, the finally must not leave a stale hash that
      // would silently skip every future retry of the same input.
      newInputHash = hash;
    }

    this._runInProgress = true;
    const controller = new RunController({ parentSignal: opts.signal });
    const signal = controller.signal;
    this.ctx.signal = signal;
    // Pin this run's writer and id BEFORE any async hook runs. Hosts (WebUI)
    // can swap ctx.session on session.new/resume while this run is still in
    // flight; every event and persistence call from here on — including from
    // beforeRun extensions and late provider streams — must stay on the
    // session that started the run.
    const sessionWriter = this.ctx.session;
    const sessionId = sessionWriter.id;
    this.ctx.activeRunSessionWriter = sessionWriter;
    this.ctx.activeRunSessionId = sessionId;
    this.ctx.activeLogicalRequestId = undefined;
    this.ctx.activePromptManifestId = undefined;
    controller.onAbort(() => this.ctx.drainAbortHooks());
    // Abort durability: drain the buffered session writer the moment the run
    // is cancelled. The loop's `finally` clears the in-flight marker, but the
    // buffered JSONL events would otherwise sit in memory until the next
    // periodic flush — a hard exit right after Ctrl+C would lose them.
    controller.onAbort(async () => {
      await sessionWriter.flush().catch(() => {
        /* best-effort — close()/checkpoint flush remains the backstop */
      });
    });

    // Keep provider accounting and lazy discovery separate. `ctx.tools` is the
    // direct request surface; catalogTools remains executable through governed
    // meta-tools without paying every schema on every provider call.
    this.ctx.tools = this.tools.listForProvider();
    this.ctx.catalogTools = this.tools.list();

    // Initialize timing and span BEFORE the try so the catch and finally
    // blocks can reference them even when the throw happens during prompt
    // refresh or beforeRun — both of which run inside the try below.
    const runStartedAt = Date.now();
    const runStartedIso = new Date(runStartedAt).toISOString();
    let span: Span | undefined;

    try {
      // Prompt refresh and beforeRun extensions can throw. They MUST be
      // inside the try/finally so that _runInProgress, session pins, and
      // the controller are cleaned up on failure — otherwise the agent is
      // permanently wedged ("already in progress") on the next run().
      if (this.refreshSystemPrompt) {
        const builder = this.container.safeResolve<SystemPromptBuilder>(TOKENS.SystemPromptBuilder);
        if (builder) {
          const onlineAgents = Array.isArray(this.ctx.meta['promptOnlineAgents'])
            ? (this.ctx.meta['promptOnlineAgents'] as NonNullable<BuildContext['onlineAgents']>)
            : undefined;
          // The identity variant is THIS conversation's, not the process's.
          // Without it the refresh rebuilt every tab's prompt from the boot
          // variant, silently undoing a Lite/Pro choice on that tab's very
          // next turn — the builder is one shared instance and took the
          // variant once, at construction.
          const systemVariant = this.ctx.meta['systemPromptVariant'];
          const autonomy = this.ctx.meta['autonomy'];
          this.ctx.systemPrompt = await builder.build({
            cwd: this.ctx.cwd,
            projectRoot: this.ctx.projectRoot,
            tools: this.ctx.tools,
            catalogTools: this.ctx.catalogTools,
            provider: this.ctx.provider.id,
            model: opts.model ?? this.ctx.model,
            onlineAgents,
            ...(systemVariant === 'lite' || systemVariant === 'pro' || systemVariant === 'default'
              ? { systemVariant }
              : {}),
            ...(typeof autonomy === 'string' ? { autonomy } : {}),
          });
        }
      }

      span = this.tracer?.startSpan('agent.run', {
        'agent.model': opts.model ?? this.ctx.model,
        'agent.executionStrategy': opts.executionStrategy ?? this.executionStrategy,
      });

      const { blocks, text } = normalizeInput(userInput);
      const inputPayload = { content: blocks, text, ctx: this.ctx };

      await this.extensions.runBeforeRun(this.ctx, inputPayload);

      // Setup succeeded — now it's safe to commit the hash so the next run
      // can detect a changed input. If anything above threw, the hash stays
      // unchanged so the next run retries the refresh instead of skipping it.
      this._lastInputHash = newInputHash;
      this._lastInputHashAt = Date.now();

      this.events.emit('agent.run.started', {
        sessionId,
        ctx: this.ctx,
        model: opts.model ?? this.ctx.model,
        at: runStartedIso,
        inputText: text,
      });
      const autonomousContinue = opts.autonomousContinue ?? this.autonomousContinue;
      const result = await this._loopHandler.runInner(
        inputPayload,
        opts,
        controller,
        autonomousContinue,
      );
      // A run that RESOLVES as failed/aborted — the loop can absorb the error
      // and return a status instead of throwing — must release the dedup hash
      // exactly like the catch path below. Retyping the same instruction after
      // a failure or a stop is a retry, not an accidental duplicate.
      if (result.status === 'failed' || result.status === 'aborted') {
        this._lastInputHash = undefined;
        this._lastInputHashAt = undefined;
      }
      span?.setAttribute('agent.status', result.status);
      span?.setAttribute('agent.iterations', result.iterations);
      await this.extensions.runAfterRun(this.ctx, result);
      this.events.emit('agent.run.completed', {
        sessionId,
        ctx: this.ctx,
        status: result.status,
        iterations: result.iterations,
        at: new Date().toISOString(),
        durationMs: Date.now() - runStartedAt,
      });
      return result;
    } catch (err) {
      // A run that died before completing must never leave its input hash
      // committed: retyping the same instruction after an error (or a stop)
      // is a retry, not an accidental duplicate. Without this reset the
      // committed hash silently swallowed every identical resubmission.
      this._lastInputHash = undefined;
      this._lastInputHashAt = undefined;
      const wse = err instanceof AgentError ? err : toWrongStackError(err);
      const safeError = err instanceof Error ? new Error(err.message) : new Error(String(err));
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
      this.events.emit('agent.run.completed', {
        sessionId,
        ctx: this.ctx,
        status: result.status,
        iterations: result.iterations,
        at: new Date().toISOString(),
        durationMs: Date.now() - runStartedAt,
      });
      return result;
    } finally {
      span?.end();
      // Keep the run guard and pinned session pair intact through controller
      // disposal so teardown events cannot be attributed or persisted to a
      // newly-selected session, and no next run can overwrite the pins early.
      try {
        await controller.dispose();
      } finally {
        this.ctx.activeRunSessionId = undefined;
        this.ctx.activeRunSessionWriter = undefined;
        this.ctx.activeLogicalRequestId = undefined;
        this.ctx.activePromptManifestId = undefined;
        this._runInProgress = false;
      }
    }
  }

  // ── Tool + response execution handled by AgentToolHandler / AgentResponseHandler ──
}
