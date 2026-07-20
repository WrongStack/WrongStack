import { createHash, randomUUID } from 'node:crypto';
import { runWithProcessTelemetry } from '../observability/process-telemetry.js';
import { runWithNetworkTelemetry } from '../observability/network-telemetry.js';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '../core/context.js';
import {
  getDangerousCapabilities,
  hasDangerousCapabilityForSubagents,
} from '../security/capabilities.js';
import { evaluateToolKanbanBoundary } from '../security/kanban-boundary.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { Tool, ToolProgressEvent, ToolErrorCategory } from '../types/tool.js';
import { ToolErrorCategory as ToolErrorCategoryEnum } from '../types/tool.js';
import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
  type ToolBatchResult,
  type ToolConfirmPendingResult,
  type ToolExecutionOutput,
  type ToolExecutorOptions,
  type ToolExecutorStrategy,
} from '../types/tool-executor.js';
import { toErrorMessage } from '../utils/error.js';
import { expectDefined } from '../utils/expect-defined.js';
import { coerceAgainstSchema, validateAgainstSchema } from '../utils/json-schema-validate.js';
import { subjectForToolInput } from '../utils/tool-subject.js';
import { createToolOutputSerializer } from '../utils/tool-output-serializer.js';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';
import {
  FetchError,
  isWrongStackError,
  ToolError,
  ToolValidationError,
  WrongStackError,
} from '../types/errors.js';
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
    return this.withGovernedExecutionBridge(ctx, () =>
      this.executeBatchInternal(toolUses, ctx, strategy),
    );
  }

  /**
   * Internal batch implementation. Nested meta-tool calls enter here through
   * the governed bridge so they traverse the same validation, hooks,
   * permission/capability, timeout, scrubbing, and audit path without
   * replacing the bridge that is already active for the outer call.
   */
  private async executeBatchInternal(
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

      // Provider boundary: the model's tool arguments arrive as a raw JSON
      // string accumulated over streamed deltas. When that string is not a
      // valid JSON object (truncated, scalar, or mangled by a proxy/local
      // model), the parsers wrap it under a sentinel key instead of silently
      // producing `{}`. Detect the sentinel BEFORE schema validation: a
      // schema with required fields would otherwise mask this case with a
      // misleading "field missing" error, when the actionable feedback is
      // "your arguments were not a JSON object — here is what arrived".
      if (hasMalformedArguments(use.input)) {
        const result = this.malformedInputResult(use, extractMalformedRaw(use.input));
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      // Strong guarantee: Validate input against the tool's declared JSON Schema
      // *before* permission checks or execution. This is a hard gate — bad calls
      // are rejected early with actionable feedback so the model can self-correct.
      // Before rejecting, one lossless coercion pass runs (string "5" → 5,
      // "true" → true, double-encoded JSON strings revived): models routinely
      // deliver the right content in the wrong type, and silently fixing that
      // beats burning a round-trip on an error the model may repeat.
      const validation = validateAgainstSchema(use.input, tool.inputSchema);
      if (!validation.ok) {
        const coercion = coerceAgainstSchema(use.input, tool.inputSchema);
        const revalidation = coercion.changed
          ? validateAgainstSchema(coercion.value, tool.inputSchema)
          : validation;
        if (coercion.changed && revalidation.ok) {
          this.opts.logger?.info('tool arguments coerced to match inputSchema', {
            tool: tool.name,
            id: use.id,
          });
          use = { ...use, input: coercion.value as Record<string, unknown> };
        } else {
          const errorDetails = revalidation.errors
            .map((e) => `  - ${e.path || 'input'}: ${e.message}`)
            .join('\n');

          const result = {
            type: 'tool_result' as const,
            tool_use_id: use.id,
            content:
              `Invalid arguments for tool "${tool.name}".\n\n` +
              `Validation errors:\n${errorDetails}\n\n` +
              `Fix exactly the fields listed above and call the tool again. ` +
              `You can use the "tool-help" tool with name="${tool.name}" to see the exact expected schema.`,
            is_error: true,
          };
          budget = this.budgetForString(result.content, budget);
          return { result, tool, durationMs: Date.now() - start };
        }
      }

      // Capability safety net at the executor level (defense in depth).
      // Tools declaring dangerous capabilities are subject to stricter
      // permission enforcement in the post-policy block below (line ~150+).
      // In non-YOLO contexts, an `auto` permission is elevated to `confirm`
      // for dangerous-capability tools, reducing prompt-injection blast radius.
      const toolDangerousCaps = getDangerousCapabilities(tool);

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

      // Kanban boundaries are an execution-time ceiling, not prompt advice.
      // Resolve the live board/task on every call so edits made in WebUI/TUI
      // take effect during an already-running agent assignment.
      const boundary = await evaluateToolKanbanBoundary(tool, use.input, ctx);
      if (boundary.decision === 'block') {
        this.opts.events?.emit('permission.boundary_denied', {
          sessionId: ctx.session.id,
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          name: tool.name,
          id: use.id,
          inputHash: hashPermissionInput(use.input, this.opts.secretScrubber),
          effectiveDecision: 'deny',
          boundarySource: 'kanban',
          ...(boundary.reason ? { reason: boundary.reason } : {}),
          ...(tool.riskTier ? { riskTier: tool.riskTier } : {}),
        });
        const result = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: `Tool "${tool.name}" blocked by Kanban boundary. ${boundary.reason ?? ''}`.trim(),
          is_error: true,
        };
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      const decision = await this.opts.permissionPolicy.evaluate(tool, use.input, ctx);

      // Post-permission dangerous capability enforcement (B-side guarantee).
      // Even after the permission policy has spoken, we apply an extra conservative
      // rule for tools that declare high-risk capabilities (shell arbitrary, write outside
      // project, mcp proxy, etc.). This reduces the blast radius of prompt injection.
      let effectivePermission = decision.permission;

      // YOLO is the user's explicit fast-path, so it waives the post-policy
      // dangerous-capability net after the permission policy has returned
      // `auto`. Outside YOLO, a trust-file auto-allow for a shell tool still
      // gets a confirm, so a single trusted pattern can't silently widen into
      // arbitrary shell.
      // Detected via optional methods so policies without them (AutoApprove,
      // test mocks) keep the stricter default.
      const policy = this.opts.permissionPolicy;
      const yolo = policy.getYolo?.() === true;

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

      const capabilityDowngraded =
        toolDangerousCaps.length > 0 &&
        effectivePermission === 'auto' &&
        !yolo &&
        !authoritativeAuto;
      if (capabilityDowngraded) {
        // Outside yolo we force at least 'confirm' for dangerous-capability tools.
        effectivePermission = 'confirm';
      }

      // Explicit YOLO/trust rules never waive a Kanban scope. A confirm-mode
      // violation needs a fresh human approval for this concrete call.
      if (boundary.decision === 'confirm' && effectivePermission !== 'deny') {
        effectivePermission = 'confirm';
      }

      this.opts.events?.emit('permission.evaluated', {
        sessionId: ctx.session.id,
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        name: tool.name,
        id: use.id,
        inputHash: hashPermissionInput(use.input, this.opts.secretScrubber),
        policyDecision: decision.permission,
        effectiveDecision: effectivePermission,
        decisionSource: decision.source,
        ...(decision.reason ? { reason: decision.reason } : {}),
        ...(decision.riskTier ?? tool.riskTier
          ? { riskTier: decision.riskTier ?? tool.riskTier }
          : {}),
        yoloEnabled: yolo,
        boundaryDecision: boundary.decision,
        ...(boundary.reason ? { boundaryReason: boundary.reason } : {}),
        capabilityDowngraded,
      });

      if (effectivePermission === 'deny') {
        const result = this.deniedResult(use, decision.reason);
        budget = this.budgetForString(result.content, budget);
        return { result, tool, durationMs: Date.now() - start };
      }

      if (effectivePermission === 'confirm') {
        const suggestedPattern =
          boundary.decision === 'confirm'
            ? `kanban-boundary:${boundary.path ?? tool.name}`
            : subjectForToolInput(tool.name, use.input, tool.subjectKey) ?? tool.name;
        if (this.opts.confirmAwaiter) {
          // Race the interactive prompt against the run's abort signal so an
          // interrupt never leaves the executor blocked on a confirmation
          // nobody will answer. 'abort' produces a distinct (non-deny) error
          // result — no trust/deny bookkeeping happens for an interrupt.
          const awaiter = this.opts.confirmAwaiter;
          const choice = await new Promise<'yes' | 'no' | 'always' | 'deny' | 'abort'>(
            (resolve, reject) => {
              const signal = ctx.signal;
              const onAbort = () => resolve('abort');
              if (signal.aborted) {
                resolve('abort');
                return;
              }
              signal.addEventListener('abort', onAbort, { once: true });
              awaiter(tool, use.input, use.id, suggestedPattern).then(
                (c) => {
                  signal.removeEventListener('abort', onAbort);
                  resolve(c);
                },
                (e) => {
                  signal.removeEventListener('abort', onAbort);
                  reject(e);
                },
              );
            },
          );
          this.opts.events?.emit('permission.confirmation_resolved', {
            sessionId: ctx.session.id,
            ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
            ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
            name: tool.name,
            id: use.id,
            choice,
            resolution:
              choice === 'yes' || choice === 'always'
                ? 'approved'
                : choice === 'abort'
                  ? 'cancelled'
                  : 'denied',
            resolver: choice === 'abort' ? 'abort' : 'user',
            decisionSource: decision.source,
            ...(decision.riskTier ?? tool.riskTier
              ? { riskTier: decision.riskTier ?? tool.riskTier }
              : {}),
            ...(boundary.reason ? { boundaryReason: boundary.reason } : {}),
          });
          if (choice !== 'yes' && choice !== 'always') {
            const result = {
              type: 'tool_result' as const,
              tool_use_id: use.id,
              content:
                choice === 'abort'
                  ? `Tool "${tool.name}" was not executed — the run was aborted while awaiting confirmation.`
                  : `Tool "${tool.name}" denied by user.`,
              is_error: true,
            };
            budget = this.budgetForString(result.content, budget);
            return { result, tool, durationMs: Date.now() - start };
          }
          // fall through to execute
        } else {
          const pending: ToolConfirmPendingResult = {
            type: 'tool_confirm_pending',
            toolUseId: use.id,
            toolName: tool.name,
            input: use.input,
            suggestedPattern,
            decisionSource: decision.source,
            riskTier: decision.riskTier ?? tool.riskTier,
            ...(boundary.decision === 'confirm' && boundary.reason
              ? { boundaryReason: boundary.reason }
              : {}),
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
        'tool.capabilities':
          toolCapsForAudit.length > 0 ? JSON.stringify(tool.capabilities ?? []) : '[]',
        'tool.has_dangerous_capabilities': toolCapsForAudit.length > 0,
      });
      try {
        // Snapshot the target before a write executes so its eventual file event
        // can distinguish a new file from an overwrite. This is deliberately
        // best-effort: observability must never prevent the tool from running.
        const inputPath =
          use.input && typeof use.input === 'object'
            ? (use.input as Record<string, unknown>).path
            : undefined;
        const caps = tool.capabilities ?? [];
        const hasFileCapability = caps.includes('fs.read') || caps.includes('fs.write');
        const absPath =
          hasFileCapability && typeof inputPath === 'string'
            ? path.isAbsolute(inputPath)
              ? inputPath
              : path.resolve(ctx.projectRoot, inputPath)
            : undefined;
        let writeTargetExisted: boolean | undefined;
        if (tool.name === 'write' && caps.includes('fs.write') && absPath) {
          writeTargetExisted = await fs.stat(absPath).then(
            (stat) => stat.isFile(),
            (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? false : undefined),
          );
        }

        // Split produce (async, concurrency-safe) from settle (synchronous,
        // budget-mutating). The long tool run + serialize + scrub + spill
        // happens here and touches no shared budget. The cap is then applied
        // synchronously below against the LIVE budget, so parallel tools
        // settling in sequence share one cumulative cap instead of each
        // reading the same stale starting budget (which let N parallel tools
        // pass N× the cap). Pass the current budget only as a spill-threshold
        // hint, not as the authoritative cap.
        const producedText = await this.produceToolOutput(tool, use, ctx, budget);
        // ── Synchronous settle: no `await` between reading `budget` and
        //    writing it back, so two parallel tools can't interleave here.
        let { block: result, bytes } = this.settleToolOutput(tool, use, producedText, budget);
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
            if (post.contextAs === 'separate') {
              // Keep plugin notices visually separated from the actual tool
              // output by storing the context on ctx so agent-tools merges
              // it into the same user message as the tool_results — this
              // preserves tool-use/tool-result adjacency. Accumulate across
              // multiple parallel PostToolUse hooks.
              ctx.pendingPostToolContext = ctx.pendingPostToolContext
                ? `${ctx.pendingPostToolContext}\n\n${post.additionalContext}`
                : post.additionalContext;
            } else {
              const appended = `\n\n${post.additionalContext}`;
              result = { ...result, content: `${result.content}${appended}` };
              // Only the appended bytes are new — the pre-hook portion was
              // already counted by enforceCap. Walking just the appended
              // tail is `O(additionalContext.length)`, never `O(content)`.
              // Floor at 0 to match `decrementBudget`'s pre-fix clamp.
              budget = Math.max(0, budget - Buffer.byteLength(appended, 'utf8'));
            }
          }
        }
        const outputChars = typeof result.content === 'string' ? result.content.length : 0;
        span?.setAttribute('tool.is_error', !!result.is_error);
        span?.setAttribute('tool.output_bytes', outputChars);
        this.logToolSuccess(ctx, use, tool.name, Date.now() - start, outputChars);

        // Auto-emit file event for tools with fs.read or fs.write capabilities.
        // This central integration captures ALL file operations without requiring
        // per-tool wiring — the tool executor is the single dispatch point.
        if (!result.is_error && typeof inputPath === 'string' && absPath) {
          const operation =
            tool.name === 'read'
              ? 'read'
              : caps.includes('fs.write') && tool.name === 'write'
                ? writeTargetExisted === false
                  ? 'create'
                  : 'update'
                : caps.includes('fs.write')
                  ? 'update'
                  : 'read';
          const ts = new Date().toISOString();
          ctx.recordFileEvent?.({
            operation,
            filePath: inputPath,
            absPath,
            toolName: tool.name,
            toolUseId: use.id,
            durationMs: Date.now() - start,
          });
          // Also emit EventBus event for live observability subscribers
          // (the `file.event` channel). The same data shape is persisted
          // to session JSONL via ctx.recordFileEvent() above.
          this.opts.events?.emit('file.event', {
            operation,
            filePath: inputPath,
            absPath,
            sessionId: ctx.session.id,
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            provider:
              typeof ctx.provider === 'object'
                ? (ctx.provider as { id: string }).id
                : String(ctx.provider),
            model: ctx.model,
            toolName: tool.name,
            toolUseId: use.id,
            scope: ctx.currentKanbanTaskId ? 'task' : 'session',
            taskId: ctx.currentKanbanTaskId,
            boardId: ctx.currentKanbanBoardId,
            timestamp: ts,
            durationMs: Date.now() - start,
          });
        }

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
          content: isStructured ? scrubbed : `Tool "${use.name}" execution failed: ${scrubbed}`,
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
   * Install the executor-owned bridge used by meta-tools for nested calls.
   * The bridge deliberately returns the governed, scrubbed ToolResultBlock
   * content rather than the raw tool value. This prevents a meta-tool from
   * bypassing output controls while preserving structured success/failure.
   */
  private async withGovernedExecutionBridge<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
    const previous = ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY];
    if (typeof previous === 'function') return run();

    const bridge: GovernedToolExecutor = async (toolName, input) => {
      const nestedUse: ToolUseBlock = {
        type: 'tool_use',
        id: `nested-${randomUUID()}`,
        name: toolName,
        input,
      };
      const batch = await this.executeBatchInternal([nestedUse], ctx, 'sequential');
      const output = batch.outputs[0];
      if (!output) {
        return { success: false, error: `tool "${toolName}" produced no result` };
      }
      if (output.result.type === 'tool_confirm_pending') {
        return {
          success: false,
          error: `tool "${toolName}" requires separate confirmation; call it directly`,
        };
      }
      if (output.result.is_error) {
        return { success: false, error: String(output.result.content) };
      }
      return { success: true, result: output.result.content };
    };

    ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY] = bridge;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY];
      else ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY] = previous;
    }
  }

  /**
   * Execute a single tool with timeout and output capping after its permission
   * decision has already been resolved by executeBatch/the confirmation flow.
   * Also installs the governed bridge because confirmed tools are re-run
   * through this method after a pending confirmation.
   */
  async executeTool(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    budget: number,
  ): Promise<{ block: ToolResultBlock; bytes: number }> {
    return this.withGovernedExecutionBridge(ctx, async () => {
      const text = await this.produceToolOutput(tool, use, ctx, budget);
      return this.settleToolOutput(tool, use, text, budget);
    });
  }

  /**
   * Async "produce" phase: run the tool, serialize, scrub, and spill an
   * oversized output to a disk artifact. Returns the pre-cap text. This is
   * the long-running, concurrency-safe part — it touches NO shared budget
   * state, so multiple invocations can run in parallel without racing.
   *
   * The `budgetHint` only gates the disk-spill threshold (a heuristic for
   * "is this output large enough to persist"); it is NOT the output cap.
   * The authoritative cap is applied synchronously in settleToolOutput()
   * against the live budget.
   */
  private async produceToolOutput(
    tool: Tool,
    use: ToolUseBlock,
    ctx: Context,
    budgetHint: number,
  ): Promise<string> {
    this.opts.events?.emit('tool.started', {
      sessionId: ctx.session.id,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      name: tool.name,
      id: use.id,
      input: use.input,
    });
    this.opts.renderer?.writeToolCall(tool.name, use.input);
    const output = await this.runWithTimeout(tool, use.input, ctx.signal, ctx, use.id);
    const text = this.serializer.serialize(output, { toolName: tool.name, input: use.input, tool });
    const scrubbed = this.opts.secretScrubber.scrub(text);
    return maybePersistLargeToolOutput(tool.name, scrubbed, budgetHint);
  }

  /**
   * Synchronous "settle" phase: enforce the output cap against the CURRENT
   * budget, render, and build the result block. This MUST stay synchronous
   * (no awaits) so that, in the parallel/smart strategies, two tools settling
   * one after another against the shared closure budget can't interleave a
   * stale read with a write. The first to settle consumes its bytes; the next
   * settles against the reduced budget; once the budget hits 0, enforceCap
   * truncates — making the per-iteration cap genuinely CUMULATIVE across
   * parallel tools instead of degrading into a per-tool cap.
   */
  private settleToolOutput(
    tool: Tool,
    use: ToolUseBlock,
    text: string,
    budget: number,
  ): { block: ToolResultBlock; bytes: number } {
    // enforceCap already walks the text to compute bytes for the budget
    // cap. Carry the residual budget back as `bytes` so the caller can
    // deduct the spend without a second `Buffer.byteLength` walk — and
    // never falls back to `JSON.stringify` on a structured value.
    const { text: capped, newBudget } = this.serializer.enforceCap(text, budget);
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
    // A small number of orchestration tools (notably `delegate`) implement
    // their own heartbeat-aware timeout policy. Applying the executor's fixed
    // max-tool ceiling on top would abort healthy multi-hour work after five
    // minutes. They still run through the abort race below with parentSignal,
    // so /interrupt and session cancellation remain immediate.
    const combined = tool.managesOwnTimeout
      ? parentSignal
      : AbortSignal.any([
          parentSignal,
          AbortSignal.timeout(
            clampTimeoutMs(tool.timeoutMs ?? this.iterationTimeoutMs, this.maxToolTimeoutMs),
          ),
        ]);

    let output: unknown;
    // Streaming variant takes precedence — yields progress events, then
    // a final 'final' event with the typed output. Tools that don't
    // implement executeStream fall through to the standard execute path.
    // The async IIFE also captures a synchronous throw from execute() as
    // a rejection so the race below observes it.
    const execute = () => typeof tool.executeStream === 'function'
      ? this.runStreamedTool(tool, input, ctx, combined, toolUseId)
      : (async () => tool.execute(input, ctx, { signal: combined }))();
    const telemetryToolCallId = toolUseId ?? `nested-${randomUUID()}`;
    const toolPromise: Promise<unknown> = this.opts.events
      ? runWithNetworkTelemetry({
          events: this.opts.events!, sessionId: ctx.session.id,
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}), ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          toolCallId: telemetryToolCallId, initiator: 'tool', operationName: tool.name,
        }, () => runWithProcessTelemetry(
          {
            events: this.opts.events!,
            sessionId: ctx.session.id,
            ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
            ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
            toolCallId: telemetryToolCallId,
            toolName: tool.name,
          },
          execute,
        ))
      : execute();
    // Side branch: when the race exits early on abort, the still-running
    // tool promise must not surface its eventual rejection as an
    // unhandled-rejection crash.
    toolPromise.catch(() => {});
    try {
      // Race the tool against the combined abort/timeout signal. A tool
      // that honors the signal rejects on its own; a tool that IGNORES it
      // (e.g. a blocking fleet wait like `delegate` or `await_tasks`)
      // would otherwise pin the agent loop forever — the abort check in
      // agent-loop only runs after executeTools() settles. The race
      // guarantees the executor itself unblocks the moment the signal
      // fires, so /interrupt, Esc, and timeouts can always unwind the run.
      output = await new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          // One macrotask of grace: a signal-honoring tool typically rejects
          // with its own (richer) error from its abort listener, which ran
          // before this one. Deferring our generic rejection past the pending
          // microtask chain (promise adoption included) lets the tool's error
          // win, while a signal-IGNORING tool is still cut off within ~1ms.
          setTimeout(() => reject(abortReasonToError(combined.reason)), 0);
        };
        combined.addEventListener('abort', onAbort, { once: true });
        toolPromise.then(
          (v) => {
            combined.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e) => {
            combined.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      });
    } catch (err) {
      // If aborted, run cleanup before re-throwing so the tool can release
      // resources (child processes, file handles, network connections).
      if (combined.aborted) await this.runToolCleanup(tool, input, ctx);
      throw err;
    }
    // The tool returned without throwing, but the signal may have aborted
    // in the same tick a signal-ignoring tool resolved. Treat that as an
    // abort: clean up and surface the abort to the caller so a late, stale
    // result is never returned as success.
    if (combined.aborted) {
      await this.runToolCleanup(tool, input, ctx);
      throw abortReasonToError(combined.reason);
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
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
        agentId: ctx.agentId,
        agentName: ctx.agentName,
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
          if (ev.data?.['livePreview'] === true) {
            flushProgressTail(true);
            emitProgress(ev);
            continue;
          }
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

/** Normalize an AbortSignal reason (Error | string | undefined) to an Error. */
function abortReasonToError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === 'string' ? reason : 'tool timeout');
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
const TOOL_OUTPUT_ARTIFACT_PREVIEW_BYTES = 12 * 1024;
const TOOL_OUTPUT_ARTIFACT_OMISSION = '\n…[artifact middle omitted]…\n';

/**
 * Classify a tool execution error into a structured ToolErrorCategory.
 * Used for observability (span attributes) and retry strategy decisions.
 */
export function classifyToolError(err: unknown): {
  category: ToolErrorCategory;
  retryable: boolean;
  detail?: string;
} {
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
      wse.severity === 'warning' ? ToolErrorCategoryEnum.TRANSIENT : ToolErrorCategoryEnum.FATAL;
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
function httpStatusToCategory(status: number): {
  category: ToolErrorCategory;
  retryable: boolean;
  detail: string;
} {
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    return { category: ToolErrorCategoryEnum.TRANSIENT, retryable: true, detail: `HTTP ${status}` };
  }
  if (status === 404 || status === 410) {
    return {
      category: ToolErrorCategoryEnum.NOT_FOUND,
      retryable: false,
      detail: `HTTP ${status}`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      category: ToolErrorCategoryEnum.PERMISSION,
      retryable: false,
      detail: `HTTP ${status}`,
    };
  }
  if (status === 400) {
    return {
      category: ToolErrorCategoryEnum.VALIDATION,
      retryable: false,
      detail: `HTTP ${status}`,
    };
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
    const marker =
      `[full tool output: ${bytes} bytes at ${filePath}; ` +
      'read/grep that file selectively instead of re-running or requesting more output]';
    const fixedBytes = Buffer.byteLength(marker + TOOL_OUTPUT_ARTIFACT_OMISSION, 'utf8');
    const previewBytes = Math.min(
      TOOL_OUTPUT_ARTIFACT_PREVIEW_BYTES,
      Math.max(0, budget - fixedBytes),
    );
    if (previewBytes < 256) return marker;

    const headBudget = Math.ceil(previewBytes / 2);
    const tailBudget = previewBytes - headBudget;
    const head = sliceUtf8Prefix(content, headBudget);
    const tail = sliceUtf8Suffix(content, tailBudget);
    return `${marker}\n${head}${TOOL_OUTPUT_ARTIFACT_OMISSION}${tail}`;
  } catch {
    return content;
  }
}

function hashPermissionInput(
  input: unknown,
  scrubber: ToolExecutorOptions['secretScrubber'],
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? '';
  } catch {
    serialized = String(input);
  }
  return createHash('sha256').update(scrubber.scrub(serialized), 'utf8').digest('hex');
}

function sliceUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

function sliceUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const chars = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - chars), 'utf8') <= maxBytes) low = chars;
    else high = chars - 1;
  }
  let start = text.length - low;
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  return text.slice(start);
}
