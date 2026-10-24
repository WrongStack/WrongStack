import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { HookInput } from '@wrongstack/contracts/types/hooks';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { type Context, resolveEventSessionId } from '../core/context.js';
import type { ToolOutputSerializeContext } from '../utils/tool-output-serializer.js';
import { fingerprintText } from '../utils/tool-result-fingerprint.js';
import { postToolWritePaths } from './post-tool-write-paths.js';
import type { ToolExecutorOptions } from './tool-executor-options.js';
import { runToolWithTimeout } from './tool-executor-runner.js';
import { maybePersistLargeToolOutput, toolProgrammaticOutput } from './tool-executor-support.js';
export interface ToolOutputSettlementHost {
  opts: ToolExecutorOptions;
  runWithTimeout(
    tool: Tool,
    input: unknown,
    parentSignal: AbortSignal,
    ctx: Context,
    toolUseId?: string | undefined,
  ): Promise<unknown>;
  serializer: {
    serialize: (value: unknown, context?: ToolOutputSerializeContext) => string;
    enforceCap: (text: string, remainingBudget: number) => { text: string; newBudget: number };
    capBytes: number;
  };
  hintRenderMode(toolName: string): void;
  iterationTimeoutMs: number;
  maxToolTimeoutMs: number;
  PROGRESS_EMIT_INTERVAL_MS: number;
  PROGRESS_TAIL_CHARS: number;
  PROGRESS_HEAD_CHARS: number;
}

export async function produceToolOutput(
  host: ToolOutputSettlementHost,
  tool: Tool,
  use: ToolUseBlock,
  ctx: Context,
  budgetHint: number,
): Promise<{
  text: string;
  fingerprint: string;
  data?: { value: unknown };
  writePaths: Pick<NonNullable<HookInput['toolResult']>, 'modifiedPaths' | 'modifiedPathsOmitted'>;
}> {
  if (use._resultFormat === 'data' && !tool.outputSchema) {
    throw new Error(
      `Tool "${tool.name}" does not declare structured output; use tools.call instead`,
    );
  }
  host.opts.events?.emit('tool.started', {
    sessionId: resolveEventSessionId(ctx),
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx.activeLogicalRequestId ? { logicalRequestId: ctx.activeLogicalRequestId } : {}),
    ...(ctx.activePromptManifestId ? { promptManifestId: ctx.activePromptManifestId } : {}),
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    name: tool.name,
    id: use.id,
    input: use.input,
    taskId: ctx.currentKanbanTaskId,
    boardId: ctx.currentKanbanBoardId,
    ...(typeof ctx.provider === 'object' ? { provider: (ctx.provider as { id: string }).id } : {}),
    ...(ctx.model ? { model: ctx.model } : {}),
  });
  host.opts.renderer?.writeToolCall(tool.name, use.input);
  const output = await host.runWithTimeout(tool, use.input, ctx.signal, ctx, use.id);
  const data = toolProgrammaticOutput(tool, use, output, host.opts.secretScrubber);
  const text = host.serializer.serialize(output, { toolName: tool.name, input: use.input, tool });
  const scrubbed = host.opts.secretScrubber.scrub(text);
  const content = tool.preserveFullOutput
    ? scrubbed
    : await maybePersistLargeToolOutput(tool.name, scrubbed, budgetHint);
  const writePaths = postToolWritePaths(tool.name, use.input, output, ctx, (value) =>
    host.opts.secretScrubber.scrub(value),
  );
  return {
    text: content,
    fingerprint: fingerprintText(scrubbed),
    writePaths,
    ...(data ? { data } : {}),
  };
}

export function settleToolOutput(
  host: ToolOutputSettlementHost,
  tool: Tool,
  use: ToolUseBlock,
  text: string,
  budget: number,
): { block: ToolResultBlock; bytes: number } {
  const { text: capped, newBudget } = tool.preserveFullOutput
    ? {
        text,
        newBudget: Math.max(0, budget - Buffer.byteLength(text, 'utf8')),
      }
    : host.serializer.enforceCap(text, budget);
  host.hintRenderMode(tool.name);
  host.opts.renderer?.writeToolResult(tool.name, capped, false);
  return {
    block: {
      type: 'tool_result',
      tool_use_id: use.id,
      name: tool.name,
      content: capped,
      is_error: false,
    },
    bytes: budget - newBudget,
  };
}

export async function runWithTimeout(
  host: ToolOutputSettlementHost,
  tool: Tool,
  input: unknown,
  parentSignal: AbortSignal,
  ctx: Context,
  toolUseId?: string | undefined,
): Promise<unknown> {
  return runToolWithTimeout(
    tool,
    input,
    parentSignal,
    ctx,
    host.opts,
    {
      iterationTimeoutMs: host.iterationTimeoutMs,
      maxToolTimeoutMs: host.maxToolTimeoutMs,
      progressEmitIntervalMs: host.PROGRESS_EMIT_INTERVAL_MS,
      progressTailChars: host.PROGRESS_TAIL_CHARS,
      progressHeadChars: host.PROGRESS_HEAD_CHARS,
    },
    toolUseId,
  );
}

export function budgetForString(
  _host: ToolOutputSettlementHost,
  content: string,
  budget: number,
): number {
  return Math.max(0, budget - Buffer.byteLength(content, 'utf8'));
}
