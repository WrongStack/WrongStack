import { describe, expect, it } from 'vitest';
import { renderContextChip } from '../src/repl-rendering.js';

describe('renderContextChip non-finite and zero-max guards', () => {
  it('never emits NaN or Infinity when max is 0 or inputs are non-finite', () => {
    expect(renderContextChip(500, 1000)).toContain('50%');
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [Number.NaN, 100],
      [50, Number.NaN],
      [-10, -5],
    ];
    for (const [used, max] of cases) {
      const chip = renderContextChip(used, max);
      expect(chip).not.toContain('NaN');
      expect(chip).not.toContain('Infinity');
    }
  });
});
