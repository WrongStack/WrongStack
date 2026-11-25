import { describe, expect, it } from 'vitest';
import { shortenTaskPreview } from '../src/hooks/subagent-history-format.js';

describe('shortenTaskPreview non-finite maxChars guard', () => {
  it('falls back to default cap when maxChars is NaN', () => {
    expect(shortenTaskPreview('hello world', Number.NaN)).toBe('hello world');
  });
});
