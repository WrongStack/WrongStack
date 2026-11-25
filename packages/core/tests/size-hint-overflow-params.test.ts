import { describe, expect, it } from 'vitest';
import { sizeHint } from '../src/models/fallback-suggest-scoring.js';

describe('sizeHint (F2219)', () => {
  it('ignores overflowing param tokens that convert to Infinity', () => {
    expect(sizeHint(`model-${'9'.repeat(400)}b`)).toBe('neutral');
    expect(sizeHint('llama-405b')).toBe('heavy');
  });
});
