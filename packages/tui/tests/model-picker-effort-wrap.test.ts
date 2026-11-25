import { describe, expect, it } from 'vitest';
import { cycleEffort } from '../src/components/model-picker-effort.js';

describe('cycleEffort negative modulo wrap and NaN delta', () => {
  it('wraps large negative deltas and keeps current on NaN delta', () => {
    const opts = ['default', 'low', 'medium', 'high'] as const;
    expect(cycleEffort(opts, 'default', -5)).toBe('high');
    expect(cycleEffort(opts, 'medium', Number.NaN)).toBe('medium');
  });
});
