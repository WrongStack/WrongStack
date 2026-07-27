import { type Context, resolveEventSessionId } from '../core/context.js';
import { ToolError } from '../types/errors.js';
import type { Tool, ToolProgressEvent } from '../types/tool.js';
import type { ToolExecutorOptions } from '../types/tool-executor.js';

interface StreamedToolExecutionOptions {
  tool: Tool;
  input: unknown;
  ctx: Context;
  signal: AbortSignal;
  toolUseId: string | undefined;
  events: ToolExecutorOptions['events'];
  progressEmitIntervalMs: number;
  progressTailChars: number;
  progressHeadChars: number;
}

export async function executeStreamedTool({
  tool,
  input,
  ctx,
  signal,
  toolUseId,
  events,
  progressEmitIntervalMs,
  progressTailChars,
  progressHeadChars,
}: StreamedToolExecutionOptions): Promise<unknown> {
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
  const iter = stream[Symbol.asyncIterator]();
  let progressTail = '';
  let progressHead = '';
  let headComplete = false;
  let lastProgressEmitAt = 0;
  const emitProgress = (ev: ToolProgressEvent) => {
    events?.emit('tool.progress', {
      sessionId: resolveEventSessionId(ctx),
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
    if (!force && now - lastProgressEmitAt < progressEmitIntervalMs) return;
    lastProgressEmitAt = now;
    const text =
      force && headComplete && progressTail.length > 0
        ? `${progressHead}\n[...output truncated...]\n${progressTail}`
        : progressTail;
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
        break;
      }
      if (ev.type === 'partial_output' && typeof ev.text === 'string') {
        if (ev.data?.['livePreview'] === true) {
          flushProgressTail(true);
          emitProgress(ev);
          continue;
        }
        if (!headComplete) {
          const remaining = progressHeadChars - progressHead.length;
          if (ev.text.length <= remaining) {
            progressHead += ev.text;
          } else {
            progressHead += ev.text.slice(0, remaining);
            headComplete = true;
          }
        }
        progressTail += ev.text;
        if (progressTail.length > progressTailChars) {
          progressTail = progressTail.slice(-progressTailChars);
        }
        flushProgressTail(false);
        continue;
      }
      flushProgressTail(true);
      emitProgress(ev);
    }
    flushProgressTail(true);
  } finally {
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
