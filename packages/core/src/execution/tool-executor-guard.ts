import { isDeepStrictEqual } from 'node:util';
import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Tool, ToolSettlement } from '@wrongstack/contracts/types/tool';
import type { Context } from '../core/context.js';
import { evaluateToolKanbanBoundary } from '../security/kanban-boundary.js';
import { coerceAgainstSchema, validateAgainstSchema } from '../utils/json-schema-validate.js';
import type { ToolExecutorOptions } from './tool-executor-options.js';
import {
  blockedByHookResult,
  malformedInputResult,
  toolInputCorrection,
} from './tool-executor-results.js';
import { extractMalformedRaw, hasMalformedArguments } from './tool-executor-support.js';

export type KanbanBoundaryResult = Awaited<ReturnType<typeof evaluateToolKanbanBoundary>>;

export interface PreExecutionValidationResult {
  ok: boolean;
  use: ToolUseBlock;
  errorResult?: ToolResultBlock | undefined;
  /** Why the call was refused; set whenever `ok` is false. */
  settlement?: ToolSettlement | undefined;
  preToolContext?: { text: string; contextAs: 'inline' | 'separate' } | undefined;
  boundary?: KanbanBoundaryResult | undefined;
  /**
   * PreToolUse hooks ran before the call was refused. Claim-taking hooks
   * (WrongTrace's file lock) may hold state only their skip-cleanup half
   * releases, so the executor must run `toolSkipped` for such a refusal.
   */
  preToolUseRan?: boolean | undefined;
}

export async function validateToolInputAndHooks(
  tool: Tool,
  use0: ToolUseBlock,
  ctx: Context,
  opts: ToolExecutorOptions,
): Promise<PreExecutionValidationResult> {
  let use = use0;
  let preToolContext: { text: string; contextAs: 'inline' | 'separate' } | undefined;
  let preToolUseRan = false;

  if (hasMalformedArguments(use.input)) {
    return {
      ok: false,
      use,
      errorResult: malformedInputResult(use, tool, extractMalformedRaw(use.input), ctx.messages),
      settlement: 'invalid_input',
    };
  }

  const validation = validateAgainstSchema(use.input, tool.inputSchema);
  if (!validation.ok) {
    const coercion = coerceAgainstSchema(use.input, tool.inputSchema);
    const revalidation = coercion.changed
      ? validateAgainstSchema(coercion.value, tool.inputSchema)
      : validation;
    if (coercion.changed && revalidation.ok) {
      opts.logger?.info('tool arguments coerced to match inputSchema', {
        tool: tool.name,
        id: use.id,
      });
      use = { ...use, input: coercion.value as Record<string, unknown> };
    } else {
      const errorDetails = revalidation.errors
        .map((e) => `  - ${e.path || 'input'}: ${e.message}`)
        .join('\n');

      const errorResult: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: use.id,
        content:
          `Invalid arguments for tool "${tool.name}".\n\n` +
          `Validation errors:\n${errorDetails}\n\n` +
          `Fix the arguments using the registered contract below.` +
          toolInputCorrection(
            tool,
            ctx.messages,
            revalidation.errors.map((e) => e.path),
          ),
        is_error: true,
      };
      return { ok: false, use, errorResult, settlement: 'invalid_input' };
    }
  }

  if (opts.hookRunner?.has('PreToolUse')) {
    const pre = await opts.hookRunner.preToolUse(tool.name, use.input, ctx, {
      capabilities: tool.capabilities,
      mutating: tool.mutating,
    });
    preToolUseRan = true;
    if (pre.block) {
      return {
        ok: false,
        use,
        errorResult: blockedByHookResult(use, pre.reason),
        settlement: 'blocked_by_hook',
        preToolUseRan,
      };
    }
    if (pre.additionalContext) {
      preToolContext = {
        text: pre.additionalContext,
        contextAs: pre.contextAs === 'separate' ? 'separate' : 'inline',
      };
    }
    if (pre.input) {
      if (!isDeepStrictEqual(pre.input, use.input)) {
        const reval = validateAgainstSchema(pre.input, tool.inputSchema);
        if (!reval.ok) {
          const errorDetails = reval.errors
            .map((e) => `  - ${e.path || 'input'}: ${e.message}`)
            .join('\n');
          const errorResult: ToolResultBlock = {
            type: 'tool_result',
            tool_use_id: use.id,
            content:
              `A PreToolUse hook rewrote the arguments for "${tool.name}" into an invalid shape.\n\n` +
              `Validation errors:\n${errorDetails}` +
              toolInputCorrection(
                tool,
                ctx.messages,
                reval.errors.map((e) => e.path),
              ),
            is_error: true,
          };
          return { ok: false, use, errorResult, settlement: 'blocked_by_hook', preToolUseRan };
        }
        use = { ...use, input: pre.input };
      }
    }
  }

  if (typeof tool.validate === 'function') {
    const crossFieldErrors = tool.validate(use.input);
    if (crossFieldErrors.length > 0) {
      const errorDetails = crossFieldErrors.map((e) => `  - ${e}`).join('\n');
      const errorResult: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: use.id,
        content:
          `Invalid arguments for tool "${tool.name}".\n\n` +
          `Validation errors:\n${errorDetails}` +
          toolInputCorrection(tool, ctx.messages),
        is_error: true,
      };
      return { ok: false, use, errorResult, settlement: 'invalid_input', preToolUseRan };
    }
  }

  const boundary = await evaluateToolKanbanBoundary(tool, use.input, ctx, {
    requireGovernance: opts.requireKanbanGovernance,
  });
  if (boundary.decision === 'block') {
    const errorResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: use.id,
      content: `Tool "${tool.name}" blocked by Kanban boundary. ${boundary.reason ?? ''}`.trim(),
      is_error: true,
      _kanbanBoundary: boundary,
    };
    return {
      ok: false,
      use,
      errorResult,
      boundary,
      settlement: 'denied_by_policy',
      preToolUseRan,
    };
  }

  return { ok: true, use, preToolContext, boundary };
}
