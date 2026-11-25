import { describe, expect, it } from 'vitest';
import { clampLimit } from '../src/server/ws-validation-common.js';

describe('clampLimit non-finite bound guards', () => {
  it('never returns NaN when def or max is non-finite', () => {
    expect(clampLimit(5, 10, Number.NaN)).toBe(5);
    expect(clampLimit('bad', Number.NaN, 100)).toBe(1);
  });
});
