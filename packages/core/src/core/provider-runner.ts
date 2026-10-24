import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { toWrongStackError } from '@wrongstack/contracts/types/errors';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Tracer } from '@wrongstack/contracts/types/observability';
import type { Provider, Request, Response } from '@wrongstack/contracts/types/provider';
import { isSafetyPolicyRefusal, ProviderError } from '@wrongstack/contracts/types/provider';
import {
  parseProviderReportedMaxOutput,
  recordProviderReportedMaxOutput,
} from '@wrongstack/contracts/types/provider-output-caps';
import type { ProviderStatusTrackerPort } from '@wrongstack/contracts/types/provider-status';
import type { RetryPolicy } from '@wrongstack/contracts/types/retry-policy';
import { createChroniclePromptManifest } from '../chronicle/prompt-manifest.js';
import { runWithNetworkTelemetry } from '../observability/network-telemetry.js';
import { scrubErrorText } from '../security/error-sanitize.js';
import { adaptDocumentsForModel } from '../utils/document-blocks.js';
import {
  deactivateProxyOnConnectionFailure,
  waitForProxyRoutingSettle,
} from '../wiring/proxy-rewrite.js';
import { resolveEventSessionId } from './context.js';
import { spanSessionAttributes } from './span-session.js';
import { streamProviderToResponse } from './streaming-response-builder.js';

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
  /**
   * Shared provider/model waiting room. When present this runner refuses to
   * put a quarantined (provider, model) pair on the wire and reports every
   * wire outcome back into it. See {@link runProviderWithRetry}.
   */
  statusTracker?: ProviderStatusTrackerPort | undefined;
  /**
   * Stable id for this logical step. Every retry, and every fallback hop an
   * extension takes for the same agent-loop iteration, shares it — so
   * Chronicle, cost and HQ count one step, not one per attempt. Generated
   * when absent (direct callers outside the loop).
   */
  logicalRequestId?: string | undefined;
}

/**
 * Marks a ProviderError whose failure has already been written to the waiting
 * room, so an outer layer (the `fallback-model` extension) does not count the
 * same wire failure twice. `Symbol.for` because the error crosses esbuild
 * subpath-bundle boundaries where class identity is not preserved.
 */
export const PROVIDER_FAILURE_TRACKED = Symbol.for('wrongstack.providerFailureTracked');

/** True when a previous layer already recorded this error in the waiting room. */
export function isProviderFailureTracked(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as Record<symbol, unknown>)[PROVIDER_FAILURE_TRACKED] === true
  );
}

/**
 * True when this failure belongs in the waiting room: not recorded yet, and
 * not a safety-classifier refusal. A refusal judges the content, not the
 * provider — counting it degraded a healthy model for every session.
 */
export function shouldRecordProviderFailure(err: unknown): boolean {
  return !isProviderFailureTracked(err) && !isSafetyPolicyRefusal(err);
}

function markProviderFailureTracked(err: unknown): void {
  if (!err || typeof err !== 'object') return;
  try {
    Object.defineProperty(err, PROVIDER_FAILURE_TRACKED, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen error objects are fine — worst case the outer layer records
    // the same failure once more, which only shortens the cooldown ladder.
  }
}

/**
 * Call a provider with the retry policy applied. Emits `provider.retry`
 * before each retry and `provider.error` once when the retries are
 * exhausted. Streaming providers route through the streaming-response
 * builder so deltas reach the renderer.
 *
 * ## Waiting-room middleware
 *
 * This function is the ONE funnel every agent-loop provider call passes
 * through — leader turns, subagent turns, and every hop the `fallback-model`
 * extension takes (its chain calls back into this runner). When
 * `statusTracker` is supplied it therefore acts as the last line of defence
 * for the provider waiting room:
 *
 * - **Pre-flight**: a quarantined (provider, model) pair never reaches the
 *   wire. A synthetic fallback-worthy 429 is thrown instead, so an outer
 *   fallback chain rotates to the next candidate exactly as it would for a
 *   real rate limit — but no HTTP request, and no billing, happens.
 * - **Post-flight**: every success and every terminal failure is recorded,
 *   independent of which extensions are installed. Before this, the ONLY
 *   writer was the `fallback-model` extension; anything running without it
 *   (or any failure whose class identity did not survive a bundle boundary)
 *   left the waiting room empty and the same doomed model was picked again
 *   on the very next spawn.
 */
export async function runProviderWithRetry(opts: RunProviderOptions): Promise<Response> {
  const { provider, request, signal, ctx, events, retry, logger, tracer, statusTracker } = opts;
  const logicalRequestId = opts.logicalRequestId ?? randomUUID();
  const promptManifest = createChroniclePromptManifest(request);
  // Keep the request identity alive after the provider response returns: the
  // following tool calls are the materialized effects of this exact prompt.
  ctx.activeLogicalRequestId = logicalRequestId;
  ctx.activePromptManifestId = promptManifest.manifestId;
  let attempt = 0;
  // One self-correcting retry per call when the provider reports its output cap.
  let outputCapRetried = false;
  for (;;) {
    const currentProvider =
      ctx.provider && ctx.provider.id === provider.id ? ctx.provider : provider;

    // ── Waiting-room gate (pre-flight) ──────────────────────────────────
    // Cut the request on the way out, before a socket is opened. This runs
    // on EVERY attempt, so a sibling agent that exhausts the account mid-run
    // also stops this retry ladder instead of burning the rest of it.
    if (statusTracker && !statusTracker.isAvailable(currentProvider.id, request.model)) {
      const status = statusTracker.getStatus(currentProvider.id, request.model);
      const until = status?.stateExpiresAt;
      const detail = status?.lastErrorMessage ?? 'rate limit or repeated failures';
      logger.warn(
        `provider-gate: refusing "${currentProvider.id}/${request.model}" — quarantined${
          until ? ` for another ${Math.max(0, Math.round((until - Date.now()) / 1000))}s` : ''
        } (${detail})`,
        providerLogCtx(currentProvider, request),
      );
      const gateErr = new ProviderError(
        `"${currentProvider.id}/${request.model}" is in the provider waiting room — skipped without calling the API (${detail})`,
        429,
        true,
        currentProvider.id,
        {
          kind: 'rate_limit',
          body: {
            type: 'rate_limit_error',
            message: detail,
            ...(until ? { retryAfterMs: Math.max(0, until - Date.now()) } : {}),
          },
        },
      );
      // Synthetic — it describes state the waiting room already holds, so it
      // must not be counted as a fresh failure by any outer layer.
      markProviderFailureTracked(gateErr);
      throw gateErr;
    }

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
      providerId: currentProvider.id,
      model: request.model,
      taskId: ctx.currentKanbanTaskId,
      boardId: ctx.currentKanbanBoardId,
    };
    events.emit('provider.attempt.started', {
      ...correlation,
      streaming: currentProvider.capabilities.streaming,
      messageCount: request.messages.length,
      toolCount: request.tools?.length ?? 0,
      promptManifest,
      startedAt,
    });
    const span = tracer?.startSpan('provider.complete', {
      ...spanSessionAttributes(ctx),
      'provider.id': currentProvider.id,
      'provider.model': request.model,
      'provider.streaming': currentProvider.capabilities.streaming,
      'provider.attempt': attempt,
    });
    logger.debug(
      `Provider attempt ${attempt + 1} starting`,
      providerLogCtx(currentProvider, request),
    );
    try {
      const res = await runWithNetworkTelemetry(
        {
          events,
          sessionId: resolveEventSessionId(ctx),
          ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          attemptId,
          initiator: 'provider',
          operationName: `${currentProvider.id}.complete`,
        },
        () => {
          // Per attempt, because a fallback hop can land on a model without
          // PDF input: that one gets each attached document as its text.
          const messages = adaptDocumentsForModel(
            request.messages,
            currentProvider.capabilities.pdf === true,
          );
          const wire = messages === request.messages ? request : { ...request, messages };
          return currentProvider.capabilities.streaming
            ? streamProviderToResponse(currentProvider, wire, signal, ctx, events, logger)
            : currentProvider.complete(wire, { signal });
        },
      );
      statusTracker?.recordSuccess(currentProvider.id, request.model, {
        sessionId: resolveEventSessionId(ctx),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      });
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
        ...providerLogCtx(currentProvider, request),
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
      if (deactivateProxyOnConnectionFailure(err)) {
        // Deactivation flips the config flag synchronously, but the live
        // provider's rebuild runs on the instant-apply async chain. Wait
        // (bounded, abort-aware) for that rebuild to land before the retry
        // loop re-reads ctx.provider — otherwise the remaining attempts
        // still target the dead proxy URL the deactivation just routed
        // around. Resolves on cap timeout too: the barrier delays a
        // retrying turn, it never fails it.
        await waitForProxyRoutingSettle(undefined, signal);
        if (signal.aborted) throw err;
        logger.info(
          'WrongProxy connection failed — deactivated proxy and switched to direct provider connection',
        );
      }
      const isProviderErr = err instanceof ProviderError || ProviderError.isProviderError(err);
      const errAsErr = err instanceof Error ? err : new Error(String(err));
      // Issue #398: the catalog's output limit can exceed what this provider
      // accepts for the model, and the 400 then states the real cap. Learn it
      // and retry once — the output resolver clamps `max_tokens` to it on the
      // next build — instead of failing every turn. Only when the cap is new
      // or lower, so the same rejection can never loop.
      const reportedCap =
        !outputCapRetried && isProviderErr && (err as ProviderError).kind === 'invalid_request'
          ? parseProviderReportedMaxOutput(
              `${errAsErr.message}\n${(err as ProviderError).body?.message ?? ''}\n${(err as ProviderError).body?.raw ?? ''}`,
            )
          : undefined;
      const capRetry =
        reportedCap !== undefined &&
        recordProviderReportedMaxOutput(currentProvider.id, request.model, reportedCap);
      const canRetry = capRetry || retry.shouldRetry(isProviderErr ? err : errAsErr, attempt);
      const providerErrorBody = isProviderErr
        ? scrubProviderBody((err as ProviderError).body)
        : undefined;
      const description = scrubErrorText(
        isProviderErr ? (err as ProviderError).describe() : errAsErr.message,
      );
      const delay = capRetry
        ? 0
        : canRetry
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
      if (capRetry) {
        outputCapRetried = true;
        logger.warn(
          `${currentProvider.id}/${request.model} accepts at most ${reportedCap} output tokens (the provider's own limit; the catalog lists more) — retrying with that cap`,
          providerLogCtx(currentProvider, request),
        );
        continue;
      }
      if (!canRetry) {
        // ── Waiting-room gate (post-flight) ──────────────────────────────
        // Record the terminal failure here, at the single funnel every
        // provider call passes through, rather than relying on an outer
        // extension being installed. `isProviderError` is the duck-typed
        // guard on purpose: the error was constructed against the
        // `@wrongstack/core/types` bundle and `instanceof` does not survive
        // that boundary.
        if (statusTracker && isProviderErr && shouldRecordProviderFailure(err)) {
          const perr = err as ProviderError;
          markProviderFailureTracked(err);
          statusTracker.recordFailure(
            currentProvider.id,
            request.model,
            perr.kind,
            perr.status,
            description,
            {
              sessionId: resolveEventSessionId(ctx),
              ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
              ...(perr.body?.retryAfterMs ? { retryAfterMs: perr.body.retryAfterMs } : {}),
            },
          );
        }
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
        // A ProviderError must reach the caller INTACT — `kind`, `status` and
        // `body` are what the fallback engine and the waiting room branch on.
        // `toWrongStackError` used a bare `instanceof WrongStackError`, which
        // is false for an error built against the `@wrongstack/core/types`
        // bundle, so every provider failure arrived at `fallback-model` as a
        // shapeless AgentError: no failover, no quarantine. Raw Errors
        // (network, timeout) still get wrapped so callers can branch on
        // `.code` instead of parsing messages.
        throw isProviderErr ? err : toWrongStackError(err);
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
