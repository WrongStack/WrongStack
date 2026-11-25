import { describe, expect, it } from 'vitest';
import { renderTable } from '../src/markdown-table.js';

describe('renderTable non-finite maxWidth guard (F1993)', () => {
  it('falls back to stacked layout when maxWidth is NaN', () => {
    const lines = [
      '| Column Alpha | Column Beta |',
      '| --- | --- |',
      '| very long value one | very long value two |',
    ];
    expect(renderTable(lines, Number.NaN)).not.toContain('┌');
    expect(renderTable(lines, 80)).toContain('┌');
  });
});
