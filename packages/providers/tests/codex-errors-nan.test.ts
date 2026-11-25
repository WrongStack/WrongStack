import { describe, expect, it } from 'vitest';
import { codexUsageLimitResetMs } from '../src/openai-codex-errors.js';

describe('codexUsageLimitResetMs non-finite now', () => {
  it('returns undefined instead of NaN when now is non-finite', () => {
    const raw = JSON.stringify({
      error: { type: 'usage_limit_reached', resets_at: 2_000_000_000 },
    });
    expect(codexUsageLimitResetMs(raw, 1_999_999_000_000)).toBe(1_000_000);
    expect(codexUsageLimitResetMs(raw, Number.NaN)).toBeUndefined();
    expect(codexUsageLimitResetMs(raw, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
