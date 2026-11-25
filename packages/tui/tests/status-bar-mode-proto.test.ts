import { describe, expect, it } from 'vitest';
import { modeIcon } from '../src/components/status-bar-helpers.js';

describe('modeIcon prototype-safe lookup', () => {
  it('falls back to default icon for inherited Object.prototype keys', () => {
    expect(modeIcon('toString')).toBe('▪ toString');
    expect(modeIcon('teach')).toBe('◇ teach');
  });
});
