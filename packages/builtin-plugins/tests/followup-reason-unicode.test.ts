import { describe, expect, it } from 'vitest';
import { extractChimeraFollowupOutcomes } from '../src/review-followup-briefing.js';

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

describe('Chimera follow-up reason Unicode boundaries', () => {
  it('does not split a surrogate pair at the persisted reason limit', () => {
    const outcomes = extractChimeraFollowupOutcomes(
      JSON.stringify({
        chimera_outcomes: [{ id: 'x', outcome: 'fixed', reason: `${'a'.repeat(499)}😀` }],
      }),
    );
    expect(hasLoneSurrogate(outcomes?.[0]?.reason ?? '')).toBe(false);
  });
});
