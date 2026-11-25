import { describe, expect, it } from 'vitest';
import { cutHead, keepTail } from '../src/phase-orchestrator-queries.js';

describe('cutHead and keepTail non-positive / non-finite max guard', () => {
  it('returns empty string for negative, zero, or NaN max lengths', () => {
    expect(cutHead('hello', -1)).toBe('');
    expect(cutHead('hello', Number.NaN)).toBe('');
    expect(keepTail('hello', -1)).toBe('');
    expect(keepTail('hello', Number.NaN)).toBe('');
    expect(cutHead('hello', 3)).toBe('hel');
    expect(keepTail('hello', 3)).toBe('llo');
  });
});
