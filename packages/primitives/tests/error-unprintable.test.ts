import { describe, expect, it } from 'vitest';
import { toWrongStackError } from '../../contracts/src/types/errors.js';
import { rawErrorMessage, toErrorMessage } from '../src/error.js';

const unprintable: Array<[string, () => unknown]> = [
  ['JSON object with non-callable toString', () => JSON.parse('{"toString":null}')],
  ['null-prototype object', () => Object.create(null)],
  [
    'throwing toString',
    () => ({
      toString() {
        throw new Error('conversion failed');
      },
    }),
  ],
  [
    'throwing primitive conversion',
    () => ({
      [Symbol.toPrimitive]() {
        throw new Error('conversion failed');
      },
    }),
  ],
];

describe('unprintable thrown values', () => {
  it.each(unprintable)('normalizes %s without replacing the original error', (_label, make) => {
    const input = make();
    expect(rawErrorMessage(input)).toBe('unknown error');
    expect(toErrorMessage(input)).toBe('unknown error');
    const wrapped = toWrongStackError(input);
    expect(wrapped.code).toBe('AGENT_RUN_FAILED');
    expect(wrapped.message).toBe('unknown error');
    expect(wrapped.cause).toBe(input);
  });

  it('keeps successful conversions, empty Error messages, and structured errors intact', () => {
    const error = new Error('');
    expect(toErrorMessage(error)).toBe('');
    for (const value of [
      null,
      undefined,
      42,
      Symbol('fixture'),
      { toString: () => 'fixture text' },
    ]) {
      expect(rawErrorMessage(value)).toBe(String(value));
      expect(toErrorMessage(value)).toBe(String(value));
    }
    const structured = toWrongStackError(new Error('fixture failure'));
    expect(toWrongStackError(structured)).toBe(structured);
  });

  it('still redacts printable error content without changing the raw helper', () => {
    const secret = ['sk-', 'A'.repeat(28)].join('');
    const input = { toString: () => 'provider rejected ' + secret };
    expect(rawErrorMessage(input)).toBe('provider rejected ' + secret);
    expect(toErrorMessage(input)).toBe('provider rejected [REDACTED:openai_key]');
  });
});
