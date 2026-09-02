import { isDeepStrictEqual } from 'node:util';
import type { Context } from '../core/context.js';
import { evaluateToolKanbanBoundary } from '../security/kanban-boundary.js';
import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';
import type { ToolExecutorOptions } from '../types/tool-executor.js';
import { coerceAgainstSchema, validateAgainstSchema } from '../utils/json-schema-validate.js';
import { blockedByHookResult, malformedInputResult } from './tool-executor-results.js';
import { extractMalformedRaw, hasMalformedArguments } from './tool-executor-support.js';

export type KanbanBoundaryResult = Awaited<ReturnType<typeof evaluateToolKanbanBoundary>>;

export interface PreExecutionValidationResult {
  ok: boolean;
  use: ToolUseBlock;
  errorResult?: ToolResultBlock | undefined;
  preToolContext?: { text: string; contextAs: 'inline' | 'separate' } | undefined;
  boundary?: KanbanBoundaryResult | undefined;
}

export async function validateToolInputAndHooks(
  tool: Tool,
  use0: ToolUseBlock,
  ctx: Context,
  opts: ToolExecutorOptions,
): Promise<PreExecutionValidationResult> {
  let use = use0;
  let preToolContext: { text: string; contextAs: 'inline' | 'separate' } | undefined;

  if (hasMalformedArguments(use.input)) {
    return {
      ok: false,
      use,
      errorResult: malformedInputResult(use, extractMalformedRaw(use.input)),
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
          `Fix exactly the fields listed above and call the tool again. ` +
          `You can use the "tool-help" tool with name="${tool.name}" to see the exact expected schema.`,
        is_error: true,
      };
      return { ok: false, use, errorResult };
    }
  }

  if (opts.hookRunner?.has('PreToolUse')) {
    const pre = await opts.hookRunner.preToolUse(tool.name, use.input, ctx, {
      capabilities: tool.capabilities,
      mutating: tool.mutating,
    });
    if (pre.block) {
      return {
        ok: false,
        use,
        errorResult: blockedByHookResult(use, pre.reason),
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
              `Validation errors:\n${errorDetails}`,
            is_error: true,
          };
          return { ok: false, use, errorResult };
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
          `Invalid arguments for tool "${tool.name}".\n\n` + `Validation errors:\n${errorDetails}`,
        is_error: true,
      };
      return { ok: false, use, errorResult };
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
    return { ok: false, use, errorResult, boundary };
  }

  return { ok: true, use, preToolContext, boundary };
}
