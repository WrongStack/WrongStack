import { describe, expect, it } from 'vitest';
import { brainTierEligibility, resolveRiskCeiling } from '../src/brain/brain-risk.js';

describe('brain-risk prototype-key & fail-closed guards', () => {
  it('uses own-property lookup and fails closed on unknown risk labels', () => {
    expect(resolveRiskCeiling('toString' as never)).toBe(1);
    const elig = brainTierEligibility(
      { id: 'r1', risk: 'toString' as never, question: 'q', source: 's', fallback: 'f' } as never,
      'high',
      true,
    );
    expect(elig.autonomous).toBe(false);
    expect(elig.council).toBe(false);
  });
});
