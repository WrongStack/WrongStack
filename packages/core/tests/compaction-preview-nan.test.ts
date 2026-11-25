import type { Message } from '@wrongstack/contracts/types/messages';
import { describe, expect, it } from 'vitest';
import { buildCompactionPreview } from '../src/utils/compaction-preview.js';

describe('buildCompactionPreview maxChars bounds', () => {
  it('returns empty string for NaN, fractional < 1, zero, or negative maxChars', () => {
    const msg: Message = { role: 'user', content: 'hello world from compaction' };
    expect(buildCompactionPreview(msg, 5)).toBe('hell…');
    expect(buildCompactionPreview(msg, 0)).toBe('');
    expect(buildCompactionPreview(msg, 0.5)).toBe('');
    expect(buildCompactionPreview(msg, -3)).toBe('');
    expect(buildCompactionPreview(msg, Number.NaN)).toBe('');
  });
});
