import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatQuotaResetIn,
  type QuotaSnapshot,
  quotaWindowLabel,
  selectWorstQuotaWindow,
  useProviderQuotaStore,
} from '../../src/stores/provider-quota-store.js';

/**
 * Browser mirror of the server's plan-quota store.
 *
 * The two things worth pinning: the chip must pick the window nearest to
 * cutting the user off across ALL providers (not the first to report), and the
 * store must survive an untyped WS payload — it receives whatever the socket
 * delivers, and a malformed frame must not poison the chip.
 */

beforeEach(() => {
  useProviderQuotaStore.getState().clear();
});

function snapshot(over: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    providerId: 'openai-codex',
    meterId: 'codex',
    windows: [{ id: 'primary', usedPercent: 10, windowMinutes: 300 }],
    capturedAt: 1,
    ...over,
  };
}

describe('provider quota store', () => {
  it('keeps one entry per provider+meter', () => {
    useProviderQuotaStore
      .getState()
      .apply([
        snapshot(),
        snapshot({ meterId: 'codex_sonic' }),
        snapshot({ providerId: 'anthropic-oauth', meterId: 'default' }),
      ]);
    expect(Object.keys(useProviderQuotaStore.getState().meters)).toHaveLength(3);
  });

  it('replaces a meter’s reading rather than accumulating', () => {
    useProviderQuotaStore.getState().apply([snapshot()]);
    useProviderQuotaStore
      .getState()
      .apply([snapshot({ windows: [{ id: 'primary', usedPercent: 44 }], capturedAt: 2 })]);
    const meters = Object.values(useProviderQuotaStore.getState().meters);
    expect(meters).toHaveLength(1);
    expect(meters[0]?.windows[0]?.usedPercent).toBe(44);
  });

  it('carries forward a plan label a later reading omits', () => {
    useProviderQuotaStore.getState().apply([snapshot({ planLabel: 'pro' })]);
    useProviderQuotaStore.getState().apply([snapshot({ capturedAt: 2 })]);
    expect(Object.values(useProviderQuotaStore.getState().meters)[0]?.planLabel).toBe('pro');
  });

  it('ignores malformed frames instead of storing them', () => {
    useProviderQuotaStore
      .getState()
      .apply([null, 'nope', { providerId: 'x' }, snapshot()] as unknown as QuotaSnapshot[]);
    expect(Object.keys(useProviderQuotaStore.getState().meters)).toHaveLength(1);
  });
});

describe('selectWorstQuotaWindow', () => {
  it('picks the most-consumed window across providers, not the first reported', () => {
    useProviderQuotaStore.getState().apply([
      snapshot({ windows: [{ id: 'primary', usedPercent: 20, windowMinutes: 300 }] }),
      snapshot({
        providerId: 'anthropic-oauth',
        meterId: 'default',
        windows: [{ id: 'primary', usedPercent: 93, windowMinutes: 10080 }],
      }),
    ]);
    const worst = selectWorstQuotaWindow(useProviderQuotaStore.getState().meters);
    expect(worst?.snapshot.providerId).toBe('anthropic-oauth');
    expect(worst?.window.usedPercent).toBe(93);
  });

  it('breaks a tie toward the window that resets sooner', () => {
    const now = Math.floor(Date.now() / 1000);
    useProviderQuotaStore.getState().apply([
      snapshot({ windows: [{ id: 'secondary', usedPercent: 90, resetsAt: now + 86_400 }] }),
      snapshot({
        meterId: 'other',
        windows: [{ id: 'primary', usedPercent: 90, resetsAt: now + 3_600 }],
      }),
    ]);
    expect(selectWorstQuotaWindow(useProviderQuotaStore.getState().meters)?.window.id).toBe(
      'primary',
    );
  });

  it('returns nothing before any provider has reported', () => {
    expect(selectWorstQuotaWindow({})).toBeUndefined();
  });
});

describe('presentation', () => {
  it('names a window by its label, its length, then its id', () => {
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0, label: 'weekly' })).toBe('weekly');
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0, windowMinutes: 300 })).toBe('5h');
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0, windowMinutes: 10080 })).toBe('7d');
    expect(quotaWindowLabel({ id: 'primary', usedPercent: 0 })).toBe('primary');
  });

  it('counts down to a reset and drops one already past', () => {
    const now = 1_000_000;
    expect(formatQuotaResetIn({ id: 'p', usedPercent: 1, resetsAt: now / 1000 + 3600 }, now)).toBe(
      '1h',
    );
    expect(
      formatQuotaResetIn({ id: 'p', usedPercent: 1, resetsAt: now / 1000 - 10 }, now),
    ).toBeUndefined();
    expect(formatQuotaResetIn({ id: 'p', usedPercent: 1 })).toBeUndefined();
  });
});
