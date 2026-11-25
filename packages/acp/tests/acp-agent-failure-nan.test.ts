import { describe, expect, it } from 'vitest';
import { classifyAgentFailure } from '../src/integration/acp-agent-failure.js';

describe('classifyAgentFailure non-finite now', () => {
  it('produces a finite non-negative backoffMs when now is non-finite', () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const res = classifyAgentFailure(
        { message: "You've hit your limit · resets 3pm" },
        'claude',
        now,
      );
      expect(res?.kind).toBe('provider_quota');
      expect(Number.isFinite(res?.backoffMs)).toBe(true);
      expect(res?.backoffMs ?? -1).toBeGreaterThanOrEqual(0);
    }
  });
});
