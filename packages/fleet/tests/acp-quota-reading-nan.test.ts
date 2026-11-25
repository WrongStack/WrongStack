import { getAllProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { describe, expect, it } from 'vitest';
import { recordAcpRateLimit } from '../src/acp-quota-reading.js';

describe('recordAcpRateLimit non-finite now guard', () => {
  it('falls back to a finite timestamp when now is non-finite', () => {
    resetProviderQuota();
    try {
      recordAcpRateLimit(
        'claude-code',
        { unifiedWindows: { five_hour: { utilization: 0.5 } } },
        Number.NaN,
      );
      const snaps = getAllProviderQuota().filter((s) => s.providerId === 'claude-code');
      expect(snaps).toHaveLength(1);
      expect(Number.isFinite(snaps[0]?.capturedAt)).toBe(true);
    } finally {
      resetProviderQuota();
    }
  });
});
