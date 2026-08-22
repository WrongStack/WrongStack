import type { Context } from '../core/context.js';
import type { ToolUseBlock } from '../types/blocks.js';
import { isWrongStackError } from '../types/errors.js';
import type { ToolExecutorOptions } from '../types/tool-executor.js';
import { classifyToolError } from './tool-executor-support.js';

function toolLogBase(
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

export function logToolSuccess(
  opts: ToolExecutorOptions,
  ctx: Context,
  use: ToolUseBlock,
  toolName: string,
  durationMs: number,
  outputChars: number,
): void {
  opts.events?.emit('tool.completed', {
    name: toolName,
    id: use.id,
    sessionId: ctx.session.id,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx.activeLogicalRequestId ? { logicalRequestId: ctx.activeLogicalRequestId } : {}),
    ...(ctx.activePromptManifestId ? { promptManifestId: ctx.activePromptManifestId } : {}),
    agentId: ctx.agentId ?? '<unknown>',
    durationMs,
    outputChars,
  });
  opts.logger?.info('tool execution completed', {
    ...toolLogBase(ctx, use, toolName, durationMs),
    outcome: 'success',
    isError: false,
    outputChars,
  });
}

export function logToolFailure(
  opts: ToolExecutorOptions,
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
  opts.events?.emit('tool.failed', {
    name: toolName,
    id: use.id,
    sessionId: ctx.session.id,
    ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
    ...(ctx.activeLogicalRequestId ? { logicalRequestId: ctx.activeLogicalRequestId } : {}),
    ...(ctx.activePromptManifestId ? { promptManifestId: ctx.activePromptManifestId } : {}),
    agentId: ctx.agentId ?? '<unknown>',
    durationMs,
    category,
    retryable,
    ...(detail ? { detail } : {}),
    ...structuredError,
    taskId: ctx.currentKanbanTaskId,
    boardId: ctx.currentKanbanBoardId,
    ...(typeof ctx.provider === 'object'
      ? { provider: (ctx.provider as { id: string }).id }
      : {}),
    ...(ctx.model ? { model: ctx.model } : {}),
  });
  opts.logger?.warn('tool execution failed', {
    ...toolLogBase(ctx, use, toolName, durationMs),
    outcome: 'failure',
    isError: true,
    errorCategory: category,
    retryable,
    errorDetail: detail,
    ...structuredError,
  });
}
