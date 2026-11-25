import { describe, expect, it } from 'vitest';
import { envInt } from '../src/utils/env-typed.js';

describe('envInt safe integer guard (F2288)', () => {
  it('falls back to default for non-safe-integer values like 1e30', () => {
    expect(envInt('LIMIT', { default: 10 }, { LIMIT: '1e30' })).toBe(10);
    expect(envInt('LIMIT', { default: 10 }, { LIMIT: '42' })).toBe(42);
  });
});
