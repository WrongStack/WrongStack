import { describe, expect, it } from 'vitest';
import { ProviderCacheLedger } from '../../src/infrastructure/provider-cache-ledger.js';
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
