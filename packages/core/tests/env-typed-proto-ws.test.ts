import { describe, expect, it } from 'vitest';
import { envBool, envBoolOptional, envFloat, envInt, envString } from '../src/utils/env-typed.js';

describe('env-typed prototype and whitespace guards (F1971)', () => {
  it('treats whitespace-only strings as unset/false', () => {
    expect(envBool('FLAG', { FLAG: '   ' })).toBe(false);
    expect(envBoolOptional('FLAG', { FLAG: '   ' })).toBeUndefined();
    expect(envBool('FLAG', { FLAG: '1' })).toBe(true);
  });

  it('ignores inherited Object.prototype keys', () => {
    expect(envBool('toString', {})).toBe(false);
    expect(envBoolOptional('constructor', {})).toBeUndefined();
    expect(envInt('valueOf', { default: 7 }, {})).toBe(7);
    expect(envFloat('toString', { default: 2.5 }, {})).toBe(2.5);
    expect(envString('toString', {})).toBeUndefined();
  });
});
