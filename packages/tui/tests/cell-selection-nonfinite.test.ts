import { describe, expect, it } from 'vitest';
import { selectedRuns, selectionText } from '../src/cell-selection.js';

describe('cell-selection non-finite coordinate guard (F2000)', () => {
  it('returns empty results instead of hanging or selecting on non-finite ranges', () => {
    const runs = [{ row: 0, col: 0, text: 'hello' }];
    expect(selectionText(runs, { anchor: { row: 0, col: 0 }, head: { row: 0, col: 4 } })).toBe(
      'hello',
    );
    expect(
      selectedRuns(runs, {
        anchor: { row: 0, col: Number.NEGATIVE_INFINITY },
        head: { row: 0, col: 4 },
      }),
    ).toEqual([]);
    expect(
      selectionText(runs, {
        anchor: { row: 0, col: 0 },
        head: { row: Number.POSITIVE_INFINITY, col: 4 },
      }),
    ).toBe('');
  });
});
