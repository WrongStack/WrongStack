import { describe, expect, it } from 'vitest';
import { memoryReviewReason } from '../src/retrieval/review-freshness.js';

describe('memoryReviewReason non-finite now guard', () => {
  it('falls back to Date.now() when now is NaN', () => {
    const oldMemory = {
      status: 'active',
      anchors: [{ path: 'src/a.ts' }],
      lastVerifiedAt: '2020-01-01T00:00:00Z',
    } as Parameters<typeof memoryReviewReason>[0];
    expect(memoryReviewReason(oldMemory, Number.NaN)).toBe('verification_old');
  });
});
