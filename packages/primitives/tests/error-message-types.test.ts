import { describe, expect, it } from 'vitest';
import { toWrongStackError } from '../../contracts/src/types/errors.js';
import { rawErrorMessage, toErrorMessage } from '../src/error.js';

function errorWithMessage(message: unknown): Error {
  const error = new Error('original failure');
  Object.defineProperty(error, 'message', { value: message });
  return error;
}

describe('non-string Error messages', () => {
  it.each([
    [404, '404'],
    [0, '0'],
    [null, 'null'],
    [undefined, 'undefined'],
    [Symbol('failure'), 'Symbol(failure)'],
    [{ toString: () => 'provider failure' }, 'provider failure'],
  ])('normalizes message %s before returning it', (message, expected) => {
    const input = errorWithMessage(message);
    expect(rawErrorMessage(input)).toBe(expected);
    expect(toErrorMessage(input)).toBe(expected);
    const wrapped = toWrongStackError(input);
    expect(wrapped.code).toBe('AGENT_RUN_FAILED');
    expect(wrapped.message).toBe(expected);
    expect(wrapped.cause).toBe(input);
  });

  it('redacts credentials after converting an object-valued message', () => {
    const secret = ['sk-', 'A'.repeat(28)].join('');
    const input = errorWithMessage({ toString: () => `provider rejected ${secret}` });
    expect(toErrorMessage(input)).toBe('provider rejected [REDACTED:openai_key]');
    expect(rawErrorMessage(input)).toBe(`provider rejected ${secret}`);
  });

  it('uses the existing fallback when message conversion throws', () => {
    const input = errorWithMessage(Object.create(null));
    expect(rawErrorMessage(input)).toBe('unknown error');
    expect(toErrorMessage(input)).toBe('unknown error');
  });

  it('preserves ordinary and empty string messages', () => {
    expect(toErrorMessage(new Error('ordinary failure'))).toBe('ordinary failure');
    expect(toErrorMessage(new Error(''))).toBe('');
  });
});
