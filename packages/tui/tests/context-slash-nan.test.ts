import { describe, expect, it } from 'vitest';
import { contextBar, formatContextPanelSummary } from '../src/context-slash.js';

describe('context-slash non-finite guards', () => {
  it('handles non-finite width in contextBar and non-finite metrics in summary', () => {
    expect(contextBar(0.5, Number.POSITIVE_INFINITY)).toBe('[]   0%');
    expect(contextBar(0.5, Number.NaN)).toBe('[]   0%');
    const summary = formatContextPanelSummary({
      contextPct: Number.NaN,
      contextTokens: Number.NaN,
      contextMaxTokens: 1000,
      memoryCtx: 1,
      memoryPending: 0,
      memoryLeft: 0,
    });
    expect(summary).not.toContain('NaN');
    expect(summary).toContain('0/1k');
  });
});
