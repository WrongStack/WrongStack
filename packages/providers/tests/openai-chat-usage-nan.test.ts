import { describe, expect, it } from 'vitest';
import { normalizeOpenAIChatUsage } from '../src/openai-chat-usage.js';

describe('normalizeOpenAIChatUsage previous sanitization', () => {
  it('sanitizes non-finite and negative previous usage fields', () => {
    const valid = normalizeOpenAIChatUsage({ completion_tokens: 10 }, { input: 50, output: 0 });
    expect(valid.input).toBe(50);
    expect(valid.output).toBe(10);

    const sanitized = normalizeOpenAIChatUsage(
      { completion_tokens: 10 },
      {
        input: Number.NaN,
        output: Number.NaN,
        cacheRead: -5,
        cacheWrite: Number.POSITIVE_INFINITY,
      },
    );
    expect(sanitized.input).toBe(0);
    expect(sanitized.output).toBe(10);
    expect(sanitized.cacheRead).toBeUndefined();
    expect(sanitized.cacheWrite).toBeUndefined();
  });
});
