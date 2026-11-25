import { describe, expect, it } from 'vitest';
import { computeContextWindowBudget } from '../../src/utils/context-budget.js';

describe('computeContextWindowBudget non-finite reserve guards', () => {
  it('falls back to default reserves when overrides are NaN or negative', () => {
    const budget = computeContextWindowBudget({
      maxContext: 100_000,
      inputTokens: 95_000,
      outputReserveTokens: Number.NaN,
      safetyBufferTokens: Number.NaN,
    });
    expect(Number.isFinite(budget.availableInputTokens)).toBe(true);
    expect(budget.availableInputTokens).toBe(90_000);
    expect(budget.load).toBeGreaterThan(1);
    expect(budget.overflowTokens).toBe(5_000);
  });
});
