import { describe, expect, it } from 'vitest';
import { timingSafeTokenEqual } from '../src/timing-safe.js';

const token = ['fixture', 'token'].join('-');
const bytes = [...Buffer.from(token, 'utf16le')];
const malformed: Array<[string, unknown]> = [
  ['number', 42],
  ['boolean', true],
  ['plain object', {}],
  ['empty array', []],
  ['byte array', bytes],
  ['JSON Buffer shape', { type: 'Buffer', data: bytes }],
  ['Buffer instance', Buffer.from(bytes)],
  ['typed byte array', new Uint8Array(bytes)],
  ['symbol', Symbol('fixture')],
  ['bigint', 1n],
];

describe('token comparison rejects non-string runtime inputs', () => {
  it.each(malformed)('rejects a supplied %s instead of coercing or throwing', (_label, value) => {
    expect(timingSafeTokenEqual(value, token)).toBe(false);
  });

  it.each(malformed)('rejects an expected %s instead of coercing or throwing', (_label, value) => {
    expect(timingSafeTokenEqual(token, value)).toBe(false);
  });

  it('does not invoke object conversion hooks', () => {
    let conversions = 0;
    const value = {
      valueOf() {
        conversions++;
        return token;
      },
    };
    expect(timingSafeTokenEqual(value, token)).toBe(false);
    expect(timingSafeTokenEqual(token, value)).toBe(false);
    expect(conversions).toBe(0);
  });

  it('preserves string comparison and absent-token behavior', () => {
    expect(timingSafeTokenEqual(token, token)).toBe(true);
    expect(timingSafeTokenEqual('different-token', token)).toBe(false);
    expect(timingSafeTokenEqual(undefined, token)).toBe(false);
    expect(timingSafeTokenEqual(token, null)).toBe(false);
    expect(timingSafeTokenEqual('', '')).toBe(false);
    expect(timingSafeTokenEqual('\uD800', '\uD801')).toBe(false);
  });
});
