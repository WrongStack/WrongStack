import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { Tracer } from '../types/observability.js';
import type { Provider, Request, Response } from '../types/provider.js';
import { ProviderError } from '../types/provider.js';
import { toWrongStackError } from '../types/errors.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { Context } from './context.js';
import { streamProviderToResponse } from './streaming-response-builder.js';

/** Fields worth including in every provider-run log for cross-correlation. */
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
  ctx: Context;
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
  let attempt = 0;
  for (;;) {
    const span = tracer?.startSpan('provider.complete', {
      'provider.id': provider.id,
      'provider.model': request.model,
      'provider.streaming': provider.capabilities.streaming,
      'provider.attempt': attempt,
    });
    logger.debug(`Provider attempt ${attempt + 1} starting`, providerLogCtx(provider, request));
    try {
      const res = provider.capabilities.streaming
        ? await streamProviderToResponse(provider, request, signal, ctx, events, logger)
        : await provider.complete(request, { signal });
      span?.setAttribute('provider.stopReason', res.stopReason);
      span?.setAttribute('provider.usage_in', res.usage.input);
      span?.setAttribute('provider.usage_out', res.usage.output);
      span?.end();
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
      const isProviderErr = err instanceof ProviderError;
      const errAsErr = err instanceof Error ? err : new Error(String(err));
      const canRetry = retry.shouldRetry(isProviderErr ? err : errAsErr, attempt);
      const description = isProviderErr ? (err as ProviderError).describe() : errAsErr.message;
      if (!canRetry) {
        if (isProviderErr) {
          events.emit('provider.error', {
            sessionId: ctx.session.id,
            providerId: (err as ProviderError).providerId,
            status: (err as ProviderError).status,
            description,
            retryable: false,
          });
        }
        logger.error(`Provider call failed after ${attempt + 1} attempt(s) — ${description}`, {
          ...providerLogCtx(provider, request),
          attempts: attempt + 1,
          errorDescription: description,
          status: isProviderErr ? (err as ProviderError).status : undefined,
          errorName: err instanceof Error ? err.name : undefined,
          errorStack: err instanceof Error ? err.stack?.split('\n').slice(0, 3).join('\n') : undefined,
        });
        // ProviderError already extends WrongStackError — passes through unchanged.
        // Raw Errors (network, timeout) get wrapped so callers can branch on .code
        // instead of parsing error messages.
        throw toWrongStackError(err);
      }
      const delay = Math.round(retry.delayMs(attempt));
      const attemptNum = attempt + 1;
      const maxAttempts = retry.maxAttempts(isProviderErr ? (err as ProviderError) : errAsErr);
      logger.warn(`Provider retry ${attemptNum}/${maxAttempts} in ${delay}ms — ${description}`, {
        ...providerLogCtx(provider, request),
        attempt: attemptNum,
        maxAttempts,
        delayMs: delay,
        errorDescription: description,
        status: isProviderErr ? (err as ProviderError).status : undefined,
      });
      if (isProviderErr) {
        events.emit('provider.retry', {
          sessionId: ctx.session.id,
          providerId: (err as ProviderError).providerId,
          attempt: attemptNum,
          delayMs: delay,
          status: (err as ProviderError).status,
          description,
        });
      }
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
        }, delay);
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
