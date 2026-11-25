import { describe, expect, it } from 'vitest';
import { buildThemeRows, windowThemeRows } from '../src/theme-picker-rows.js';

describe('windowThemeRows non-finite budget guard', () => {
  it('falls back to minimum capacity 2 when budget is NaN', () => {
    const rows = buildThemeRows([
      { id: 'a', name: 'A', description: '', family: 'Dark' },
      { id: 'b', name: 'B', description: '', family: 'Dark' },
      { id: 'c', name: 'C', description: '', family: 'Dark' },
    ] as unknown as Parameters<typeof buildThemeRows>[0]);
    expect(windowThemeRows(rows, 0, Number.NaN).rows.length).toBeGreaterThanOrEqual(2);
  });
});
