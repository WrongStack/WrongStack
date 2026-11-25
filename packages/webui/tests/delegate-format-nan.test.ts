import { describe, expect, it } from 'vitest';
import { delegateCompletedText } from '../src/lib/delegate-format';

describe('delegateCompletedText count guards', () => {
  it('clamps non-finite and negative iterations and toolCalls to 0', () => {
    const out = delegateCompletedText({
      target: 'worker',
      ok: true,
      summary: 'done',
      durationMs: 1200,
      iterations: Number.NaN,
      toolCalls: -3,
    });
    expect(out).toContain('0 iteration(s), 0 tool call(s), 1.2s');
    expect(out).not.toContain('NaN');
  });
});
