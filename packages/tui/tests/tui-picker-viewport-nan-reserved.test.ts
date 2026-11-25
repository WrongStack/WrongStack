import { describe, expect, it } from 'vitest';
import { pickerViewport } from '../src/components/picker-viewport.js';

describe('pickerViewport non-finite reservedRows guard (F2270)', () => {
  it('treats non-finite reservedRows as 0 instead of collapsing height to 0', () => {
    const vp = pickerViewport({ columns: 80, rows: 24 }, { reservedRows: Number.NaN });
    expect(vp.rows).toBe(24);
  });
});
