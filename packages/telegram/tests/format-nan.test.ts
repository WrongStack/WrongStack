import { describe, expect, it } from 'vitest';
import { fmtTokens, formatDelegateCompleted } from '../src/format.js';

describe('telegram format non-finite guards', () => {
  it('formats non-finite token and delegate counters as 0', () => {
    expect(fmtTokens(1234)).toBe('1,234');
    expect(fmtTokens(Number.NaN)).toBe('0');
    expect(fmtTokens(Number.POSITIVE_INFINITY)).toBe('0');

    const rendered = formatDelegateCompleted({
      target: 'worker',
      task: 'audit',
      ok: true,
      summary: 'done',
      durationMs: 1000,
      iterations: Number.NaN,
      toolCalls: Number.POSITIVE_INFINITY,
    });
    expect(rendered).toContain('0 iter · 0 tools');
    expect(rendered).not.toContain('NaN');
    expect(rendered).not.toContain('Infinity');
  });
});
