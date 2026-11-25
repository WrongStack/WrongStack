import { describe, expect, it } from 'vitest';
import { applyPlanUpdate } from '../src/client/acp-session-plans.js';

describe('applyPlanUpdate blank planId guard (F2258)', () => {
  it('rejects whitespace-only planId values', () => {
    const plans = new Map();
    const updated = applyPlanUpdate(
      plans,
      {
        sessionUpdate: 'plan_update',
        plan: { planId: '   ', type: 'markdown', content: '# Plan' },
      },
      true,
    );
    expect(updated).toBe(false);
    expect(plans.size).toBe(0);
  });
});
