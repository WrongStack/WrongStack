import { describe, expect, it } from 'vitest';
import {
  isOutOfBand,
  selectionTouchedEntryIds,
} from '../src/components/history/selection-helpers.js';

describe('selection-helpers non-finite guards', () => {
  it('treats non-finite columns as out-of-band and ignores non-finite selection bounds', () => {
    expect(isOutOfBand(Number.NaN, 80)).toBe(true);
    expect(isOutOfBand(5, Number.NaN)).toBe(true);
    expect(isOutOfBand(5, 80)).toBe(false);

    expect(
      selectionTouchedEntryIds({
        selection: {
          topLeft: { row: Number.NaN, col: 0 },
          bottomRight: { row: Number.NaN, col: 10 },
          inProgress: false,
        },
        cards: [{ entryId: 1, viewportStartRow: 0, viewportEndRow: 5 }],
      }),
    ).toEqual([]);
  });
});
