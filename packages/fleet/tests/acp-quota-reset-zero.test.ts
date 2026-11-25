import { getProviderQuota } from '@wrongstack/core/quota';
import { describe, expect, it } from 'vitest';
import { recordAcpRateLimit } from '../src/acp-quota-reading.js';

describe('recordAcpRateLimit (F2174)', () => {
  it('omits resetsAt when sub-second input truncates to 0', () => {
    const id = `f2174-test-${Date.now()}`;
    recordAcpRateLimit(
      id,
      { unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 0.5 } } },
      1_700_000_000_000,
    );
    const snaps = getProviderQuota(id);
    expect(snaps[0]?.windows[0]?.resetsAt).toBeUndefined();
  });
});
