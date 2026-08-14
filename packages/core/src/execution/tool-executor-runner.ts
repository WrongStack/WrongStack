import { randomUUID } from 'node:crypto';
import type { Context } from '../core/context.js';
import { runWithNetworkTelemetry } from '../observability/network-telemetry.js';
import { runWithProcessTelemetry } from '../observability/process-telemetry.js';
import type { Tool } from '../types/tool.js';
import type { ToolExecutorOptions } from '../types/tool-executor.js';
import { resolveEventSessionId } from '../core/context.js';
import { executeStreamedTool } from './tool-executor-stream.js';
import { abortReasonToError, clampTimeoutMs } from './tool-executor-support.js';

export async function runToolCleanup(tool: Tool, input: unknown, ctx: Context): Promise<void> {
  if (typeof tool.cleanup !== 'function') return;
  try {
    await tool.cleanup(input, ctx);
  } catch {
    /* swallow — never let cleanup mask the original error */
  }
}

export async function runToolWithTimeout(
  tool: Tool,
  input: unknown,
  parentSignal: AbortSignal,
  ctx: Context,
  opts: ToolExecutorOptions,
  config: {
    iterationTimeoutMs: number;
    maxToolTimeoutMs: number;
    progressEmitIntervalMs: number;
    progressTailChars: number;
    progressHeadChars: number;
  },
  toolUseId?: string | undefined,
): Promise<unknown> {
  if (parentSignal.aborted) {
    if (parentSignal.reason instanceof Error) throw parentSignal.reason;
    throw new Error(typeof parentSignal.reason === 'string' ? parentSignal.reason : 'aborted');
  }

  const combined = tool.managesOwnTimeout
    ? parentSignal
    : AbortSignal.any([
        parentSignal,
        AbortSignal.timeout(
          clampTimeoutMs(tool.timeoutMs ?? config.iterationTimeoutMs, config.maxToolTimeoutMs),
        ),
      ]);

  let output: unknown;
  const execute = () =>
    typeof tool.executeStream === 'function'
      ? executeStreamedTool({
          tool,
          input,
          ctx,
          signal: combined,
          toolUseId,
          events: opts.events,
          progressEmitIntervalMs: config.progressEmitIntervalMs,
          progressTailChars: config.progressTailChars,
          progressHeadChars: config.progressHeadChars,
        })
      : (async () => tool.execute(input, ctx, { signal: combined }))();

  const telemetryToolCallId = toolUseId ?? `nested-${randomUUID()}`;
  const toolPromise: Promise<unknown> = opts.events
    ? runWithNetworkTelemetry(
        {
          events: opts.events!,
          sessionId: resolveEventSessionId(ctx),
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          toolCallId: telemetryToolCallId,
          initiator: 'tool',
          operationName: tool.name,
        },
        () =>
          runWithProcessTelemetry(
            {
              events: opts.events!,
              sessionId: resolveEventSessionId(ctx),
              ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
              ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
              toolCallId: telemetryToolCallId,
              toolName: tool.name,
            },
            execute,
          ),
      )
    : execute();

  toolPromise.catch(() => {});
  try {
    output = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
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
    if (combined.aborted) await runToolCleanup(tool, input, ctx);
    throw err;
  }
  if (combined.aborted) {
    await runToolCleanup(tool, input, ctx);
    throw abortReasonToError(combined.reason);
  }
  return output;
}
