import { describe, expect, it } from 'vitest';
import { layoutStripChips } from '../src/background-strip-model.js';

describe('layoutStripChips out-of-range selected index', () => {
  it('clamps out-of-bounds selected indices so visible chips are not hidden', () => {
    const items = [
      { id: 'a', kind: 'agent' as const, label: 'alpha', startedAt: 0 },
      { id: 'b', kind: 'agent' as const, label: 'beta', startedAt: 0 },
      { id: 'c', kind: 'agent' as const, label: 'gamma', startedAt: 0 },
    ];
    const out = layoutStripChips(items, 99, 200, 1000, '*');
    expect(out.chips).toHaveLength(3);
    expect(out.hidden).toBe(0);
  });
});
