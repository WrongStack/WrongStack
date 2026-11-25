import { describe, expect, it } from 'vitest';
import { prioritizeReviewCandidates } from '../src/review-candidates.js';

describe('prioritizeReviewCandidates non-finite maxFiles guard', () => {
  it('defaults non-finite maxFiles to 1 instead of selecting zero files', () => {
    const files = [
      { path: 'src/a.ts', status: 'modified' as const },
      { path: 'src/b.ts', status: 'modified' as const },
    ];
    const res = prioritizeReviewCandidates(files, Number.NaN);
    expect(res.selected).toHaveLength(1);
    expect(res.capped).toHaveLength(1);
  });
});
