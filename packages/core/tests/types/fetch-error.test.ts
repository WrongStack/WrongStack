import { describe, expect, it } from 'vitest';
import { FetchError, WrongStackError, isFetchError } from '../../src/types/errors.js';

/**
 * P3 #18 (before-release.md): classifyToolError() detected HTTP errors via
 * `'response' in err` — brittle duck-typing that catches any Error with a
 * `response` property, including custom errors, proxies, or mocks. The fix
 * adds a structured FetchError subclass that the classifier matches via
 * `instanceof`.
 */
describe('FetchError — structured HTTP error (P3 #18)', () => {
  it('is a WrongStackError carrying the HTTP status', () => {
    const err = new FetchError({ message: 'Not Found', status: 404 });
    expect(err).toBeInstanceOf(WrongStackError);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.name).toBe('FetchError');
  });

  it('marks 429 and 5xx as recoverable (retryable)', () => {
    expect(new FetchError({ message: 'rate limited', status: 429 }).recoverable).toBe(true);
    expect(new FetchError({ message: 'bad gateway', status: 502 }).recoverable).toBe(true);
    expect(new FetchError({ message: 'server error', status: 503 }).recoverable).toBe(true);
  });

  it('marks 4xx (non-429) as non-recoverable', () => {
    expect(new FetchError({ message: 'not found', status: 404 }).recoverable).toBe(false);
    expect(new FetchError({ message: 'unauthorized', status: 401 }).recoverable).toBe(false);
    expect(new FetchError({ message: 'bad request', status: 400 }).recoverable).toBe(false);
  });

  it('carries the status in context for diagnostics', () => {
    const err = new FetchError({ message: 'server error', status: 500 });
    expect(err.context).toMatchObject({ status: 500 });
  });

  it('preserves a cause for error chaining', () => {
    const root = new Error('underlying socket error');
    const err = new FetchError({ message: 'fetch failed', status: 503, cause: root });
    expect(err.cause).toBe(root);
  });

  it('is detected by isFetchError type guard', () => {
    const err = new FetchError({ message: 'bad', status: 400 });
    const plain = new Error('has response');
    expect(isFetchError(err)).toBe(true);
    expect(isFetchError(plain)).toBe(false);
    expect(isFetchError(null)).toBe(false);
    expect(isFetchError('string')).toBe(false);
  });

  it('an Error with a `response` property is NOT a FetchError', () => {
    // This is the regression P3 #18 fixes: a mock or proxy error with an
    // ad-hoc `response` field should not be treated as an HTTP error via
    // duck-typing. instanceof FetchError is the reliable discriminator.
    const impostor = new Error('mock error') as Error & { response?: unknown };
    impostor.response = { status: 200 };
    expect(isFetchError(impostor)).toBe(false);
    expect(impostor instanceof FetchError).toBe(false);
  });
});
