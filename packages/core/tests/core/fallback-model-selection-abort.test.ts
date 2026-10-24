import { ProviderError, type Response } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import {
  ensureUsableModelResponse,
  isUsableModelResponse,
  shouldFallback,
} from '../../src/core/fallback-model-selection.js';

/**
 * Regression: an ABORTED run must never be reported as a capacity fault.
 *
 * `ensureUsableModelResponse` sees "no usable blocks" for two very different
 * situations — a genuinely empty provider response, and a stream that was cut
 * short by cancellation. It used to report both as `kind:'overloaded'`, which
 * IS fallback-eligible, so a session being torn down rotated through every
 * configured model instead of stopping.
 *
 * Observed live on 2026-10-05: the tech-stack audit's first call was cancelled by
 * leader teardown and the chain logged "Empty response from
 * zai-coding-plan/glm-5.3; trying the next configured model".
 *
 * This mirrors the four `ctx_.signal?.aborted` checks already in
 * `runFallbackChain` — same root shape, different branch (the success path rather
 * than the throw path).
 */

/** A response with a content array but no usable block — the abort shape. */
function emptyResponse(): Response {
  return { content: [] } as unknown as Response;
}

describe('ensureUsableModelResponse — abort must not masquerade as overload', () => {
  it('reports an aborted empty response as a non-fallback error', () => {
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      ensureUsableModelResponse(emptyResponse(), 'zai-coding-plan', 'glm-5.3', controller.signal);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;

    // The kind is the whole point: `overloaded` is fallback-eligible.
    expect(err.kind).not.toBe('overloaded');
    expect(err.kind).toBe('unknown');
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(499);

    // The behavioural payoff: this must NOT rotate the chain.
    expect(shouldFallback(err)).toBeNull();
  });

  it('still reports a genuine empty response as overloaded', () => {
    const controller = new AbortController(); // NOT aborted

    let caught: unknown;
    try {
      ensureUsableModelResponse(emptyResponse(), 'zai-coding-plan', 'glm-5.3', controller.signal);
    } catch (err) {
      caught = err;
    }

    const err = caught as ProviderError;
    expect(err.kind).toBe('overloaded');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(503);
    // Unchanged pre-existing behaviour: an empty response from a LIVE provider
    // must still be allowed to fall back.
    expect(shouldFallback(err)).toBe(503);
  });

  it('tolerates a missing signal, because test mocks omit it', () => {
    // No 4th argument at all — the pre-existing 3-arg call shape must survive.
    let caught: unknown;
    try {
      ensureUsableModelResponse(emptyResponse(), 'zai-coding-plan', 'glm-5.3');
    } catch (err) {
      caught = err;
    }
    expect((caught as ProviderError).kind).toBe('overloaded');
  });

  it('never rewrites a usable response, aborted or not', () => {
    const usable = { content: [{ type: 'text', text: 'hello' }] } as unknown as Response;

    const controller = new AbortController();
    controller.abort();

    // An abort must not damage a response that DID come back intact.
    expect(ensureUsableModelResponse(usable, 'p', 'm', controller.signal)).toBe(usable);
    expect(ensureUsableModelResponse(usable, 'p', 'm')).toBe(usable);
  });

  it('lets a response with no content field through, as before', () => {
    // Test-mock responses omit `content`; that is NOT "empty".
    const partial = {} as Response;
    expect(isUsableModelResponse(partial)).toBeUndefined();
    expect(ensureUsableModelResponse(partial, 'p', 'm')).toBe(partial);
  });
});
