import { describe, expect, it } from 'vitest';
import { boundedLimit } from '../src/shared/pagination.js';

describe('boundedLimit non-finite bound guards', () => {
  it('never returns NaN when maxLimit or defaultLimit is non-finite', () => {
    expect(boundedLimit(50, 20, 100)).toBe(50);
    expect(boundedLimit(50, 20, Number.NaN)).toBe(20);
    expect(boundedLimit(undefined, Number.NaN, 100)).toBe(0);
  });
});
