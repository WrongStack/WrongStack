/**
 * Provider quota store — the provider-neutral half of the subscription meter.
 *
 * The invariants worth pinning are the ones that make a reading usable rather
 * than merely present: a response that omits the quota channel must not erase
 * what we already knew, a one-line surface must pick the window nearest to
 * cutting the user off, and nothing here may assume the reporting provider is
 * the one that happened to be built first.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  formatQuotaPercent,
  formatQuotaResetIn,
  getAllProviderQuota,
  getProviderQuota,
  hasQuotaData,
  listQuotaProviders,
  onProviderQuota,
  type ProviderQuotaSnapshot,
  quotaResetInMs,
  quotaWindowLabel,
  reachedQuotaWindow,
  recordProviderQuota,
  resetProviderQuota,
  worstProviderQuotaWindow,
} from '../src/quota/index.js';

afterEach(() => {
  resetProviderQuota();
});

function snapshot(over: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot {
  return {
    providerId: 'openai-codex',
    meterId: 'default',
    windows: [{ id: 'primary', usedPercent: 10 }],
    capturedAt: 1,
    ...over,
  };
}

describe('recording', () => {
  it('keeps the last known reading when a later response carries none', () => {
    recordProviderQuota('openai-codex', [snapshot()]);
    recordProviderQuota('openai-codex', [snapshot({ windows: [] })]);
    expect(getProviderQuota('openai-codex')[0]?.windows[0]?.usedPercent).toBe(10);
  });

  it('carries forward the plan and meter labels a later reading omits', () => {
    recordProviderQuota('openai-codex', [
      snapshot({ planLabel: 'pro', meterLabel: 'codex', capturedAt: 1 }),
    ]);
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 20 }], capturedAt: 2 }),
    ]);
    const current = getProviderQuota('openai-codex')[0];
    expect(current?.windows[0]?.usedPercent).toBe(20);
    expect(current?.planLabel).toBe('pro');
    expect(current?.meterLabel).toBe('codex');
  });

  it('keeps a provider’s meters apart', () => {
    recordProviderQuota('openai-codex', [
      snapshot({ meterId: 'codex' }),
      snapshot({ meterId: 'codex_sonic', windows: [{ id: 'primary', usedPercent: 80 }] }),
    ]);
    expect(getProviderQuota('openai-codex')).toHaveLength(2);
  });

  it('keeps providers apart and lists the ones that reported', () => {
    recordProviderQuota('openai-codex', [snapshot()]);
    recordProviderQuota('anthropic-oauth', [
      snapshot({ providerId: 'anthropic-oauth', windows: [{ id: 'primary', usedPercent: 44 }] }),
    ]);
    expect(getProviderQuota('github-copilot')).toEqual([]);
    expect([...listQuotaProviders()].sort()).toEqual(['anthropic-oauth', 'openai-codex']);
    expect(getAllProviderQuota()).toHaveLength(2);
  });

  it('notifies subscribers and survives a listener that throws', () => {
    const seen: number[] = [];
    const stopBad = onProviderQuota(() => {
      throw new Error('status surface exploded');
    });
    const stop = onProviderQuota((_id, snapshots) => {
      seen.push(snapshots[0]?.windows[0]?.usedPercent ?? -1);
    });
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 55 }] }),
    ]);
    stop();
    stopBad();
    expect(seen).toEqual([55]);
  });

  it('treats a windowless, creditless reading as no reading at all', () => {
    expect(hasQuotaData(snapshot({ windows: [] }))).toBe(false);
    expect(
      hasQuotaData(snapshot({ windows: [], credits: { hasCredits: true, unlimited: false } })),
    ).toBe(true);
  });
});

describe('worstProviderQuotaWindow', () => {
  it('picks the most-consumed window across providers and meters', () => {
    recordProviderQuota('openai-codex', [
      snapshot({
        windows: [
          { id: 'primary', usedPercent: 51 },
          { id: 'secondary', usedPercent: 24 },
        ],
      }),
    ]);
    recordProviderQuota('anthropic-oauth', [
      snapshot({ providerId: 'anthropic-oauth', windows: [{ id: 'primary', usedPercent: 88 }] }),
    ]);
    const worst = worstProviderQuotaWindow();
    expect(worst?.snapshot.providerId).toBe('anthropic-oauth');
    expect(worst?.window.usedPercent).toBe(88);
  });

  it('breaks a tie toward the window that resets sooner', () => {
    const now = Math.floor(Date.now() / 1000);
    const worst = worstProviderQuotaWindow([
      snapshot({ windows: [{ id: 'secondary', usedPercent: 90, resetsAt: now + 86_400 }] }),
      snapshot({ windows: [{ id: 'primary', usedPercent: 90, resetsAt: now + 3_600 }] }),
    ]);
    expect(worst?.window.id).toBe('primary');
  });

  it('returns nothing when no provider has reported', () => {
    expect(worstProviderQuotaWindow()).toBeUndefined();
  });
});

describe('presentation', () => {
  it('names a window by its label, its length, then its id', () => {
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0, label: 'weekly' })).toBe('weekly');
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0, windowMinutes: 300 })).toBe('5h');
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0, windowMinutes: 10080 })).toBe('7d');
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0, windowMinutes: 45 })).toBe('45m');
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0 })).toBe('primary');
  });

  it('counts down to a reset and drops one already past', () => {
    const now = 1_000_000;
    expect(quotaResetInMs({ id: 'p', usedPercent: 1, resetsAt: now / 1000 + 3600 }, now)).toBe(
      3_600_000,
    );
    expect(
      quotaResetInMs({ id: 'p', usedPercent: 1, resetsAt: now / 1000 - 10 }, now),
    ).toBeUndefined();
    expect(formatQuotaResetIn(3_600_000)).toBe('1h');
    expect(formatQuotaResetIn(4 * 3_600_000 + 12 * 60_000)).toBe('4h 12m');
    expect(formatQuotaResetIn(45_000)).toBe('45s');
    expect(formatQuotaResetIn(undefined)).toBeUndefined();
  });

  it('shows a fraction only where it changes the reading', () => {
    expect(formatQuotaPercent(51)).toBe('51%');
    expect(formatQuotaPercent(2.5)).toBe('2.5%');
    expect(formatQuotaPercent(0)).toBe('0%');
  });

  it('resolves the window the provider says is cutting the account off', () => {
    const s = snapshot({
      windows: [
        { id: 'primary', usedPercent: 100 },
        { id: 'secondary', usedPercent: 30 },
      ],
      reachedWindowId: 'primary',
    });
    expect(reachedQuotaWindow(s)?.id).toBe('primary');
    expect(reachedQuotaWindow(snapshot())).toBeUndefined();
  });
});
