import { describe, expect, it } from 'vitest';
import { applyPickerKey } from '../src/picker-key-state.js';

describe('applyPickerKey non-finite bounds', () => {
  it('sanitizes non-finite selected and matchCount values', () => {
    expect(
      applyPickerKey({ query: '', selected: Number.NaN, status: 'typing' }, '\x1b[B', 3).selected,
    ).toBe(1);
    expect(applyPickerKey({ query: '', selected: 5, status: 'typing' }, '\x1b[A', 0).selected).toBe(
      0,
    );
    expect(
      applyPickerKey({ query: '', selected: 0, status: 'typing' }, '\x1b[B', Number.NaN).selected,
    ).toBe(0);
  });
});
