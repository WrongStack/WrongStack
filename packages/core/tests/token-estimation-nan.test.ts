import { describe, expect, it } from 'vitest';
import { tokensFromAnchor } from '../src/execution/compaction-token-estimation.js';

describe('tokensFromAnchor non-finite anchor guard', () => {
  it('falls back to anchored count when lastRealInputTokens is NaN', () => {
    const ctx = {
      messages: [{ role: 'user', content: 'hello' }],
      meta: { realAnchorMsgCount: 0 },
      lastRealInputTokens: Number.NaN,
      model: 'test',
    } as unknown as Parameters<typeof tokensFromAnchor>[0];
    expect(tokensFromAnchor(ctx, 500)).toBe(500);
  });
});
