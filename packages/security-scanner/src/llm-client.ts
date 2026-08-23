/**
 * Card 7B-1: LLM retry client wrapper extracted from orchestrator.ts.
 *
 * Owns `completeWithRetry` (the transport-level retry loop used by every
 * LLM call site: skill generation, batch scan, report synthesis) and
 * the sleep-with-abort helper. Pure module — no class state, no
 * orchestration concerns. Call sites do `await retryProviderComplete({
 *   provider, request, retryPolicy, errorHandler, abortController })`.
 */

import { ProviderError } from '@wrongstack/core/types';

import { type ErrorHandler, NETWORK_ERR_RE, type RetryPolicy } from './_compat-types.js';

/** Result of an LLM `complete` call. Matches `Provider['complete']`'s return. */
export type LlmResponse = Awaited<
  ReturnType<import('@wrongstack/core/types').Provider['complete']>
>;

export interface RetryProviderCompleteOptions {
  provider: import('@wrongstack/core/types').Provider;
  request: import('@wrongstack/core/types').Request;
  abortController: AbortController;
  retryPolicy?: RetryPolicy | undefined;
  errorHandler?: ErrorHandler | undefined;
  /** Seed for retry counting; pass an externally-tracked attempt to avoid double-counting. */
  attempt?: number;
}

/**
 * LLM `complete` wrapped in RetryPolicy-driven exponential backoff.
 *
 * Behaviour:
 * - Non-`ProviderError`, non-`NETWORK_ERR_RE` errors rethrow immediately.
 * - `retryPolicy.shouldRetry(err, attempt) === false` rethrows.
 * - `errorHandler.classify(err).retryable === false` rethrows.
 * - Otherwise sleeps `policy.delayMs` ms (or throws on abort) and recurses
 *   with `attempt + 1`.
 */
export async function retryProviderComplete(
  opts: RetryProviderCompleteOptions,
): Promise<LlmResponse> {
  const attempt = opts.attempt ?? 0;
  const signal = opts.abortController.signal;
  try {
    return (await opts.provider.complete(opts.request, { signal })) as LlmResponse;
  } catch (err) {
    if (signal.aborted) throw err;

    const isProviderErr = err instanceof ProviderError;
    const policy = opts.retryPolicy;
    const errAsErr = isProviderErr ? err : err instanceof Error ? err : new Error(String(err));

    // No policy or non-retryable error — rethrow immediately.
    if (!policy || (!isProviderErr && !NETWORK_ERR_RE.test(errAsErr.message))) {
      throw err;
    }

    if (!policy.shouldRetry(errAsErr, attempt)) throw err;
    if (opts.errorHandler && !opts.errorHandler.classify(err).retryable) throw err;

    const delay = Math.round(
      policy.delayMs(attempt, isProviderErr ? (err as ProviderError) : errAsErr),
    );
    const status = isProviderErr ? (err as ProviderError).status : 0;
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'security_scanner.retry',
        attempt: attempt + 1,
        delayMs: delay,
        status,
        message: errAsErr.message,
        timestamp: new Date().toISOString(),
      }),
    );

    await sleepWithAbort(delay, opts.abortController);
    return retryProviderComplete({ ...opts, attempt: attempt + 1 });
  }
}

/** Sleep `ms` milliseconds, rejecting if `abort` fires before the timer resolves. */
export function sleepWithAbort(ms: number, abortController: AbortController): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (abortController.signal.aborted) {
      reject(new Error('Retry backoff aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Retry backoff aborted'));
    };
    const timer = setTimeout(() => {
      abortController.signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortController.signal.addEventListener('abort', onAbort, { once: true });
  });
}
