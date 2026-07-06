/**
 * D5/M2 — Pin the disjoint-bucket cost contract.
 *
 * Provider normalization guarantees `usage.input`, `usage.cacheRead`,
 * and `usage.cacheWrite` are DISJOINT (no overlap with each other).
 * OpenAI returns prompt_tokens as the TOTAL including cached portion,
 * Anthropic returns input_tokens as fresh-only with separate cache
 * fields — both are normalized at the provider boundary so the
 * downstream cost math is just `Σ bucket * pricePerBucket`.
 *
 * This test pins that contract from the aggregator's perspective: if
 * a future provider regression starts double-billing (e.g. reporting
 * `input = total` while ALSO reporting `cacheRead = cached`), the
 * test catches the dollar overcount before it ships.
 */
import { describe, expect, it } from 'vitest';
import { FleetBus, FleetUsageAggregator } from '../../src/coordination/fleet-bus.js';

describe('FleetUsageAggregator (M2 cost accuracy)', () => {
  it('disjoint buckets — cost equals sum of per-bucket products, no double count', () => {
    const bus = new FleetBus();
    // Realistic rates: $3/MT input, $15/MT output, $0.30/MT cacheRead,
    // $3.75/MT cacheWrite (representative Anthropic ballpark).
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const agg = new FleetUsageAggregator(
      bus,
      () => price,
      () => ({ provider: 'anthropic', model: 'anthropic-test-model' }),
    );

    // 1M fresh input, 100k output, 500k cacheRead, 200k cacheWrite —
    // all disjoint, the provider normalization guarantee.
    bus.emit({
      subagentId: 's1',
      ts: Date.now(),
      type: 'provider.response',
      payload: {
        usage: {
          input: 1_000_000,
          output: 100_000,
          cacheRead: 500_000,
          cacheWrite: 200_000,
        },
      },
    });

    const snap = agg.snapshot();
    // input: 1e6 / 1e6 * 3 = 3
    // output: 1e5 / 1e6 * 15 = 1.5
    // cacheRead: 5e5 / 1e6 * 0.3 = 0.15
    // cacheWrite: 2e5 / 1e6 * 3.75 = 0.75
    // total: 5.40
    expect(snap.total.cost).toBeCloseTo(5.4, 6);
    expect(snap.perSubagent.s1!.cost).toBeCloseTo(5.4, 6);
    // Bucket totals must accumulate exactly.
    expect(snap.total.input).toBe(1_000_000);
    expect(snap.total.cacheRead).toBe(500_000);
    expect(snap.total.cacheWrite).toBe(200_000);
  });

  it('per-subagent isolation — two subagents accumulate independently', () => {
    const bus = new FleetBus();
    const agg = new FleetUsageAggregator(
      bus,
      () => ({ input: 3, output: 15 }),
    );

    bus.emit({
      subagentId: 'a',
      ts: 1,
      type: 'provider.response',
      payload: { usage: { input: 1_000_000, output: 0 } },
    });
    bus.emit({
      subagentId: 'b',
      ts: 2,
      type: 'provider.response',
      payload: { usage: { input: 2_000_000, output: 0 } },
    });

    const snap = agg.snapshot();
    expect(snap.perSubagent.a!.cost).toBeCloseTo(3.0, 6);
    expect(snap.perSubagent.b!.cost).toBeCloseTo(6.0, 6);
    // Fleet total = per-subagent sum, no leakage.
    expect(snap.total.cost).toBeCloseTo(9.0, 6);
  });

  it('missing price lookup — bucket counts still accumulate, cost stays 0', () => {
    const bus = new FleetBus();
    // No priceLookup — Director without a models registry, e.g. tests.
    const agg = new FleetUsageAggregator(bus);

    bus.emit({
      subagentId: 's1',
      ts: 1,
      type: 'provider.response',
      payload: { usage: { input: 1_000_000, output: 100_000 } },
    });

    const snap = agg.snapshot();
    expect(snap.total.cost).toBe(0);
    // Token counts ARE still tracked — useful for "how many tokens
    // did the fleet burn" even without pricing wired up.
    expect(snap.total.input).toBe(1_000_000);
    expect(snap.total.output).toBe(100_000);
  });

  it('partial price (no cacheRead rate) — cost ignores the missing bucket', () => {
    const bus = new FleetBus();
    const agg = new FleetUsageAggregator(
      bus,
      () => ({ input: 3, output: 15 }), // no cacheRead / cacheWrite
    );
    bus.emit({
      subagentId: 's1',
      ts: 1,
      type: 'provider.response',
      payload: {
        usage: { input: 1_000_000, output: 0, cacheRead: 500_000 },
      },
    });
    // Only input is priced — cacheRead bucket is tracked but not billed.
    expect(agg.snapshot().total.cost).toBeCloseTo(3.0, 6);
    expect(agg.snapshot().total.cacheRead).toBe(500_000);
  });
});
