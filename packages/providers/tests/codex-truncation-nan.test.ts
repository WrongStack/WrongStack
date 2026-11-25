import { describe, expect, it } from 'vitest';
import { truncateMiddle } from '../src/openai-codex-truncation.js';

describe('truncateMiddle non-finite limits', () => {
  it('clamps non-finite and negative limits instead of emitting NaN', () => {
    expect(truncateMiddle('a'.repeat(100), { mode: 'bytes', limit: 20 })).toContain(
      '80 chars truncated',
    );
    for (const limit of [Number.NaN, -5, Number.NEGATIVE_INFINITY]) {
      const output = truncateMiddle('hello world', { mode: 'tokens', limit });
      expect(output).not.toContain('NaN');
      expect(output).not.toContain('Infinity');
    }
  });
});
