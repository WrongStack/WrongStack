import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { Tracer } from '../types/observability.js';
import type { Provider, Request, Response } from '../types/provider.js';
import { ProviderError } from '../types/provider.js';
import { toWrongStackError } from '../types/errors.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import { resolveEventSessionId } from './context.js';
import type { AgentContext } from '../types/context.js';
import { streamProviderToResponse } from './streaming-response-builder.js';
import { createChroniclePromptManifest } from '../chronicle/prompt-manifest.js';
import { runWithNetworkTelemetry } from '../observability/network-telemetry.js';
import { scrubErrorText } from '../security/error-sanitize.js';

/** Fields worth including in every provider-run log for cross-correlation. */
function scrubProviderBody(body: ProviderError['body']): ProviderError['body'] {
  if (!body) return undefined;
  return {
    ...body,
    ...(body.type !== undefined ? { type: scrubErrorText(body.type) } : {}),
    ...(body.message !== undefined ? { message: scrubErrorText(body.message) } : {}),
    ...(body.raw !== undefined ? { raw: scrubErrorText(body.raw) } : {}),
    ...(body.requestId !== undefined ? { requestId: scrubErrorText(body.requestId) } : {}),
  };
}

function providerLogCtx(p: Provider, r: Request): Record<string, unknown> {
  return {
    providerId: p.id,
    model: r.model,
    streaming: p.capabilities.streaming,
    msgCount: r.messages.length,
    toolCount: r.tools?.length ?? 0,
  };
}

export interface RunProviderOptions {
  provider: Provider;
  request: Request;
  signal: AbortSignal;
  ctx: AgentContext;
  events: EventBus;
  retry: RetryPolicy;
  logger: Logger;
  tracer?: Tracer | undefined;
}

/**
 * Call a provider with the retry policy applied. Emits `provider.retry`
 * before each retry and `provider.error` once when the retries are
 * exhausted. Streaming providers route through the streaming-response
 * builder so deltas reach the renderer.
 */
export async function runProviderWithRetry(opts: RunProviderOptions): Promise<Response> {
  const { provider, request, signal, ctx, events, retry, logger, tracer } = opts;
  const logicalRequestId = randomUUID();
  const promptManifest = createChroniclePromptManifest(request);
  // Keep the request identity alive after the provider response returns: the
  // following tool calls are the materialized effects of this exact prompt.
  ctx.activeLogicalRequestId = logicalRequestId;
  ctx.activePromptManifestId = promptManifest.manifestId;
  let attempt = 0;
  for (;;) {
    const attemptId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedNs = process.hrtime.bigint();
    const correlation = {
      sessionId: resolveEventSessionId(ctx),
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      logicalRequestId,
      promptManifestId: promptManifest.manifestId,
      attemptId,
      attempt,
      providerId: provider.id,
      model: request.model,
      taskId: ctx.currentKanbanTaskId,
      boardId: ctx.currentKanbanBoardId,
    };
    events.emit('provider.attempt.started', {
      ...correlation,
      streaming: provider.capabilities.streaming,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      promptManifest,
      startedAt,
    });
    const span = tracer?.startSpan('provider.complete', {
      'provider.id': provider.id,
      'provider.model': request.model,
      'provider.streaming': provider.capabilities.streaming,
      'provider.attempt': attempt,
    });
    logger.debug(`Provider attempt ${attempt + 1} starting`, providerLogCtx(provider, request));
    try {
      const res = await runWithNetworkTelemetry(
        {
          events,
          sessionId: resolveEventSessionId(ctx),
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          attemptId,
          initiator: 'provider',
          operationName: `${provider.id}.complete`,
        },
        () =>
          provider.capabilities.streaming
            ? streamProviderToResponse(provider, request, signal, ctx, events, logger)
            : provider.complete(request, { signal }),
      );
      span?.setAttribute('provider.stopReason', res.stopReason);
      span?.setAttribute('provider.usage_in', res.usage.input);
      span?.setAttribute('provider.usage_out', res.usage.output);
      span?.end();
      events.emit('provider.attempt.completed', {
        ...correlation,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedNs),
        stopReason: res.stopReason,
        usage: res.usage,
      });
      logger.debug('Provider call succeeded', {
        ...providerLogCtx(provider, request),
        stopReason: res.stopReason,
        usageInput: res.usage.input,
        usageOutput: res.usage.output,
        cacheRead: res.usage.cacheRead,
        cacheWrite: res.usage.cacheWrite,
        attempts: attempt + 1,
      });
      return res;
    } catch (err) {
      if (err instanceof Error) span?.recordError(err);
      span?.end();
      if (signal.aborted) throw err;
      const isProviderErr = err instanceof ProviderError || ProviderError.isProviderError(err);
      const errAsErr = err instanceof Error ? err : new Error(String(err));
      const canRetry = retry.shouldRetry(isProviderErr ? err : errAsErr, attempt);
      const providerErrorBody = isProviderErr
        ? scrubProviderBody((err as ProviderError).body)
        : undefined;
      const description = scrubErrorText(
        isProviderErr ? (err as ProviderError).describe() : errAsErr.message,
      );
      const delay = canRetry
        ? Math.round(retry.delayMs(attempt, isProviderErr ? (err as ProviderError) : errAsErr))
        : undefined;
      events.emit('provider.attempt.failed', {
        ...correlation,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: elapsedMs(startedNs),
        status: isProviderErr ? err.status : 0,
        failureKind: isProviderErr ? err.kind : 'unknown',
        description,
        retryable: canRetry,
        retryScheduled: canRetry,
        ...(delay !== undefined ? { retryDelayMs: delay } : {}),
        ...(providerErrorBody?.requestId ? { providerRequestId: providerErrorBody.requestId } : {}),
        ...(providerErrorBody ? { errorBody: providerErrorBody } : {}),
      });
      if (!canRetry) {
        events.emit('provider.error', {
          sessionId: resolveEventSessionId(ctx),
          providerId: isProviderErr ? err.providerId : provider.id,
          status: isProviderErr ? err.status : 0,
          description,
          retryable: false,
          ...(providerErrorBody ? { errorBody: providerErrorBody } : {}),
        });
        logger.error(`Provider call failed after ${attempt + 1} attempt(s) — ${description}`, {
          ...providerLogCtx(provider, request),
          attempts: attempt + 1,
          errorDescription: description,
          status: isProviderErr ? (err as ProviderError).status : undefined,
          errorBody: providerErrorBody,
          errorName: err instanceof Error ? err.name : undefined,
          errorStack:
            err instanceof Error ? err.stack?.split('\n').slice(0, 3).join('\n') : undefined,
        });
        // ProviderError already extends WrongStackError — passes through unchanged.
        // Raw Errors (network, timeout) get wrapped so callers can branch on .code
        // instead of parsing error messages.
        throw toWrongStackError(err);
      }
      const attemptNum = attempt + 1;
      const maxAttempts = retry.maxAttempts(isProviderErr ? (err as ProviderError) : errAsErr);
      logger.warn(`Provider retry ${attemptNum}/${maxAttempts} in ${delay}ms — ${description}`, {
        ...providerLogCtx(provider, request),
        attempt: attemptNum,
        maxAttempts,
        delayMs: delay,
        errorDescription: description,
        status: isProviderErr ? (err as ProviderError).status : undefined,
        errorBody: providerErrorBody,
      });
      events.emit('provider.retry', {
        sessionId: resolveEventSessionId(ctx),
        providerId: isProviderErr ? err.providerId : provider.id,
        attempt: attemptNum,
        delayMs: delay!,
        status: isProviderErr ? err.status : 0,
        description,
        ...(providerErrorBody ? { errorBody: providerErrorBody } : {}),
      });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        // Single teardown for both outcomes (timer fires OR signal aborts) so
        // the two branches can't drift: always clear the pending timer AND
        // remove the abort listener. removeEventListener is a no-op once the
        // listener has fired, but calling it unconditionally guarantees no
        // listener survives the wait — even on the abort-wins path — which is
        // what prevents abort listeners from accumulating across retries on a
        // long-lived signal.
        const cleanup = () => {
          clearTimeout(t);
          signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('aborted'));
        };
        const t = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }, delay!);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);
      });
      attempt++;
    }
  }
}

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}
import { randomUUID } from 'node:crypto';
