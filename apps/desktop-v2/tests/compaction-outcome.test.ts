import { expect, it } from 'vitest';
import { compactionOutcome } from '../src/compaction-outcome';

it('reads what a compaction pass did and ignores other replies', () => {
  expect(compactionOutcome({ success: true, message: 'Compacted' })).toBeNull();
  expect(
    compactionOutcome({
      before: 900,
      after: 300,
      saved: 600,
      fullRequestTokensBefore: 1500,
      fullRequestTokensAfter: 900,
      reductions: [{ phase: 'summary', saved: 600 }, { kind: 'old shape' }],
      quality: { ok: false, hasIntent: true, issues: ['no path trail'] },
      digest: 'Turns 1-8: …',
      digestTruncated: true,
    }),
  ).toEqual({
    before: 900,
    after: 300,
    saved: 600,
    request: { before: 1500, after: 900 },
    reductions: [{ phase: 'summary', saved: 600 }],
    quality: { ok: false, issues: ['no path trail'] },
    digest: 'Turns 1-8: …',
    digestTruncated: true,
  });
  expect(compactionOutcome({ before: 10, after: 10, saved: 0 })).toMatchObject({
    request: null,
    quality: null,
    digest: '',
  });
});
