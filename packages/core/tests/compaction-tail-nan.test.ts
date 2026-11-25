import { describe, expect, it } from 'vitest';
import { widenTailCut } from '../src/execution/compaction-tail.js';

describe('widenTailCut non-finite countCut guard', () => {
  it('returns a finite index when countCut is NaN', () => {
    const msgs = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi there' },
    ] as Parameters<typeof widenTailCut>[1];
    const cut = widenTailCut(
      { meta: { contextWindowPolicy: { keepTokens: 100 } } },
      msgs,
      Number.NaN,
    );
    expect(Number.isFinite(cut)).toBe(true);
    expect(cut).toBeGreaterThanOrEqual(0);
  });
});
