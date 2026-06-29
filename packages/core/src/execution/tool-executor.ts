import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '../core/context.js';
import {
  getDangerousCapabilities,
  hasDangerousCapabilityForSubagents,
} from '../security/capabilities.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { Tool, ToolProgressEvent, ToolErrorCategory } from '../types/tool.js';
import { ToolErrorCategory as ToolErrorCategoryEnum } from '../types/tool.js';
import type {
  ToolBatchResult,
  ToolConfirmPendingResult,
  ToolExecutionOutput,
  ToolExecutorOptions,
  ToolExecutorStrategy,
} from '../types/tool-executor.js';
import { toErrorMessage } from '../utils/error.js';
import { expectDefined } from '../utils/expect-defined.js';
import { validateAgainstSchema } from '../utils/json-schema-validate.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { createToolOutputSerializer } from '../utils/tool-output-serializer.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import { FetchError, isWrongStackError, ToolError, ToolValidationError, WrongStackError } from '../types/errors.js';
import { MALFORMED_ARG_MARKERS } from '../types/tool-markers.js';
import type { ToolResultRenderMode } from '../types/config.js';
import { resolveToolResultRenderMode } from '../utils/tool-result-render-mode.js';
import type { ToolResultRenderModeConfig } from '../types/config.js';
export class ToolExecutor {
  /** Minimum gap between coalesced `partial_output` tool.progress emits. */
  static readonly PROGRESS_EMIT_INTERVAL_MS = 100;
  /** Max chars of accumulated stream text carried per coalesced emit (tail). */
  static readonly PROGRESS_TAIL_CHARS = 16_384;
  /** Max chars of the head (beginning of output) kept alongside the tail. */
  static readonly PROGRESS_HEAD_CHARS = 16_384;

  private readonly serializer;
  private readonly iterationTimeoutMs: number;
  private readonly maxToolTimeoutMs: number;

  constructor(
    private readonly registry: { get(name: string): Tool | undefined; list(): Tool[] },
    private opts: ToolExecutorOptions,
  ) {
    this.iterationTimeoutMs = opts.iterationTimeoutMs ?? 300_000;
    this.maxToolTimeoutMs = opts.maxToolTimeoutMs ?? 300_000;
    this.serializer = createToolOutputSerializer({
      perIterationOutputCapBytes: opts.perIterationOutputCapBytes ?? 100_000,
    });
  }

  /**
   * Clear the interactive confirm awaiter so the executor returns
   * `ToolConfirmPendingResult` instead of blocking on stdin. Used by
   * the CLI to switch from inline prompts (REPL) to event-driven
   * confirmation (TUI) at runtime.
   */
  clearConfirmAwaiter(): void {
    this.opts.confirmAwaiter = undefined;
  }

  /**
   * Push the tool's per-tool result-render mode into the renderer as the
   * next-result render mode. The config key is `tools.resultRenderMode[name]`
   * — independent of the LLM-side `descriptionMode` so the two can be
   * toggled separately (`/tool read desc simple` vs `/tool read result
   * simple`). Defaults to `extend` when no entry is set.
   *
   * The hint is one-shot: the renderer consumes it on the next
   * `writeToolResult` call so an unset follow-up doesn't inherit a
   * previous tool's mode. Safe no-op when the renderer doesn't implement
   * `setResultRenderMode` (e.g. headless/test renderers).
   */
  private hintRenderMode(toolName: string): void {
    const renderer = this.opts.renderer;
    if (!renderer || typeof renderer.setResultRenderMode !== 'function') return;
    const modes: ToolResultRenderModeConfig | undefined = this.opts.resultRenderModes;
    const mode: ToolResultRenderMode = resolveToolResultRenderMode(modes, toolName);
    renderer.setResultRenderMode(toolName, mode);
  }

  private toolLogBase(
    ctx: Context,
    use: ToolUseBlock,
    toolName: string,
    durationMs: number,
  ): Record<string, unknown> {
    return {
      event: 'tool.execution',
      traceId: ctx.traceId,
      sessionId: ctx.session.id,
      agentId: ctx.agentId ?? '<unknown>',
      toolName,
      toolUseId: use.id,
      durationMs,
    };
  }

  private logToolSuccess(
    ctx: Context,
    use: ToolUseBlock,
    toolName: string,
    durationMs: number,
    outputChars: number,
  ): void {
    this.opts.events?.emit('tool.completed', {
      name: toolName,
      id: use.id,
      sessionId: ctx.session.id,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      agentId: ctx.agentId ?? '<unknown>',
      durationMs,
      outputChars,
    });
    this.opts.logger?.info('tool execution completed', {
      ...this.toolLogBase(ctx, use, toolName, durationMs),
      outcome: 'success',
      isError: false,
      outputChars,
    });
  }

  private logToolFailure(
    ctx: Context,
    use: ToolUseBlock,
    toolName: string,
    durationMs: number,
    err: unknown,
  ): void {
    const { category, retryable, detail } = classifyToolError(err);
    const structured = isWrongStackError(err);
    const structuredError = structured
      ? {
          errorCode: err.code,
          errorSubsystem: err.subsystem,
          errorSeverity: err.severity,
        }
      : {};
    this.opts.events?.emit('tool.failed', {
      name: toolName,
      id: use.id,
      sessionId: ctx.session.id,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      agentId: ctx.agentId ?? '<unknown>',
      durationMs,
      category,
      retryable,
      ...(detail ? { detail } : {}),
      ...structuredError,
    });
    this.opts.logger?.warn('tool execution failed', {
      ...this.toolLogBase(ctx, use, toolName, durationMs),
      outcome: 'failure',
      isError: true,
      errorCategory: category,
      retryable,
      errorDetail: detail,
      ...structuredError,
    });
  }

  /**
   * Execute a batch of tool uses using the configured strategy.
   * Returns the execution results and the remaining output budget.
   */
  async executeBatch(
    toolUses: ToolUseBlock[],
    ctx: Context,
    strategy: ToolExecutorStrategy,
  ): Promise<ToolBatchResult> {
    let budget = this.opts.perIterationOutputCapBytes ?? 100_000;

    const runOne = async (use0: ToolUseBlock): Promise<ToolExecutionOutput> => {
      const start = Date.now();
      // `use` is rebindable because a PreToolUse hook may rewrite its input.
      let use = use0;
      const tool = this.registry.get(use.name);

      // Fast path: unknown tool
      if (!tool) {
        const result = this.unknownToolResult(use, () => this.registry.list().map((t) => t.name));
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      // Strong guarantee: Validate input against the tool's declared JSON Schema
      // *before* permission checks or execution. This is a hard gate — bad calls
      // are rejected early with actionable feedback so the model can self-correct.
      const validation = validateAgainstSchema(use.input, tool.inputSchema);
      if (!validation.ok) {
        const errorDetails = validation.errors
          .map((e) => `  - ${e.path || 'input'}: ${e.message}`)
          .join('\n');

        const result = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content:
            `Invalid arguments for tool "${tool.name}".\n\n` +
            `Validation errors:\n${errorDetails}\n\n` +
            `Please call the tool again with arguments that match its inputSchema. ` +
            `You can use the "tool-help" tool with name="${tool.name}" to see the exact expected schema.`,
          is_error: true,
        };
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      // Capability safety net at the executor level (defense in depth).
      // Tools declaring dangerous capabilities are subject to stricter
      // permission enforcement in the post-policy block below (line ~150+).
      // In non-YOLO contexts, an `auto` permission is elevated to `confirm`
      // for dangerous-capability tools, reducing prompt-injection blast radius.
      const toolDangerousCaps = getDangerousCapabilities(tool);

      // Provider boundary: the model's tool arguments arrive as a raw JSON
      // string accumulated over streamed deltas. When that string is not a
      // valid JSON object (truncated, scalar, or mangled by a proxy/local
      // model), the parsers wrap it under a sentinel key instead of silently
      // producing `{}`. Executing the tool with such input yields a cryptic
      // "<field> is required" error that the model can't act on. Detect the
      // sentinel here and feed back an actionable message so the model
      // resends well-formed arguments.
      if (hasMalformedArguments(use.input)) {
        const result = this.malformedInputResult(use, extractMalformedRaw(use.input));
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      // PreToolUse hooks: may block the call outright or rewrite its input.
      // Runs before the permission check so a hook can veto a tool that the
      // trust policy would otherwise auto-allow.
      if (this.opts.hookRunner?.has('PreToolUse')) {
        const pre = await this.opts.hookRunner.preToolUse(tool.name, use.input, ctx);
        if (pre.block) {
          const result = this.blockedByHookResult(use, pre.reason);
          budget = this.budgetForString(result.content, budget);
          return { result, tool, durationMs: Date.now() - start };
        }
        if (pre.input) {
          // P3 #19 (before-release.md): skip the re-validation when the hook
          // passed the input through unchanged. Most hooks either block or
          // return the original input verbatim — re-validating the same shape
          // the executor already validated above is wasted work. Use
          // node:util's isDeepStrictEqual for a structural, order-sensitive
          // comparison (tool inputs are plain JSON, so reference identity is
          // not enough — a hook may clone before returning).
          if (!isDeepStrictEqual(pre.input, use.input)) {
            // A hook rewrote the arguments — re-validate before trusting them.
            const reval = validateAgainstSchema(pre.input, tool.inputSchema);
            if (!reval.ok) {
              const errorDetails = reval.errors
                .map((e) => `  - ${e.path || 'input'}: ${e.message}`)
                .join('\n');
              const result = {
                type: 'tool_result' as const,
                tool_use_id: use.id,
                content:
                  `A PreToolUse hook rewrote the arguments for "${tool.name}" into an invalid shape.\n\n` +
                  `Validation errors:\n${errorDetails}`,
                is_error: true,
              };
              budget = this.budgetForString(result.content, budget);
              return { result, tool, durationMs: Date.now() - start };
            }
            use = { ...use, input: pre.input };
          }
        }
      }

      // P3 #16 (before-release.md): cross-field validation. Called after
      // schema validation and PreToolUse hooks (which may have rewritten
      // the input) but before permission checks and execution. Lets tools
      // express invariants the JSON Schema cannot (e.g. old_string !==
      // new_string) and get them rejected with the same error formatting.
      if (typeof tool.validate === 'function') {
        const crossFieldErrors = tool.validate(use.input);
        if (crossFieldErrors.length > 0) {
          const errorDetails = crossFieldErrors.map((e) => `  - ${e}`).join('\n');
          const result = {
            type: 'tool_result' as const,
            tool_use_id: use.id,
            content:
              `Invalid arguments for tool "${tool.name}".\n\n` +
              `Validation errors:\n${errorDetails}`,
            is_error: true,
          };
          budget = this.budgetForString(result.content, budget);
          return { result, tool, durationMs: Date.now() - start };
        }
      }

      const decision = await this.opts.permissionPolicy.evaluate(tool, use.input, ctx);

      // Post-permission dangerous capability enforcement (B-side guarantee).
      // Even after the permission policy has spoken, we apply an extra conservative
      // rule for tools that declare high-risk capabilities (shell arbitrary, write outside
      // project, mcp proxy, etc.). This reduces the blast radius of prompt injection.
      let effectivePermission = decision.permission;

      // YOLO is the user's explicit fast-path for normal project work, so it
      // waives the post-policy dangerous-capability net only after the permission
      // policy has already returned `auto`. Destructive-gated calls still arrive
      // here as `confirm` unless the destructive YOLO override is active. Outside
      // YOLO, a trust-file auto-allow for a shell tool still gets a confirm, so a
      // single trusted pattern can't silently widen into arbitrary shell.
      // Detected via optional methods so policies without them (AutoApprove,
      // test mocks) keep the stricter default.
      const policy = this.opts.permissionPolicy;
      const yolo = policy.getYolo?.() === true || policy.getYoloDestructive?.() === true;

      // An `auto` decision sourced from `'yolo'` is authoritative: it comes
      // either from the leader's explicit YOLO mode or from a subagent's
      // `AutoApprovePermissionPolicy`, which already enforces a capability
      // allowlist (and now requires every dangerous capability to be granted
      // explicitly). In both cases the allowlist IS the blast-radius control,
      // so the conservative downgrade below would be redundant — and for a
      // non-interactive subagent (no confirmAwaiter) it would turn a granted
      // write into a `confirm` that can never be answered. Trust-file `auto`
      // (source 'trust') is NOT waived: a single trusted pattern must not
      // silently widen into arbitrary dangerous-capability execution.
      const authoritativeAuto = decision.source === 'yolo';

      if (
        toolDangerousCaps.length > 0 &&
        effectivePermission === 'auto' &&
        !yolo &&
        !authoritativeAuto
      ) {
        // Outside yolo we force at least 'confirm' for dangerous-capability tools.
        effectivePermission = 'confirm';
      }

      if (effectivePermission === 'deny') {
        const result = this.deniedResult(use, decision.reason);
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      if (effectivePermission === 'confirm') {
        if (this.opts.confirmAwaiter) {
          const choice = await this.opts.confirmAwaiter(tool, use.input, use.id, tool.name);
          if (choice !== 'yes' && choice !== 'always') {
            const result = {
              type: 'tool_result' as const,
              tool_use_id: use.id,
              content: `Tool "${tool.name}" denied by user.`,
              is_error: true,
            };
            budget = this.budgetForString(result.content, budget);
            return { result, tool, durationMs: Date.now() - start };
          }
          // fall through to execute
        } else {
          const suggestedPattern = subjectForToolInput(tool.name, use.input, tool.subjectKey) ?? tool.name;
          const pending: ToolConfirmPendingResult = {
            type: 'tool_confirm_pending',
            toolUseId: use.id,
            toolName: tool.name,
            input: use.input,
            suggestedPattern,
          };
          return { result: pending, tool, durationMs: Date.now() - start };
        }
      }

      // effectivePermission === 'auto' (after all safety layers)
      // Capability audit for observability.
      const toolCapsForAudit = hasDangerousCapabilityForSubagents(tool)
        ? (tool.capabilities ?? [])
        : [];

      // L1-C: trace each tool execution. Span is a no-op unless an OTel
      // adapter or other Tracer is bound — zero overhead by default.
      // Skip JSON.stringify for the common case (no dangerous capabilities)
      // to avoid per-call serialization of a static empty array.
      const span = this.opts.tracer?.startSpan(`tool.${tool.name}`, {
        'tool.name': tool.name,
        'tool.mutating': tool.mutating,
        'tool.permission': tool.permission,
        'tool.capabilities': toolCapsForAudit.length > 0
          ? JSON.stringify(tool.capabilities ?? [])
          : '[]',
        'tool.has_dangerous_capabilities': toolCapsForAudit.length > 0,
      });
      try {
        // H2: executeTool returns the rendered block plus the exact byte
        // count it spent against the iteration output cap. The cap was
        // enforced inside `enforceCap`, so the spend is known without
        // any second `Buffer.byteLength` walk.
        let { block: result, bytes } = await this.executeTool(tool, use, ctx, budget);
        budget -= bytes;
        // PostToolUse hooks: observe the result and optionally append
        // context (e.g. a linter note) that the model sees alongside the
        // tool output. Append the post-hook bytes to the budget spend
        // without re-walking the full result content.
        if (this.opts.hookRunner?.has('PostToolUse')) {
          const post = await this.opts.hookRunner.postToolUse(
            tool.name,
            use.input,
            { content: String(result.content), isError: !!result.is_error },
            ctx,
          );
          if (post.additionalContext) {
            const appended = `\n\n${post.additionalContext}`;
            result = { ...result, content: `${result.content}${appended}` };
            // Only the appended bytes are new — the pre-hook portion was
            // already counted by enforceCap. Walking just the appended
            // tail is `O(additionalContext.length)`, never `O(content)`.
            // Floor at 0 to match `decrementBudget`'s pre-fix clamp.
            budget = Math.max(0, budget - Buffer.byteLength(appended, 'utf8'));
          }
        }
        const outputChars = typeof result.content === 'string' ? result.content.length : 0;
        span?.setAttribute('tool.is_error', !!result.is_error);
        span?.setAttribute('tool.output_bytes', outputChars);
        this.logToolSuccess(ctx, use, tool.name, Date.now() - start, outputChars);
        return { result, tool, durationMs: Date.now() - start };
      } catch (err) {
        // Preserve structured errors on the throw path. A WrongStackError
        // carries `code`, `subsystem`, `severity`, `recoverable`, `context`,
        // and `cause` — flattening it to `err.message` here would lose all of
        // that before the agent loop, audit log, or recovery strategies ever
        // see it. Re-throw so safeRun's catch can render via `describe()` and
        // any outer handler (agent-loop.toWrongStackError, etc.) preserves the
        // structured shape. Bare Errors and primitives keep the old behavior:
        // there's no rich data to preserve, so the user gets a scrubbed
        // tool_result block.
        if (isWrongStackError(err)) {
          if (err instanceof Error) span?.recordError(err);
          span?.setAttribute('tool.is_error', true);
          this.logToolFailure(ctx, use, tool.name, Date.now() - start, err);
          throw err;
        }
        const msg = toErrorMessage(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
        const { category, retryable, detail } = classifyToolError(err);
        this.hintRenderMode(tool.name);
        this.opts.renderer?.writeToolResult(tool.name, scrubbed, true);
        const result = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: `Tool "${tool.name}" threw: ${scrubbed}`,
          is_error: true,
        };
        budget = this.budgetForString(result.content, budget);
        if (err instanceof Error) span?.recordError(err);
        span?.setAttribute('tool.is_error', true);
        span?.setAttribute('tool.error_category', category);
        span?.setAttribute('tool.error_retryable', retryable);
        if (detail) span?.setAttribute('tool.error_detail', detail);
        this.logToolFailure(ctx, use, tool.name, Date.now() - start, err);
        return { result, tool, durationMs: Date.now() - start };
      } finally {
        span?.end();
      }
    };

    // Run a single tool but never let an exception propagate to the
    // gather() below — `runOne` is already try/catch-wrapped for the
    // execution phase, but the *pre*-execution paths (permission policy,
    // confirmAwaiter) are unguarded and an unexpected throw there would
    // collapse Promise.all and lose every sibling's output. Wrap each
    // call so a per-tool failure becomes a per-tool error result.
    const safeRun = async (use: ToolUseBlock): Promise<ToolExecutionOutput> => {
      try {
        return await runOne(use);
      } catch (err) {
        // For structured errors, render via describe() so the model and user
        // see `code: message [context...]` instead of just `message`. This is
        // the second half of the structured-error preservation path — the
        // first half is runOne's catch rethrowing instead of flattening.
        // Bare errors keep the old "execution failed: <scrubbed>" prefix.
        const isStructured = isWrongStackError(err);
        const msg = isStructured ? err.describe() : toErrorMessage(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
        const { category, retryable, detail } = classifyToolError(err);
        const tool = this.registry.get(use.name);
        const toolName = tool?.name ?? use.name;
        this.hintRenderMode(toolName);
        this.opts.renderer?.writeToolResult(toolName, scrubbed, true);
        const result = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: isStructured
            ? scrubbed
            : `Tool "${use.name}" execution failed: ${scrubbed}`,
          is_error: true,
        };
        budget = this.budgetForString(result.content, budget);
        // Classification result is stored in the result for future retry logic;
        // span attributes are set in runOne's catch block (this err bubbles from there).
        void category;
        void retryable;
        void detail;
        return { result, tool, durationMs: 0 };
      }
    };

    if (strategy === 'sequential') {
      const outputs: ToolExecutionOutput[] = [];
      for (const use of toolUses) {
        if (use) outputs.push(await safeRun(use));
      }
      return { outputs, remainingBudget: budget };
    }

    if (strategy === 'parallel') {
      const outputs = await Promise.all(toolUses.map((use) => safeRun(use)));
      return { outputs, remainingBudget: budget };
    }

    // smart: non-mutating in parallel, then mutating sequentially
    const nonMutating: ToolUseBlock[] = [];
    const mutating: ToolUseBlock[] = [];
    for (const use of toolUses) {
      if (!use) continue;
      const tool = this.registry.get(use.name);
      if (tool?.mutating) mutating.push(use);
      else nonMutating.push(use);
    }
    const firstPass = await Promise.all(nonMutating.map((use) => safeRun(use)));
    const secondPass: ToolExecutionOutput[] = [];
    for (const use of mutating) {
      secondPass.push(await safeRun(use));
    }
    return {
      outputs: [...firstPass, ...secondPass],
      remainingBudget: budget,
    };
  }

  /**
   * Execute a single tool with timeout, permission check, and output capping.
   * Emits `tool.started` via the injected EventBus (if any) right before
   * invoking the tool — closes the observability gap between "model decided
   * to call a tool" and "tool.executed".
   */
  async executeTool(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    budget: number,
  ): Promise<{ block: ToolResultBlock; bytes: number }> {
    this.opts.events?.emit('tool.started', {
      sessionId: ctx.session.id,
      name: tool.name,
      id: use.id,
      input: use.input,
    });
    this.opts.renderer?.writeToolCall(tool.name, use.input);
    const output = await this.runWithTimeout(tool, use.input, ctx.signal, ctx, use.id);
    const text = this.serializer.serialize(output, { toolName: tool.name, input: use.input, tool });
    const scrubbed = this.opts.secretScrubber.scrub(text);
    const withArtifact = await maybePersistLargeToolOutput(tool.name, scrubbed, budget);
    // enforceCap already walks the text to compute bytes for the budget
    // cap. Carry the residual budget back as `bytes` so the caller can
    // deduct the spend without a second `Buffer.byteLength` walk — and
    // never falls back to `JSON.stringify` on a structured value.
    const { text: capped, newBudget } = this.serializer.enforceCap(withArtifact, budget);
    this.hintRenderMode(tool.name);
    this.opts.renderer?.writeToolResult(tool.name, capped, false);
    return {
      block: {
        type: 'tool_result',
        tool_use_id: use.id,
        name: tool.name,
        content: capped,
        is_error: false,
      },
      // `budget - newBudget` is the exact byte count enforceCap spent
      // (capped at `budget` so a truncated output shows as `budget`
      // consumed, matching the pre-fix `decrementBudget` semantics).
      bytes: budget - newBudget,
    };
  }

  private async runWithTimeout(
    tool: Tool,
    input: unknown,
    parentSignal: AbortSignal,
    ctx: Context,
    toolUseId?: string | undefined,
  ): Promise<unknown> {
    if (parentSignal.aborted) {
      // Re-throw the original abort reason, whether it's an Error, string, or undefined.
      if (parentSignal.reason instanceof Error) throw parentSignal.reason;
      throw new Error(typeof parentSignal.reason === 'string' ? parentSignal.reason : 'aborted');
    }
    const timeoutMs = clampTimeoutMs(
      tool.timeoutMs ?? this.iterationTimeoutMs,
      this.maxToolTimeoutMs,
    );
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([parentSignal, timeoutSignal]);

    let output: unknown;
    try {
      // Streaming variant takes precedence — yields progress events, then
      // a final 'final' event with the typed output. Tools that don't
      // implement executeStream fall through to the standard execute path.
      output =
        typeof tool.executeStream === 'function'
          ? await this.runStreamedTool(tool, input, ctx, combined, toolUseId)
          : await tool.execute(input, ctx, { signal: combined });
    } catch (err) {
      // If aborted, run cleanup before re-throwing so the tool can release
      // resources (child processes, file handles, network connections).
      if (combined.aborted) await this.runToolCleanup(tool, input, ctx);
      throw err;
    }
    // The tool returned without throwing, but the signal may have aborted (e.g.
    // a timeout fired) while a tool that ignores the abort signal kept running.
    // Treat that as an abort: clean up and surface the abort to the caller so a
    // late, stale result is never returned as success.
    if (combined.aborted) {
      await this.runToolCleanup(tool, input, ctx);
      throw combined.reason instanceof Error
        ? combined.reason
        : new Error(typeof combined.reason === 'string' ? combined.reason : 'tool timeout');
    }
    return output;
  }

  /** Best-effort tool cleanup; never let it mask the original error. */
  private async runToolCleanup(tool: Tool, input: unknown, ctx: Context): Promise<void> {
    if (typeof tool.cleanup !== 'function') return;
    try {
      await tool.cleanup(input, ctx);
    } catch {
      /* swallow — never let cleanup mask the original error */
    }
  }

  private async runStreamedTool(
    tool: Tool,
    input: unknown,
    ctx: Context,
    signal: AbortSignal,
    toolUseId: string | undefined,
  ): Promise<unknown> {
    let finalOutput: unknown;
    let sawFinal = false;
    if (!tool.executeStream) {
      throw new ToolError({
        message: `Tool "${tool.name}" does not support streaming execution`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: tool.name,
        context: { reason: 'streaming_not_supported' },
      });
    }
    const stream = tool.executeStream(input, ctx, { signal });
    // Manual iteration so we can explicitly close the async iterator after
    // receiving the final event, ensuring any cleanup in the tool's generator
    // finally block runs regardless of whether the engine calls return() on
    // break of a for-await-of loop.
    const iter = stream[Symbol.asyncIterator]();
    // Coalesce `partial_output` progress into at most one EventBus emit per
    // PROGRESS_EMIT_INTERVAL_MS, carrying the most recent PROGRESS_TAIL_CHARS
    // of accumulated text PLUS the first PROGRESS_HEAD_CHARS (the head).
    // P3 #22 (before-release.md): without the head, an important error
    // message at the beginning of a long output (e.g. `pnpm build`) was
    // gone by the time the user saw the live tail. Now both the head and
    // tail survive — when the output exceeds the combined buffer, the flush
    // emits "head...\n[...truncated...]\n...tail" so subscribers see both
    // ends.
    let progressTail = '';
    let progressHead = '';
    let headComplete = false;
    let lastProgressEmitAt = 0;
    const emitProgress = (ev: ToolProgressEvent) => {
      this.opts.events?.emit('tool.progress', {
        sessionId: ctx.session.id,
        name: tool.name,
        id: toolUseId ?? '<unknown>',
        event: ev,
      });
    };
    const flushProgressTail = (force: boolean) => {
      if (progressTail.length === 0) return;
      const now = Date.now();
      if (!force && now - lastProgressEmitAt < ToolExecutor.PROGRESS_EMIT_INTERVAL_MS) return;
      lastProgressEmitAt = now;
      // On the final force-flush, if we have a head AND tail (output was
      // truncated in the middle), emit both with a truncation marker. On
      // normal coalesced flushes, just emit the tail — matching the
      // pre-P3-#22 per-event behavior.
      let text: string;
      if (force && headComplete && progressTail.length > 0) {
        text = `${progressHead}\n[...output truncated...]\n${progressTail}`;
      } else {
        text = progressTail;
      }
      progressTail = '';
      emitProgress({ type: 'partial_output', text });
    };
    try {
      while (true) {
        const { done, value: ev } = await iter.next();
        if (done) break;
        if (ev.type === 'final') {
          finalOutput = ev.output;
          sawFinal = true;
          // Result is locked — stop consuming further events.
          break;
        }
        if (ev.type === 'partial_output' && typeof ev.text === 'string') {
          // P3 #22: accumulate the head (first PROGRESS_HEAD_CHARS) for the
          // final force-flush, while the tail follows the original per-event
          // coalescing behavior. This preserves backward compatibility with
          // tests that expect each partial_output to emit independently,
          // while ensuring long outputs retain their beginning in the final
          // flush.
          if (!headComplete) {
            const remaining = ToolExecutor.PROGRESS_HEAD_CHARS - progressHead.length;
            if (ev.text.length <= remaining) {
              progressHead += ev.text;
            } else {
              progressHead += ev.text.slice(0, remaining);
              headComplete = true;
            }
          }
          progressTail += ev.text;
          if (progressTail.length > ToolExecutor.PROGRESS_TAIL_CHARS) {
            progressTail = progressTail.slice(-ToolExecutor.PROGRESS_TAIL_CHARS);
          }
          flushProgressTail(false);
          continue;
        }
        // Non-partial events (log/warning/metric/file_changed) are low-volume;
        // flush buffered text first so subscribers see events in stream order.
        flushProgressTail(true);
        emitProgress(ev);
      }
      flushProgressTail(true);
    } finally {
      // Always close the iterator so the tool's generator finally block
      // runs even if we broke early on a final event or errored.
      await iter.return?.(undefined);
    }
    if (!sawFinal) {
      throw new ToolError({
        message: `tool "${tool.name}" executeStream completed without a 'final' event`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: tool.name,
        context: { reason: 'missing_final_event' },
      });
    }
    return finalOutput;
  }

  private unknownToolResult(use: ToolUseBlock, listFns: () => string[]): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Tool "${use.name}" is not registered. Available tools: ${listFns().join(', ')}`,
      is_error: true,
    };
  }

  private malformedInputResult(use: ToolUseBlock, raw?: string): ToolResultBlock {
    let content =
      `Tool "${use.name}" received arguments that were not a valid JSON object, so they ` +
      `could not be parsed. Re-issue the call with the arguments encoded as a single ` +
      `well-formed JSON object matching the tool's input schema.`;
    // Echo the raw payload back so the model can see *what* it produced and
    // self-correct. Without this the model is blind to its own mistake and
    // tends to resend the identical malformed call in a loop. Common causes:
    // unescaped newlines/quotes/backslashes inside a string field, or the
    // arguments being truncated mid-stream.
    if (raw) {
      const max = 800;
      const excerpt =
        raw.length > max ? `${raw.slice(0, max)}… (truncated, ${raw.length} chars total)` : raw;
      content +=
        ` Common cause: a string field (e.g. code in old_string/new_string) ` +
        `contains literal newlines, quotes, or backslashes that must be JSON-escaped, ` +
        `or the payload was cut off mid-stream. The raw arguments received were:\n${excerpt}`;
    }
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content,
      is_error: true,
    };
  }

  private deniedResult(use: ToolUseBlock, reason?: string): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Tool "${use.name}" denied: ${reason ?? 'policy'}`,
      is_error: true,
    };
  }

  private blockedByHookResult(use: ToolUseBlock, reason?: string): ToolResultBlock {
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Tool "${use.name}" was blocked by a PreToolUse hook: ${reason ?? 'no reason given'}`,
      is_error: true,
    };
  }

  /**
   * Subtract a string-content result's UTF-8 byte length from the
   * iteration output budget. Used for synthesized results (unknown tool,
   * validation error, blocked, threw) where the content is a small
   * string built in the executor. The success path no longer goes
   * through here — `executeTool` carries the exact byte count it spent
   * in its return value, derived from `enforceCap`'s `newBudget`.
   *
   * Floors the result at 0 to match the pre-fix `decrementBudget`
   * semantics (over-budget spends don't underflow the running total).
   */
  private budgetForString(content: string, budget: number): number {
    return Math.max(0, budget - Buffer.byteLength(content, 'utf8'));
  }

}

function clampTimeoutMs(timeoutMs: number, maxTimeoutMs: number): number {
  const fallback = 300_000;
  const finiteTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : fallback;
  const finiteMax = Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0 ? maxTimeoutMs : fallback;
  return Math.max(1, Math.min(finiteTimeout, finiteMax));
}

/**
 * Sentinel keys the provider adapters use to wrap tool arguments that could
 * not be parsed into a proper JSON object. `parseToolInput` (Anthropic /
 * shared) uses `__raw`, `contentFromOpenAI` uses `__raw_arguments`, and the
 * streaming response builder's `safeJsonOrRaw` uses `_raw`.
 *
 * P3 #14 (before-release.md): centralized in `types/tool-markers.ts` so the
 * providers package (which produces these markers) and this executor (which
 * detects them) share a single source of truth. The old "Keep this list in
 * sync" comment is gone.
 *
 * NOTE: `parseToolInput` and `safeJsonOrRaw` now attempt JSON repair
 * (auto-closing braces and strings) before wrapping — so a truncated blob
 * like `{"old_string": "line1\nline2` gets repaired first. The sentinel is
 * only used when repair also fails.
 */

function hasMalformedArguments(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  // The sentinel is the *only* key when wrapping occurred — a real tool call
  // that legitimately uses a key named e.g. `_raw` will carry other keys too.
  const keys = Object.keys(obj);
  return keys.length === 1 && MALFORMED_ARG_MARKERS.includes(keys[0] as never);
}

/**
 * Pull the original (unparseable) payload back out of a sentinel-wrapped input
 * so the executor can echo it to the model. The wrapped value is usually the
 * raw argument string, but a scalar/array that parsed cleanly is wrapped too —
 * stringify those. Returns undefined if nothing usable is present.
 */
function extractMalformedRaw(input: unknown): string | undefined {
  if (!hasMalformedArguments(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const value = obj[expectDefined(Object.keys(obj)[0])];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const TOOL_OUTPUT_ARTIFACT_THRESHOLD_BYTES = 64 * 1024;

/**
 * Classify a tool execution error into a structured ToolErrorCategory.
 * Used for observability (span attributes) and retry strategy decisions.
 */
export function classifyToolError(err: unknown): { category: ToolErrorCategory; retryable: boolean; detail?: string } {
  // AbortError — user cancellation, never retry
  if (err instanceof Error && err.name === 'AbortError') {
    return { category: ToolErrorCategoryEnum.FATAL, retryable: false, detail: 'aborted' };
  }

  // Node.js ErrnoException with system error codes
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    switch (code) {
      case 'ETIMEDOUT':
      case 'ECONNRESET':
      case 'ECONNREFUSED':
      case 'ENETUNREACH':
      case 'EHOSTUNREACH':
        return { category: ToolErrorCategoryEnum.TRANSIENT, retryable: true, detail: code };
      case 'ENOENT':
      case 'ENOTDIR':
        return { category: ToolErrorCategoryEnum.NOT_FOUND, retryable: false, detail: code };
      case 'EACCES':
      case 'EPERM':
        return { category: ToolErrorCategoryEnum.PERMISSION, retryable: false, detail: code };
      case 'EBUSY':
      case 'EMFILE':
      case 'ENFILE':
        return { category: ToolErrorCategoryEnum.TRANSIENT, retryable: true, detail: code };
    }
  }

  // HTTP response errors (fetch failed with non-OK status).
  // P3 #18 (before-release.md): prefer the structured FetchError subclass
  // (instanceof is reliable) over the duck-typing `'response' in err` check,
  // which catches any Error with a `response` property — custom errors,
  // proxies, mocks. The duck-typing arm stays as a fallback for code that
  // still throws bare Error objects with an ad-hoc `response` field.
  if (err instanceof FetchError) {
    return httpStatusToCategory(err.status);
  }
  if (err instanceof Error && 'response' in err) {
    const response = (err as { response: { status?: number } }).response;
    const status = response?.status;
    if (status !== undefined) {
      return httpStatusToCategory(status);
    }
  }

  // Validation errors. Prefer the structured ValidationError subclass
  // (P2 #6) — instanceof is locale-independent and cannot misclassify an
  // unrelated error whose message happens to contain "validation". The
  // legacy string-match arm stays as a fallback for tools that still throw
  // bare Error('...validation...') and have not yet migrated.
  if (err instanceof ToolValidationError) {
    return { category: ToolErrorCategoryEnum.VALIDATION, retryable: false, detail: 'validation' };
  }
  if (err instanceof Error && err.message.includes('validation')) {
    return { category: ToolErrorCategoryEnum.VALIDATION, retryable: false, detail: 'validation' };
  }

  // Structured WrongStackError catch-all: any error that is a WrongStackError
  // subclass (FsError, SessionError, ConfigError, ParseError, PluginError,
  // AgentError, etc.) but wasn't matched by the FetchError or
  // ToolValidationError arms above. Route by severity + recoverability:
  //   fatal   → FATAL (abort the loop)
  //   error   → FATAL (surface to the user, don't retry)
  //   warning → TRANSIENT (log and continue; the subsystem flagged it as
  //             recoverable so the loop can proceed)
  if (err instanceof WrongStackError) {
    const wse = err as WrongStackError;
    const category =
      wse.severity === 'warning'
        ? ToolErrorCategoryEnum.TRANSIENT
        : ToolErrorCategoryEnum.FATAL;
    return {
      category,
      retryable: wse.recoverable,
      detail: `${wse.code} [${wse.subsystem}]`,
    };
  }

  // Default: fatal/unclassified
  return {
    category: ToolErrorCategoryEnum.FATAL,
    retryable: false,
    detail: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
  };
}

/**
 * Map an HTTP status code to a ToolErrorCategory. Shared by the FetchError
 * and duck-typed-response paths in classifyToolError.
 */
function httpStatusToCategory(status: number): { category: ToolErrorCategory; retryable: boolean; detail: string } {
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    return { category: ToolErrorCategoryEnum.TRANSIENT, retryable: true, detail: `HTTP ${status}` };
  }
  if (status === 404 || status === 410) {
    return { category: ToolErrorCategoryEnum.NOT_FOUND, retryable: false, detail: `HTTP ${status}` };
  }
  if (status === 401 || status === 403) {
    return { category: ToolErrorCategoryEnum.PERMISSION, retryable: false, detail: `HTTP ${status}` };
  }
  if (status === 400) {
    return { category: ToolErrorCategoryEnum.VALIDATION, retryable: false, detail: `HTTP ${status}` };
  }
  return { category: ToolErrorCategoryEnum.FATAL, retryable: false, detail: `HTTP ${status}` };
}

async function maybePersistLargeToolOutput(
  toolName: string,
  content: string,
  budget: number,
): Promise<string> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= Math.min(TOOL_OUTPUT_ARTIFACT_THRESHOLD_BYTES, Math.max(0, budget))) {
    return content;
  }

  try {
    const dir = path.join(wstackGlobalRoot(), 'tool-output');
    await fs.mkdir(dir, { recursive: true });
    const safeTool = toolName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40) || 'tool';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${stamp}-${safeTool}-${randomUUID()}.log`);
    await fs.writeFile(filePath, content, 'utf8');
    return (
      content +
      `\n[full tool output: ${bytes} bytes at ${filePath}; read/grep that file selectively instead of re-running or requesting more output]`
    );
  } catch {
    return content;
  }
}
