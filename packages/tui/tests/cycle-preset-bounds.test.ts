import { describe, expect, it } from 'vitest';
import { cyclePreset } from '../src/brain-panel-model.js';

describe('cyclePreset bounds', () => {
  it('wraps arbitrary negative deltas and handles non-finite delta or empty presets', () => {
    const presets = ['low', 'medium', 'high'] as const;
    expect(cyclePreset(presets, 'low', 1)).toBe('medium');
    expect(cyclePreset(presets, 'low', -1)).toBe('high');
    expect(cyclePreset(presets, 'low', -5)).toBe('medium');
    expect(cyclePreset(presets, 'medium', Number.NaN)).toBe('medium');
    expect(cyclePreset(presets, 'medium', Number.POSITIVE_INFINITY)).toBe('medium');
    expect(cyclePreset([], 'fallback', 1)).toBe('fallback');
  });
});
