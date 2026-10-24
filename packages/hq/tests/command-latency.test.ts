/**
 * W4 #7 (RFC hq-improvements-2026-09.md) — Command latency SLO.
 *
 * Pins `summarizeCommandLatency`, the pure roll-up the HQ snapshot uses to
 * render the dispatched -> acknowledged percentile card. The audit ring stores
 * a mix of in-flight, disconnected, and legacy entries, so the summarizer's
 * REAL job is deciding what counts as a sample — the percentile arithmetic is
 * the easy half.
 */
import { describe, expect, it } from 'vitest';
import type { HqCommandAuditEntry } from '../src/index.js';
import { summarizeCommandLatency } from '../src/index.js';

/** Minimal audit entry; only the latency-relevant fields matter here. */
function entry(overrides: Partial<HqCommandAuditEntry>): HqCommandAuditEntry {
  return {
    commandId: `cmd-${Math.random().toString(36).slice(2, 10)}`,
    type: 'steer',
    clientId: 'host-1:cli:42:abcd',
    enqueuedBy: 'browser-token',
    enqueuedAt: new Date(0).toISOString(),
    status: 'acked',
    ...overrides,
  };
}

describe('summarizeCommandLatency (W4 #7)', () => {
  it('reports zero samples for an empty audit ring', () => {
    const summary = summarizeCommandLatency([]);
    expect(summary.sampleCount).toBe(0);
    expect(summary.p50Ms).toBeUndefined();
    expect(summary.p95Ms).toBeUndefined();
    expect(summary.p99Ms).toBeUndefined();
    expect(summary.maxMs).toBeUndefined();
  });

  it('ignores entries that never reached the client (queued only)', () => {
    const summary = summarizeCommandLatency([
      entry({ status: 'queued' }),
      entry({ status: 'delivered', dispatchedAt: 1_000 }),
    ]);
    expect(summary.sampleCount).toBe(0);
  });

  it('ignores a delivered-then-disconnected entry with no ack timestamp', () => {
    const summary = summarizeCommandLatency([
      entry({ status: 'acked', dispatchedAt: 1_000, acknowledgedAt: 1_100 }),
      entry({ status: 'acked', dispatchedAt: 2_000, ackStatus: 'failed' }),
    ]);
    expect(summary.sampleCount).toBe(1);
    expect(summary.p50Ms).toBe(100);
  });

  it('discards negative deltas instead of clamping them to zero', () => {
    // Clock skew between stamping sites produces a negative delta. Clamping
    // would invent a perfect 0 ms sample and drag every percentile down.
    const summary = summarizeCommandLatency([
      entry({ dispatchedAt: 5_000, acknowledgedAt: 4_000 }),
      entry({ dispatchedAt: 1_000, acknowledgedAt: 1_200 }),
    ]);
    expect(summary.sampleCount).toBe(1);
    expect(summary.p50Ms).toBe(200);
  });

  it('computes nearest-rank percentiles over a ten-sample window', () => {
    const entries = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((latency, index) =>
      entry({
        dispatchedAt: 1_000 + index * 1_000,
        acknowledgedAt: 1_000 + index * 1_000 + latency,
      }),
    );
    const summary = summarizeCommandLatency(entries);
    expect(summary.sampleCount).toBe(10);
    expect(summary.p50Ms).toBe(50);
    expect(summary.p95Ms).toBe(100);
    expect(summary.p99Ms).toBe(100);
    expect(summary.maxMs).toBe(100);
  });

  it('computes nearest-rank percentiles over a four-sample window', () => {
    const entries = [10, 20, 30, 40].map((latency) =>
      entry({ dispatchedAt: 0, acknowledgedAt: latency }),
    );
    const summary = summarizeCommandLatency(entries);
    expect(summary.sampleCount).toBe(4);
    // n=4 -> p50 is the 2nd of 4, p95/p99 saturate at the max.
    expect(summary.p50Ms).toBe(20);
    expect(summary.p95Ms).toBe(40);
    expect(summary.p99Ms).toBe(40);
    expect(summary.maxMs).toBe(40);
  });

  it('returns the single sample for every percentile when n=1', () => {
    const summary = summarizeCommandLatency([entry({ dispatchedAt: 0, acknowledgedAt: 42 })]);
    expect(summary.sampleCount).toBe(1);
    expect(summary.p50Ms).toBe(42);
    expect(summary.p95Ms).toBe(42);
    expect(summary.p99Ms).toBe(42);
    expect(summary.maxMs).toBe(42);
  });

  it('only samples the trailing `limit` window', () => {
    // The first entry is a pathological 1-hour latency; a limit of 3 must
    // exclude it so one stalled command cannot define the SLO forever.
    const entries = [
      entry({ dispatchedAt: 0, acknowledgedAt: 3_600_000 }),
      entry({ dispatchedAt: 0, acknowledgedAt: 10 }),
      entry({ dispatchedAt: 0, acknowledgedAt: 20 }),
      entry({ dispatchedAt: 0, acknowledgedAt: 30 }),
    ];
    const summary = summarizeCommandLatency(entries, 3);
    expect(summary.sampleCount).toBe(3);
    expect(summary.maxMs).toBe(30);
  });

  it('tolerates a zero-latency sample (same-millisecond dispatch and ack)', () => {
    const summary = summarizeCommandLatency([
      entry({ dispatchedAt: 7_000, acknowledgedAt: 7_000 }),
      entry({ dispatchedAt: 0, acknowledgedAt: 200 }),
    ]);
    expect(summary.sampleCount).toBe(2);
    expect(summary.p50Ms).toBe(0);
    expect(summary.maxMs).toBe(200);
  });

  it('does not mutate the caller-supplied entries', () => {
    const entries = [
      entry({ dispatchedAt: 0, acknowledgedAt: 300 }),
      entry({ dispatchedAt: 0, acknowledgedAt: 100 }),
    ];
    const before = entries.map((e) => e.acknowledgedAt);
    summarizeCommandLatency(entries);
    expect(entries.map((e) => e.acknowledgedAt)).toEqual(before);
  });
});
