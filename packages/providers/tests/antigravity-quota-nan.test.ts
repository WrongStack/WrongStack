import { describe, expect, it } from 'vitest';
import { parseAntigravityQuota } from '../src/google-antigravity-quota.js';

describe('parseAntigravityQuota non-finite now', () => {
  it('falls back to finite timestamps when now is non-finite', () => {
    const payload = {
      buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.5, resetTime: '3600s' }],
    };

    for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = parseAntigravityQuota('ag', payload, now);
      expect(result).toHaveLength(1);
      expect(Number.isFinite(result[0]?.capturedAt)).toBe(true);
      expect(Number.isFinite(result[0]?.windows[0]?.resetsAt)).toBe(true);
    }
  });
});
