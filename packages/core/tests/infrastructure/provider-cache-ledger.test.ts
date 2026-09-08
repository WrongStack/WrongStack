import { describe, expect, it } from 'vitest';
import {
  ProviderCacheLedger,
  RECENT_HIT_RATIO_WINDOW,
} from '../../src/infrastructure/provider-cache-ledger.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Usage } from '../../src/types/provider.js';

/** Emit a token.accounted event with a CUMULATIVE usage snapshot. */
function emit(events: EventBus, usage: Usage, provider?: string) {
  events.emit('token.accounted', {
    usage,
    cost: { input: 0, output: 0, total: 0 },
    ...(provider ? { provider } : {}),
  });
}

describe('ProviderCacheLedger', () => {
  it('attributes per-request deltas (from cumulative usage) to the right provider', () => {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);

    // Request 1 on anthropic: input 100, cacheRead 900 (cumulative).
    emit(events, { input: 100, output: 10, cacheRead: 900, cacheWrite: 50 }, 'anthropic');
    // Request 2 switches to openai: cumulative grows by input 200, cacheRead 300.
    emit(events, { input: 300, output: 20, cacheRead: 1200, cacheWrite: 50 }, 'openai');

    const rows = ledger.perProvider();
    expect(ledger.providers().sort()).toEqual(['anthropic', 'openai']);

    const anthropic = rows.find((r) => r.provider === 'anthropic')!;
    expect(anthropic.input).toBe(100);
    expect(anthropic.cacheRead).toBe(900);
    expect(anthropic.hitRatio).toBeCloseTo(900 / 1050, 6);

    const openai = rows.find((r) => r.provider === 'openai')!;
    expect(openai.input).toBe(200); // delta 300 − 100
    expect(openai.cacheRead).toBe(300); // delta 1200 − 900
    expect(openai.cacheWrite).toBe(0); // delta 50 − 50
    expect(openai.hitRatio).toBeCloseTo(300 / 500, 6);
  });

  it('accumulates repeated requests to the same provider', () => {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);
    emit(events, { input: 50, output: 0, cacheRead: 50 }, 'openai');
    emit(events, { input: 100, output: 0, cacheRead: 150 }, 'openai');
    const [row] = ledger.perProvider();
    expect(row!.provider).toBe('openai');
    expect(row!.input).toBe(100); // 50 + 50
    expect(row!.cacheRead).toBe(150); // 50 + 100
  });

  it('buckets provider-less events under "unknown"', () => {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);
    emit(events, { input: 10, output: 0, cacheRead: 90 });
    expect(ledger.providers()).toEqual(['unknown']);
  });

  it('sorts by cacheRead descending', () => {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);
    emit(events, { input: 10, output: 0, cacheRead: 100 }, 'a');
    emit(events, { input: 10, output: 0, cacheRead: 1100 }, 'b'); // delta 1000
    expect(ledger.perProvider().map((r) => r.provider)).toEqual(['b', 'a']);
  });

  it('stops accounting after dispose', () => {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);
    emit(events, { input: 10, output: 0, cacheRead: 90 }, 'a');
    ledger.dispose();
    emit(events, { input: 100, output: 0, cacheRead: 900 }, 'a');
    expect(ledger.perProvider()[0]!.cacheRead).toBe(90);
  });
});

describe('last-request cache ratio', () => {
  function ledgerWith(deltas: Array<{ input: number; cacheRead: number }>): ProviderCacheLedger {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);
    for (const d of deltas) {
      events.emit('token.accounted', {
        usage: { input: d.input, output: 0, cacheRead: d.cacheRead },
        deltaUsage: { input: d.input, output: 0, cacheRead: d.cacheRead },
        cost: { input: 0, output: 0, total: 0 },
        provider: 'openai-codex',
      });
    }
    return ledger;
  }

  it('reports the newest request separately from the session total', () => {
    // The session figure permanently carries the first turn, which can never
    // hit — so a healthy session still reads low early and climbs. Turn 1 here
    // is a total miss and turn 2 a 95% hit: cumulative lands near 48%, which is
    // exactly the "stuck at 40-50%" a reader would misdiagnose as broken.
    const ledger = ledgerWith([
      { input: 1_000, cacheRead: 0 },
      { input: 50, cacheRead: 950 },
    ]);
    const [row] = ledger.perProvider();
    expect(row?.hitRatio).toBeCloseTo(0.475, 3);
    expect(row?.lastHitRatio).toBeCloseTo(0.95, 3);
    expect(row?.lastPromptTokens).toBe(1_000);
    ledger.dispose();
  });

  it('has no last-request figure before anything was accounted', () => {
    const events = new EventBus();
    const ledger = new ProviderCacheLedger(events);
    expect(ledger.perProvider()).toEqual([]);
    ledger.dispose();
  });

  it('ignores a zero-token settle rather than reporting a 0% turn', () => {
    // Out-of-order price settles re-emit with no new tokens; counting one as a
    // request would report a turn that never happened.
    const ledger = ledgerWith([
      { input: 50, cacheRead: 950 },
      { input: 0, cacheRead: 0 },
    ]);
    const [row] = ledger.perProvider();
    expect(row?.lastHitRatio).toBeCloseTo(0.95, 3);
    ledger.dispose();
  });
  it('keeps a bounded per-request trend, which is what actually diagnoses a cache', () => {
    // A cumulative ratio cannot distinguish a healthy young session from a
    // broken old one; the SHAPE of the recent requests can.
    const ledger = ledgerWith([
      { input: 1_000, cacheRead: 0 },
      { input: 500, cacheRead: 500 },
      { input: 200, cacheRead: 800 },
      { input: 100, cacheRead: 900 },
      { input: 80, cacheRead: 920 },
      { input: 60, cacheRead: 940 },
      { input: 50, cacheRead: 950 },
      { input: 40, cacheRead: 960 },
    ]);
    const [row] = ledger.perProvider();
    expect(row?.recentHitRatios).toHaveLength(RECENT_HIT_RATIO_WINDOW);
    // Oldest first, and the window dropped the first two (total-miss) requests.
    expect(row?.recentHitRatios?.[0]).toBeCloseTo(0.8, 3);
    expect(row?.recentHitRatios?.at(-1)).toBeCloseTo(0.96, 3);
    ledger.dispose();
  });

  it('does not record a trend point for a zero-token settle', () => {
    const ledger = ledgerWith([
      { input: 50, cacheRead: 950 },
      { input: 0, cacheRead: 0 },
    ]);
    const [row] = ledger.perProvider();
    expect(row?.recentHitRatios).toEqual([0.95]);
    ledger.dispose();
  });
});
