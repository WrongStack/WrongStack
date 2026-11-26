import { describe, expect, it } from 'vitest';
import {
  formatAutoWakeNotice,
  formatAutoWakeSuppressedNotice,
  formatDeliveryPendingNotice,
} from '../src/auto-wake.js';

describe('auto-wake notice non-finite/negative count guards', () => {
  it('omits non-finite chain and clamps non-finite/negative counts to 0', () => {
    expect(formatAutoWakeNotice(['d1'], Number.POSITIVE_INFINITY)).not.toContain('Infinity');
    expect(formatDeliveryPendingNotice(['d1'], Number.NaN)).toBe(
      '0 background delegation results ready (d1).',
    );
    expect(formatAutoWakeSuppressedNotice(-2)).toContain('0 background results held');
    expect(formatAutoWakeSuppressedNotice(Number.NaN)).toContain('0 background results held');
  });
});
