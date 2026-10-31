import { getProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { recordAcpRateLimit } from '@wrongstack/fleet';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => resetProviderQuota());

const NOW = 1_791_900_000_000;

describe('recordAcpRateLimit', () => {
  it("records the worker's Claude windows on the quota plane, merging later readings", () => {
    // The reading a real Claude worker sent (2026-10-13).
    recordAcpRateLimit(
      'claude-code-q1',
      {
        status: 'allowed',
        resetsAt: 1791910800,
        rateLimitType: 'five_hour',
        unifiedWindows: { five_hour: { utilization: 0.09, resetsAt: 1791910800 } },
      },
      NOW,
    );
    recordAcpRateLimit(
      'claude-code-q1',
      {
        status: 'allowed',
        unifiedWindows: { seven_day: { utilization: 0.58, resetsAt: 1792300000 } },
      },
      NOW,
    );
    const [snap] = getProviderQuota('claude-code-q1');
    expect(snap).toMatchObject({ providerId: 'claude-code-q1', meterId: 'claude' });
    expect(snap?.windows).toEqual([
      { id: '5h', label: '5h', usedPercent: 9, windowMinutes: 300, resetsAt: 1791910800 },
      { id: '7d', label: '7d', usedPercent: 58, windowMinutes: 10_080, resetsAt: 1792300000 },
    ]);
    expect(snap?.reachedWindowId).toBeUndefined();
    expect(snap?.via).toBeUndefined();
  });

  it('marks the window that cut the account off, and ignores readings it cannot read', () => {
    recordAcpRateLimit(
      'claude-code-q2',
      {
        status: 'rejected',
        rateLimitType: 'five_hour',
        unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1791910800000 } },
      },
      NOW,
    );
    const [snap] = getProviderQuota('claude-code-q2');
    expect(snap?.reachedWindowId).toBe('5h');
    // Milliseconds are normalised to the plane's epoch seconds.
    expect(snap?.windows[0]?.resetsAt).toBe(1791910800);

    recordAcpRateLimit(
      'claude-code-q3',
      { status: 'allowed', unifiedWindows: { mystery: {} } },
      NOW,
    );
    expect(getProviderQuota('claude-code-q3')).toEqual([]);
  });
});
