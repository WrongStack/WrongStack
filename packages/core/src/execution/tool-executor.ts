import type { Context } from '../core/context.js';
import {
  getDangerousCapabilities,
  hasDangerousCapabilityForSubagents,
} from '../security/capabilities.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { Tool, ToolProgressEvent } from '../types/tool.js';
import type {
  ToolBatchResult,
  ToolConfirmPendingResult,
  ToolExecutionOutput,
  ToolExecutorOptions,
  ToolExecutorStrategy,
} from '../types/tool-executor.js';
import { expectDefined } from '../utils/expect-defined.js';
import { validateAgainstSchema } from '../utils/json-schema-validate.js';
import { createToolOutputSerializer } from '../utils/tool-output-serializer.js';
export class ToolExecutor {
  /** Minimum gap between coalesced `partial_output` tool.progress emits. */
  static readonly PROGRESS_EMIT_INTERVAL_MS = 100;
  /** Max chars of accumulated stream text carried per coalesced emit. */
  static readonly PROGRESS_TAIL_CHARS = 16_384;

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

      if (toolDangerousCaps.length > 0 && effectivePermission === 'auto' && !yolo) {
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
          const suggestedPattern =
            this.subjectFor(tool.name, use.input, tool.subjectKey) ?? tool.name;
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
      const span = this.opts.tracer?.startSpan(`tool.${tool.name}`, {
        'tool.name': tool.name,
        'tool.mutating': tool.mutating,
        'tool.permission': tool.permission,
        'tool.capabilities': JSON.stringify(tool.capabilities ?? []),
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
        span?.setAttribute('tool.is_error', !!result.is_error);
        span?.setAttribute(
          'tool.output_bytes',
          typeof result.content === 'string' ? result.content.length : 0,
        );
        return { result, tool, durationMs: Date.now() - start };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
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
        const msg = err instanceof Error ? err.message : String(err);
        const scrubbed = this.opts.secretScrubber.scrub(msg);
        const result = {
          type: 'tool_result' as const,
          tool_use_id: use.id,
          content: `Tool "${use.name}" execution failed: ${scrubbed}`,
          is_error: true,
        };
        budget = this.budgetForString(result.content, budget);
        return { result, tool: this.registry.get(use.name), durationMs: 0 };
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
      name: tool.name,
      id: use.id,
      input: use.input,
    });
    this.opts.renderer?.writeToolCall(tool.name, use.input);
    const output = await this.runWithTimeout(tool, use.input, ctx.signal, ctx, use.id);
    const text = this.serializer.serialize(output);
    const scrubbed = this.opts.secretScrubber.scrub(text);
    // enforceCap already walks the text to compute bytes for the budget
    // cap. Carry the residual budget back as `bytes` so the caller can
    // deduct the spend without a second `Buffer.byteLength` walk — and
    // never falls back to `JSON.stringify` on a structured value.
    const { text: capped, newBudget } = this.serializer.enforceCap(scrubbed, budget);
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('tool timeout')), timeoutMs);
    const combined = AbortSignal.any([parentSignal, ctrl.signal]);
    let cleanupCalled = false;
    let caught = false;
    try {
      // Streaming variant takes precedence — yields progress events, then
      // a final 'final' event with the typed output. Tools that don't
      // implement executeStream fall through to the standard execute path.
      if (typeof tool.executeStream === 'function') {
        return await this.runStreamedTool(tool, input, ctx, combined, toolUseId);
      }
      return await tool.execute(input, ctx, { signal: combined });
    } catch (err) {
      caught = true;
      if (combined.aborted && typeof tool.cleanup === 'function') {
        // Best-effort cleanup; never let it mask the original error.
        cleanupCalled = true;
        try {
          await tool.cleanup(input, ctx);
        } catch {
          /* swallow */
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
      // If the tool completed successfully (no error thrown) but the combined
      // signal was aborted (e.g. timeout), the catch block above never fired.
      // Call cleanup here and then throw so the caller sees the abort.
      // When `caught` is true, we already have an in-flight throw — don't
      // override it from `finally` (that would replace the original error
      // with the abort reason and mask the actual failure).
      if (combined.aborted && !caught) {
        if (!cleanupCalled && typeof tool.cleanup === 'function') {
          try {
            await tool.cleanup(input, ctx);
          } catch {
            /* swallow */
          }
        }
        const reason =
          combined.reason instanceof Error
            ? combined.reason
            : new Error(typeof combined.reason === 'string' ? combined.reason : 'aborted');
        // biome-ignore lint/correctness/noUnsafeFinally: guarded by `!caught` — only runs when the tool returned cleanly but the signal aborted, so there is no in-flight exception to override.
        throw reason;
      }
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
      throw new Error(`Tool "${tool.name}" does not support streaming execution`);
    }
    const stream = tool.executeStream(input, ctx, { signal });
    // Manual iteration so we can explicitly close the async iterator after
    // receiving the final event, ensuring any cleanup in the tool's generator
    // finally block runs regardless of whether the engine calls return() on
    // break of a for-await-of loop.
    const iter = stream[Symbol.asyncIterator]();
    // Coalesce `partial_output` progress into at most one EventBus emit per
    // PROGRESS_EMIT_INTERVAL_MS, carrying only the most recent
    // PROGRESS_TAIL_CHARS of accumulated text. A chatty child process (a test
    // suite or build spewing ANSI progress) can stream hundreds of MB per
    // minute through executeStream; emitting every flush as its own event
    // floods every bus subscriber (TUI render per dispatch, session bridge,
    // WebUI broadcast) and has OOM'd the host. The live tail only ever shows
    // the last few KB, so coalescing loses nothing the UI can display —
    // the tool's own capped `final` output is unaffected.
    let progressTail = '';
    let lastProgressEmitAt = 0;
    const emitProgress = (ev: ToolProgressEvent) => {
      this.opts.events?.emit('tool.progress', {
        name: tool.name,
        id: toolUseId ?? '<unknown>',
        event: ev,
      });
    };
    const flushProgressTail = (force: boolean) => {
      if (progressTail.length === 0) return;
      const now = Date.now();
      if (!force && now - lastProgressEmitAt < ToolExecutor.PROGRESS_EMIT_INTERVAL_MS) return;
      const text = progressTail;
      progressTail = '';
      lastProgressEmitAt = now;
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
      throw new Error(`tool "${tool.name}" executeStream completed without a 'final' event`);
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

  /**
   * Compute the suggestedPattern string for a tool+input pair.
   * Matches the logic in DefaultPermissionPolicy so the TUI shows the
   * same subject that the trust file would use.
   */
  private subjectFor(toolName: string, input: unknown, subjectKey?: string): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const obj = input as Record<string, unknown>;
    const globChars = /[*?[\]]/g;
    const escapeGlob = (s: string) => s.replace(globChars, (c) => `\\${c}`);
    const normalizePath = (s: string) => escapeGlob(s.replace(/\\/g, '/'));

    // Mirror DefaultPermissionPolicy.subjectFor — keep both in sync so the
    // TUI's "suggested pattern" matches what the trust file actually uses.
    if (subjectKey) {
      const v = obj[subjectKey];
      if (typeof v === 'string') {
        const isPathKey = subjectKey === 'path' || subjectKey === 'file' || subjectKey === 'files';
        return isPathKey ? normalizePath(v) : escapeGlob(v);
      }
    }

    if (toolName === 'bash' && typeof obj.command === 'string') {
      return escapeGlob(obj.command);
    }
    if (typeof obj.path === 'string') {
      return normalizePath(obj.path);
    }
    if (typeof obj.url === 'string') {
      return escapeGlob(obj.url);
    }
    if (typeof obj.name === 'string') {
      return escapeGlob(obj.name);
    }
    return undefined;
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
 * streaming response builder's `safeJsonOrRaw` uses `_raw`. Keep this list in
 * sync if a new adapter introduces another marker.
 *
 * NOTE: `parseToolInput` and `safeJsonOrRaw` now attempt JSON repair
 * (auto-closing braces and strings) before wrapping — so a truncated blob
 * like `{"old_string": "line1\nline2` gets repaired first. The sentinel is
 * only used when repair also fails.
 */
const MALFORMED_ARG_MARKERS = ['__raw', '__raw_arguments', '_raw'] as const;

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
