import { describe, expect, it } from 'vitest';
import { resolveFleetBudgetSources } from '../src/budget-source.js';

describe('resolveFleetBudgetSources safe integer guard', () => {
  it('rejects numeric values beyond Number.MAX_SAFE_INTEGER', () => {
    const res = resolveFleetBudgetSources({
      config: { maxConcurrent: 1e20 } as never,
      defaultMaxConcurrent: 4,
    });
    expect(res.maxConcurrent).toBe(4);
    expect(res.maxConcurrentSource).toBe('default');
  });
});
