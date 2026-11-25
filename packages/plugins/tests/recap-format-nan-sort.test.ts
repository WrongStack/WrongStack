import { describe, expect, it } from 'vitest';
import { topN } from '../src/session-recap/recap-format.js';

describe('recap-format topN NaN sorting (F1973)', () => {
  it('sorts finite numbers ahead of NaN entries', () => {
    const map = new Map<string, number>([
      ['low', 1],
      ['bad', Number.NaN],
      ['high', 100],
    ]);
    expect(topN(map, 2)).toEqual([
      ['high', 100],
      ['low', 1],
    ]);
  });
});
