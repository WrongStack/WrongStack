import { describe, expect, it } from 'vitest';
import { miniMaxQuotaResetInMs } from '../src/minimax-quota.js';

describe('miniMaxQuotaResetInMs non-finite resetsAt', () => {
  it('ignores non-finite resetsAt values', () => {
    expect(
      miniMaxQuotaResetInMs(
        [
          {
            providerId: 'mm',
            meterId: 'm',
            windows: [{ id: 'p', usedPercent: 100, resetsAt: 200 }],
            capturedAt: 0,
          },
        ],
        100_000,
      ),
    ).toBe(100_000);

    for (const resetsAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        miniMaxQuotaResetInMs(
          [
            {
              providerId: 'mm',
              meterId: 'm',
              windows: [{ id: 'p', usedPercent: 100, resetsAt }],
              capturedAt: 0,
            },
          ],
          100_000,
        ),
      ).toBeUndefined();
    }
  });
});
