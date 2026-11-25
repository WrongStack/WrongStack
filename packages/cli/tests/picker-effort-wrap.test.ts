import { describe, expect, it } from 'vitest';
import { cycleStartupEffort } from '../src/picker-effort.js';

describe('cycleStartupEffort wrapping and delta sanitization', () => {
  it('wraps large negative deltas and guards non-finite deltas', () => {
    const opts = ['default', 'low', 'medium', 'high'] as const;
    expect(cycleStartupEffort(opts, 'default', -1)).toBe('high');
    expect(cycleStartupEffort(opts, 'default', -5)).toBe('high');
    expect(cycleStartupEffort(opts, 'default', 5)).toBe('low');
    expect(cycleStartupEffort(opts, 'medium', Number.NaN)).toBe('medium');
  });
});
