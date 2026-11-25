import { describe, expect, it } from 'vitest';
import { delegateCompletedText, truncateDelegateTask } from '../src/lib/delegate-format.js';

describe('delegate-format bounds and non-finite inputs (F1875)', () => {
  it('handles zero, negative, 1, and NaN limits in truncateDelegateTask', () => {
    expect(truncateDelegateTask('hello world', 0)).toBe('');
    expect(truncateDelegateTask('hello world', -5)).toBe('');
    expect(truncateDelegateTask('hello world', 1)).toBe('…');
    expect(truncateDelegateTask('hello world', 5)).toBe('hell…');
    expect(truncateDelegateTask('hello world', Number.NaN)).toBe('hello world');
  });

  it('guards non-finite durationMs and costUsd in delegateCompletedText', () => {
    const text = delegateCompletedText({
      target: 'worker',
      ok: true,
      summary: 'done',
      durationMs: Number.NaN,
      iterations: 1,
      toolCalls: 2,
      costUsd: Number.POSITIVE_INFINITY,
    });
    expect(text).toContain('1 iteration(s), 2 tool call(s), 0s');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });
});
