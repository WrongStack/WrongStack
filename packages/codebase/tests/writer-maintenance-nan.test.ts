import { describe, expect, it } from 'vitest';
import { FTS_CHURN_KEY, optimizeFtsIfNeeded, recordFtsChurn } from '../src/writer-maintenance.js';

describe('writer-maintenance non-finite guards', () => {
  it('ignores non-finite churn increments and threshold overrides', () => {
    const meta = new Map<string, string>();
    recordFtsChurn(
      true,
      (k) => meta.get(k),
      (k, v) => meta.set(k, v),
      Number.NaN,
    );
    expect(meta.get(FTS_CHURN_KEY)).toBeUndefined();

    let optimized = false;
    const didOpt = optimizeFtsIfNeeded(
      () =>
        ({
          get: () => ({ n: 100 }),
          run: () => {
            optimized = true;
          },
        }) as never,
      true,
      () => '0',
      () => {},
      (fn) => fn(),
      { minChurnRatio: Number.NaN, minChurnRows: Number.NaN },
    );
    expect(didOpt).toBe(false);
    expect(optimized).toBe(false);
  });
});
