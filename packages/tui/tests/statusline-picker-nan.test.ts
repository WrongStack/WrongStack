import { describe, expect, it } from 'vitest';
import { getExpiresInLabel, nextDensity } from '../src/components/statusline-picker-model.js';

describe('statusline-picker-model non-finite guards', () => {
  it('keeps current density on NaN delta and avoids NaN in expiration label', () => {
    expect(nextDensity('auto', Number.NaN)).toBe('auto');
    const label = getExpiresInLabel(
      { key: 'brain', shownAt: Date.now(), expiresIn: 5 },
      Number.NaN,
    );
    expect(label).not.toBeNull();
    expect(label).not.toContain('NaN');
  });
});
