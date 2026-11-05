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
  groupQuotaSnapshots,
  hasQuotaData,
  listQuotaProviders,
  onProviderQuota,
  type ProviderQuotaSnapshot,
  quotaExhaustionInMs,
  quotaResetInMs,
  quotaWindowLabel,
  reachedQuotaWindow,
  recordProviderQuota,
  resetProviderQuota,
  withQuotaPace,
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

  it('stores a note-only snapshot (no windows, no credits)', () => {
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [], note: 'Upgrade to Pro for more quota' }),
    ]);
    const current = getProviderQuota('openai-codex');
    expect(current).toHaveLength(1);
    expect(current[0]?.note).toBe('Upgrade to Pro for more quota');
  });

  it('stores a reachedWindowId-only snapshot', () => {
    recordProviderQuota('openai-codex', [snapshot({ windows: [], reachedWindowId: 'primary' })]);
    const current = getProviderQuota('openai-codex');
    expect(current).toHaveLength(1);
    expect(current[0]?.reachedWindowId).toBe('primary');
  });

  it('stores a note-only snapshot without erasing the previous windows', () => {
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 10 }] }),
    ]);
    recordProviderQuota('openai-codex', [snapshot({ windows: [], note: 'Upgrade to Pro' })]);
    const current = getProviderQuota('openai-codex');
    expect(current).toHaveLength(1);
    expect(current[0]?.note).toBe('Upgrade to Pro');
    expect(current[0]?.windows[0]?.usedPercent).toBe(10);
  });

  it('stores a reachedWindowId-only snapshot without erasing the previous windows', () => {
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 10 }] }),
    ]);
    recordProviderQuota('openai-codex', [snapshot({ windows: [], reachedWindowId: 'primary' })]);
    const current = getProviderQuota('openai-codex');
    expect(current).toHaveLength(1);
    expect(current[0]?.reachedWindowId).toBe('primary');
    expect(current[0]?.windows[0]?.usedPercent).toBe(10);
  });

  it('clears the cut-off flag when a fresh window reading no longer reports it', () => {
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 100 }], reachedWindowId: 'primary' }),
    ]);
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 2 }] }),
    ]);
    expect(getProviderQuota('openai-codex')[0]?.reachedWindowId).toBeUndefined();
  });

  it('keeps the cut-off flag across a note-only reading', () => {
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 100 }], reachedWindowId: 'primary' }),
    ]);
    recordProviderQuota('openai-codex', [snapshot({ windows: [], note: 'Upgrade to Pro' })]);
    expect(getProviderQuota('openai-codex')[0]?.reachedWindowId).toBe('primary');
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

  it('skips a non-finite percent so a later finite window still wins', () => {
    const worst = worstProviderQuotaWindow([
      snapshot({
        windows: [
          { id: 'broken', usedPercent: Number.NaN },
          { id: 'primary', usedPercent: 90 },
        ],
      }),
    ]);
    expect(worst?.window).toMatchObject({ id: 'primary', usedPercent: 90 });
    expect(
      worstProviderQuotaWindow([
        snapshot({ windows: [{ id: 'broken', usedPercent: Number.POSITIVE_INFINITY }] }),
      ]),
    ).toBeUndefined();
  });

  it('returns nothing when no provider has reported', () => {
    expect(worstProviderQuotaWindow()).toBeUndefined();
  });

  it('leaves out a gateway pool account: the gateway rotates past it', () => {
    const worst = worstProviderQuotaWindow([
      snapshot({ windows: [{ id: 'primary', usedPercent: 40 }] }),
      snapshot({
        providerId: 'omniroute',
        meterId: 'omniroute:c1',
        via: 'omniroute',
        windows: [{ id: 'premium', usedPercent: 100 }],
        reachedWindowId: 'premium',
      }),
    ]);
    expect(worst?.window.usedPercent).toBe(40);
    expect(
      worstProviderQuotaWindow([
        snapshot({ via: 'omniroute', windows: [{ id: 'primary', usedPercent: 90 }] }),
      ]),
    ).toBeUndefined();
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
    // Never show the cut-off figure before it is reached.
    expect(formatQuotaPercent(99.6)).toBe('99%');
    expect(formatQuotaPercent(100)).toBe('100%');
    expect(formatQuotaPercent(9.97)).toBe('10%');
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

describe('quotaExhaustionInMs (pace forecast)', () => {
  const MIN = 60_000;
  const T0 = 1_800_000_000_000;
  /** A 5h window resetting 3 hours after T0 (resetsAt is epoch seconds). */
  const reading = (usedPercent: number, resetsAt = (T0 + 180 * MIN) / 1000) =>
    snapshot({ windows: [{ id: 'primary', usedPercent, resetsAt }] });
  const window = (usedPercent: number, resetsAt = (T0 + 180 * MIN) / 1000) => ({
    id: 'primary',
    usedPercent,
    resetsAt,
  });

  it('projects the climb of the last hour to 100% when that lands before the reset', () => {
    recordProviderQuota('openai-codex', [reading(40)], T0);
    recordProviderQuota('openai-codex', [reading(50)], T0 + 20 * MIN);
    // 10 points in 20 minutes; 50 points left → 100 minutes.
    const eta = quotaExhaustionInMs('openai-codex', 'default', window(50), T0 + 20 * MIN);
    expect(eta).toBe(100 * MIN);
    expect(formatQuotaResetIn(eta)).toBe('1h 40m');
  });

  it('says nothing when the pace resets first, the plan is flat, or the record is too short', () => {
    recordProviderQuota('openai-codex', [reading(40)], T0);
    recordProviderQuota('openai-codex', [reading(41)], T0 + 30 * MIN);
    // 1 point per 30 minutes: 59 points take far longer than the 150 minutes left.
    expect(
      quotaExhaustionInMs('openai-codex', 'default', window(41), T0 + 30 * MIN),
    ).toBeUndefined();

    resetProviderQuota();
    recordProviderQuota('openai-codex', [reading(40)], T0);
    recordProviderQuota('openai-codex', [reading(40)], T0 + 30 * MIN);
    expect(
      quotaExhaustionInMs('openai-codex', 'default', window(40), T0 + 30 * MIN),
    ).toBeUndefined();

    resetProviderQuota();
    recordProviderQuota('openai-codex', [reading(40)], T0);
    recordProviderQuota('openai-codex', [reading(60)], T0 + 2 * MIN);
    expect(
      quotaExhaustionInMs('openai-codex', 'default', window(60), T0 + 2 * MIN),
    ).toBeUndefined();
  });

  it('keeps the pace across a reset clock that wobbles by a second', () => {
    // "reset in N seconds" converted to an absolute time drifts between readings.
    const reset = (T0 + 180 * MIN) / 1000;
    recordProviderQuota('openai-codex', [reading(40, reset)], T0);
    recordProviderQuota('openai-codex', [reading(45, reset + 1)], T0 + 10 * MIN);
    recordProviderQuota('openai-codex', [reading(50, reset)], T0 + 20 * MIN);
    expect(quotaExhaustionInMs('openai-codex', 'default', window(50, reset), T0 + 20 * MIN)).toBe(
      100 * MIN,
    );
  });

  it('starts over when the window resets', () => {
    recordProviderQuota('openai-codex', [reading(80)], T0);
    recordProviderQuota('openai-codex', [reading(90)], T0 + 20 * MIN);
    // New cycle: a new reset time and a lower percentage.
    const next = (T0 + 500 * MIN) / 1000;
    recordProviderQuota('openai-codex', [reading(2, next)], T0 + 25 * MIN);
    expect(
      quotaExhaustionInMs('openai-codex', 'default', window(2, next), T0 + 25 * MIN),
    ).toBeUndefined();
  });

  it('forgets a pace older than an hour: an idle stretch is not a burn rate', () => {
    recordProviderQuota('openai-codex', [reading(40)], T0);
    recordProviderQuota('openai-codex', [reading(60)], T0 + 20 * MIN);
    expect(
      quotaExhaustionInMs('openai-codex', 'default', window(60), T0 + 120 * MIN),
    ).toBeUndefined();
  });

  it('withQuotaPace stamps exhaustsAt on copies, for a surface in another process', () => {
    recordProviderQuota('openai-codex', [reading(40)], T0);
    recordProviderQuota('openai-codex', [reading(50)], T0 + 20 * MIN);
    const stored = getProviderQuota('openai-codex');
    const [paced] = withQuotaPace(stored, T0 + 20 * MIN);
    expect(paced?.windows[0]?.exhaustsAt).toBe((T0 + 120 * MIN) / 1000);
    // The store itself is untouched: the forecast is derived, never recorded.
    expect(stored[0]?.windows[0]?.exhaustsAt).toBeUndefined();
    // No forecast → the window is passed through as it was.
    resetProviderQuota();
    recordProviderQuota('openai-codex', [reading(40)], T0);
    const [flat] = withQuotaPace(getProviderQuota('openai-codex'), T0);
    expect(flat?.windows[0]).not.toHaveProperty('exhaustsAt');

    // Once `now` passes `resetsAt`, a slow climb that did not exhaust before reset
    // must not stamp an `exhaustsAt` after `resetsAt`.
    resetProviderQuota();
    const resetsAt = (T0 + 30 * MIN) / 1000;
    recordProviderQuota('openai-codex', [reading(40, resetsAt)], T0);
    recordProviderQuota('openai-codex', [reading(41, resetsAt)], T0 + 20 * MIN);
    expect(
      quotaExhaustionInMs('openai-codex', 'default', window(41, resetsAt), T0 + 31 * MIN),
    ).toBeUndefined();
    const [afterReset] = withQuotaPace(getProviderQuota('openai-codex'), T0 + 31 * MIN);
    expect(afterReset?.windows[0]?.exhaustsAt).toBeUndefined();
  });
});

describe('groupQuotaSnapshots', () => {
  const snap = (
    providerId: string,
    usedPercent: number,
    resetsAt?: number,
  ): ProviderQuotaSnapshot => ({
    providerId,
    meterId: 'default',
    meterLabel: 'OpenCode Go',
    windows: [{ id: 'primary', usedPercent, windowMinutes: 300, resetsAt }],
    capturedAt: 1,
  });

  it('folds one account seen through several providers, in input order', () => {
    const groups = groupQuotaSnapshots([
      snap('opencode', 12, 2_000),
      snap('kimi', 12, 9_000),
      snap('opencode-go', 12, 2_000),
      snap('opencode-go-ws', 12, 2_000),
    ]);
    expect(groups.map((g) => g.providerIds)).toEqual([
      ['opencode', 'opencode-go', 'opencode-go-ws'],
      ['kimi'],
    ]);
    expect(groups[0]?.snapshot.providerId).toBe('opencode');
  });

  it('keeps readings apart when any window differs or has no reset clock', () => {
    expect(
      groupQuotaSnapshots([snap('a', 12, 2_000), snap('b', 13, 2_000)]).map((g) => g.providerIds),
    ).toEqual([['a'], ['b']]);
    expect(groupQuotaSnapshots([snap('a', 0), snap('b', 0)]).map((g) => g.providerIds)).toEqual([
      ['a'],
      ['b'],
    ]);
    const empty = { ...snap('c', 0), windows: [] };
    expect(groupQuotaSnapshots([empty, { ...empty, providerId: 'd' }])).toHaveLength(2);
  });

  it('guards non-finite quota values and rounds sub-minute countdowns at 59.5s to 1m (F123)', () => {
    resetProviderQuota();
    const T0 = 1_700_000_000_000;
    recordProviderQuota(
      'openai',
      [
        snapshot({
          providerId: 'openai',
          windows: [{ id: 'w1', usedPercent: 20 }],
          capturedAt: T0,
        }),
      ],
      T0,
    );
    recordProviderQuota(
      'openai',
      [
        snapshot({
          providerId: 'openai',
          windows: [{ id: 'w1', usedPercent: 40 }],
          capturedAt: T0 + 20 * 60_000,
        }),
      ],
      T0 + 20 * 60_000,
    );
    expect(
      quotaExhaustionInMs(
        'openai',
        'default',
        { id: 'w1', usedPercent: Number.NaN },
        T0 + 20 * 60_000,
      ),
    ).toBeUndefined();
    expect(formatQuotaResetIn(Number.NaN)).toBeUndefined();
    expect(formatQuotaResetIn(59_600)).toBe('1m');
    const worst = worstProviderQuotaWindow([
      {
        providerId: 'nan-reset',
        meterId: 'm',
        capturedAt: 1,
        windows: [{ id: 'w1', usedPercent: 80, resetsAt: Number.NaN }],
      },
      {
        providerId: 'finite-reset',
        meterId: 'm',
        capturedAt: 1,
        windows: [{ id: 'w2', usedPercent: 80, resetsAt: 2000 }],
      },
    ]);
    expect(worst?.snapshot.providerId).toBe('finite-reset');
  });

  it('clears stale note on a fresh window reading and normalizes snapshot.providerId (F969)', () => {
    resetProviderQuota();
    recordProviderQuota('openai-codex', [
      snapshot({ windows: [{ id: 'primary', usedPercent: 10 }] }),
    ]);
    recordProviderQuota('openai-codex', [snapshot({ windows: [], note: 'Temporarily throttled' })]);
    expect(getProviderQuota('openai-codex')[0]?.note).toBe('Temporarily throttled');

    recordProviderQuota('openai-codex', [
      snapshot({ providerId: 'custom-alias', windows: [{ id: 'primary', usedPercent: 25 }] }),
    ]);
    const latest = getProviderQuota('openai-codex')[0];
    expect(latest?.note).toBeUndefined();
    expect(latest?.providerId).toBe('openai-codex');
  });
});
