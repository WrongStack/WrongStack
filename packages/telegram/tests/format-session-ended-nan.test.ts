import { describe, expect, it } from 'vitest';
import { formatSessionEnded } from '../src/format.js';

describe('formatSessionEnded non-finite token guard (F1996)', () => {
  it('sanitizes NaN outputTokens and non-finite cache stats', () => {
    const out = formatSessionEnded({
      id: 'sess123456',
      inputTokens: 100,
      outputTokens: Number.NaN,
      cacheRead: Number.POSITIVE_INFINITY,
    });
    expect(out).toContain('100 total');
    expect(out).not.toContain('cache read');
  });
});
