import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { fleetPulse } from '../src/features/overview/model';

describe('fleetPulse costUsd finite guard', () => {
  it('falls back to 0 when snapshot totalCostUsd is NaN or negative', () => {
    const bad = fleetPulse({
      totals: { totalCostUsd: Number.NaN },
      liveSessions: [],
      machines: [],
    } as unknown as HqSnapshot);
    expect(bad.costUsd).toBe(0);

    const ok = fleetPulse({
      totals: { totalCostUsd: 4.25 },
      liveSessions: [],
      machines: [],
    } as unknown as HqSnapshot);
    expect(ok.costUsd).toBe(4.25);
  });
});
