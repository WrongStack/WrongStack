import { describe, expect, it } from 'vitest';
import { restoreProviderStatusSnapshot } from '../src/provider-status-tracker-snapshot.js';

describe('restoreProviderStatusSnapshot non-finite expiry guard', () => {
  it('skips entries with NaN or Infinity stateExpiresAt', () => {
    const ctx = {
      cfg: { quarantineSiblingsOnQuotaExhausted: false },
      providerQuotaBlocks: new Map<string, number>(),
      getOrCreate: () => ({}) as never,
      fanOutExpiryFor: (_now: number, exp: number) => exp,
    } as Parameters<typeof restoreProviderStatusSnapshot>[0];

    const restored = restoreProviderStatusSnapshot(ctx, {
      statuses: [
        { providerId: 'p', model: 'm1', state: 'blocked', stateExpiresAt: Number.NaN },
        {
          providerId: 'p',
          model: 'm2',
          state: 'blocked',
          stateExpiresAt: Number.POSITIVE_INFINITY,
        },
        {
          providerId: 'p',
          model: 'm3',
          state: 'degraded',
          stateExpiresAt: Number.NEGATIVE_INFINITY,
        },
      ],
    });
    expect(restored).toBe(0);
  });
});
