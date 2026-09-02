/**
 * VectorMemoryError / VectorMemoryProviderUnavailableError tests.
 *
 * Kept small and focused: the error classes are the package's public
 * `instanceof` contract (callers must be able to catch vector-memory
 * failures without pulling the full store implementation).
 */
import { describe, expect, it } from 'vitest';

import { VectorMemoryError, VectorMemoryProviderUnavailableError } from '../src/errors.js';

describe('VectorMemoryError', () => {
  it('is an Error with the expected name and message', () => {
    const err = new VectorMemoryError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VectorMemoryError);
    expect(err.name).toBe('VectorMemoryError');
    expect(err.message).toBe('boom');
  });

  it('is throwable and catchable by instanceof', () => {
    const caught: unknown = (() => {
      try {
        throw new VectorMemoryError('nope');
      } catch (e) {
        return e;
      }
    })();
    expect(caught).toBeInstanceOf(VectorMemoryError);
    expect((caught as VectorMemoryError).message).toBe('nope');
  });
});

describe('VectorMemoryProviderUnavailableError', () => {
  it('is a VectorMemoryError with its own name', () => {
    const err = new VectorMemoryProviderUnavailableError('provider missing');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VectorMemoryError);
    expect(err).toBeInstanceOf(VectorMemoryProviderUnavailableError);
    expect(err.name).toBe('VectorMemoryProviderUnavailableError');
    expect(err.message).toBe('provider missing');
  });

  it('attaches the original cause when provided', () => {
    const cause = new Error('model failed to load');
    const err = new VectorMemoryProviderUnavailableError('unavailable', cause);
    expect(err.cause).toBe(cause);
  });

  it('leaves cause undefined when omitted', () => {
    const err = new VectorMemoryProviderUnavailableError('unavailable');
    expect(err.cause).toBeUndefined();
  });
});
