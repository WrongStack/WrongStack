/**
 * The collection policy and the sink that applies it.
 *
 * What matters here is not that events disappear -- it is that the *questions*
 * they answered survive. A folded `permission.evaluated` still has to tell an
 * operator how many auto-approvals a session made and for which tools; a
 * folded `token.accounted` still has to carry the running totals. And a
 * failure, a denial or an operator prompt has to stay a row of its own at
 * every level, because those are the rows anyone actually opens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChronicleCounterSink } from '../../src/chronicle/counter-sink.js';
import {
  DEFAULT_CHRONICLE_DETAIL,
  resolveChronicleDetail,
  routeChronicleEvent,
} from '../../src/chronicle/detail-policy.js';
import type { ChronicleEventSink } from '../../src/chronicle/sink.js';
import type { ChronicleEvent, ChronicleEventInput } from '../../src/chronicle/types.js';

function recordingSink(): ChronicleEventSink & { readonly written: ChronicleEventInput[] } {
  const written: ChronicleEventInput[] = [];
  return {
    written,
    async append(input) {
      written.push(input);
      return input as ChronicleEvent;
    },
    async appendBatch(inputs) {
      written.push(...inputs);
      return inputs as ChronicleEvent[];
    },
    async flush() {},
    stats: () =>
      ({
        acceptedEvents: 0,
        persistedEvents: 0,
        rejectedEvents: 0,
        failedEvents: 0,
        batches: 0,
        pendingEvents: 0,
        partitionRolls: 0,
        maxObservedPending: 0,
        largestBatch: 0,
      }) as never,
  };
}

function event(overrides: Partial<ChronicleEventInput> = {}): ChronicleEventInput {
  return {
    eventType: 'permission.evaluated',
    outcome: 'success',
    scope: { installationId: 'i', machineId: 'm', sessionId: 's1' },
    correlation: { traceId: 't', spanId: 'sp' },
    attributes: {
      toolName: 'grep',
      policyDecision: 'auto',
      effectiveDecision: 'auto',
      boundaryDecision: 'allow',
      capabilityDowngraded: false,
    },
    ...overrides,
  };
}

describe('routeChronicleEvent', () => {
  it('keeps everything at the full level', () => {
    expect(routeChronicleEvent(event(), 'full')).toEqual({ keep: true });
    expect(routeChronicleEvent(event({ eventType: 'iteration.started' }), 'full')).toEqual({
      keep: true,
    });
  });

  it('folds a blanket auto-approval but keeps a real decision', () => {
    expect(routeChronicleEvent(event(), 'balanced')).toEqual({
      keep: false,
      count: 'permission.auto',
    });
    for (const attributes of [
      { effectiveDecision: 'ask' },
      { policyDecision: 'ask' },
      { capabilityDowngraded: true },
      { boundaryDecision: 'deny' },
    ]) {
      const decided = event({
        attributes: { ...event().attributes, ...attributes },
      });
      expect(routeChronicleEvent(decided, 'balanced')).toEqual({ keep: true });
    }
  });

  it('never folds a failure, denial or cancellation', () => {
    for (const outcome of ['failure', 'denied', 'cancelled'] as const) {
      expect(routeChronicleEvent(event({ outcome }), 'lean')).toEqual({ keep: true });
      expect(routeChronicleEvent(event({ eventType: 'tool.started', outcome }), 'lean')).toEqual({
        keep: true,
      });
    }
  });

  it('folds the routine tool lifecycle only at the lean level', () => {
    const started = event({ eventType: 'tool.started', outcome: 'started' });
    expect(routeChronicleEvent(started, 'balanced')).toEqual({ keep: true });
    expect(routeChronicleEvent(started, 'lean')).toEqual({ keep: false, count: 'tool.started' });
  });

  it('reads the level off config and falls back to the default', () => {
    expect(resolveChronicleDetail({ chronicle: { detail: 'lean' } })).toBe('lean');
    expect(resolveChronicleDetail({ chronicle: { detail: 'nonsense' } })).toBe(
      DEFAULT_CHRONICLE_DETAIL,
    );
    expect(resolveChronicleDetail(undefined)).toBe(DEFAULT_CHRONICLE_DETAIL);
  });
});

describe('chronicle counter sink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('writes one aggregate per window instead of one row per occurrence', async () => {
    const inner = recordingSink();
    const sink = createChronicleCounterSink({ inner, level: 'balanced', windowMs: 60_000 });

    for (let index = 0; index < 50; index += 1) await sink.append(event());
    expect(inner.written).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(inner.written).toHaveLength(1);
    expect(inner.written[0]).toMatchObject({
      eventType: 'metrics.counter',
      attributes: {
        counter: 'permission.auto',
        samples: 50,
        dimension: 'grep',
        outcomes: { success: 50 },
      },
    });
    await sink.dispose();
  });

  it('separates counters by tool, so "which tool" survives the fold', async () => {
    const inner = recordingSink();
    const sink = createChronicleCounterSink({ inner, level: 'balanced', windowMs: 60_000 });
    await sink.append(event());
    await sink.append(event({ attributes: { ...event().attributes, toolName: 'bash' } }));
    await sink.drain();

    const dimensions = inner.written.map(
      (written) => (written.attributes as { dimension?: string }).dimension,
    );
    expect(dimensions.sort()).toEqual(['bash', 'grep']);
    await sink.dispose();
  });

  it('carries token deltas as sums and cumulative totals as latest', async () => {
    const inner = recordingSink();
    const sink = createChronicleCounterSink({ inner, level: 'balanced', windowMs: 60_000 });
    const accounted = (deltaOutput: number, totalOutput: number): ChronicleEventInput =>
      event({
        eventType: 'token.accounted',
        outcome: 'unknown',
        attributes: {
          usage: { input: 177, output: totalOutput, cacheRead: 0, cacheWrite: 0 },
          deltaUsage: { input: 0, output: deltaOutput, cacheRead: 0, cacheWrite: 0 },
          cost: { total: 0 },
        },
      });
    await sink.append(accounted(100, 1_000));
    await sink.append(accounted(250, 1_250));
    await sink.drain();

    expect(inner.written[0]).toMatchObject({
      attributes: {
        counter: 'token.accounted',
        samples: 2,
        // Deltas add up; the cumulative total is latest-wins, exactly as the
        // raw events were read before they were folded.
        sums: { 'deltaUsage.output': 350 },
        latest: { 'usage.output': 1_250 },
      },
    });
    await sink.dispose();
  });

  it('passes kept events straight through, in order, mixed with folded ones', async () => {
    const inner = recordingSink();
    const sink = createChronicleCounterSink({ inner, level: 'balanced', windowMs: 60_000 });
    const denied = event({ outcome: 'denied' });
    const kept = event({ eventType: 'tool.executed', outcome: 'success' });

    const results = await sink.appendBatch([event(), denied, event(), kept]);
    expect(results).toHaveLength(4);
    expect(inner.written.map((written) => written.eventType)).toEqual([
      'permission.evaluated',
      'tool.executed',
    ]);
    expect(inner.written[0]).toBe(denied);
    await sink.dispose();
  });

  it('drains open windows on dispose, then stops folding', async () => {
    const inner = recordingSink();
    const sink = createChronicleCounterSink({ inner, level: 'balanced', windowMs: 60_000 });
    await sink.append(event());
    await sink.dispose();

    // The last window reached the journal rather than dying with the process.
    expect(inner.written).toHaveLength(1);
    expect(inner.written[0]?.eventType).toBe('metrics.counter');

    // After dispose the timer is gone, so anything still arriving during
    // shutdown must go straight through or it would never be written at all.
    await sink.append(event());
    expect(inner.written).toHaveLength(2);
    expect(inner.written[1]?.eventType).toBe('permission.evaluated');
  });

  it('folds nothing at the full level', async () => {
    const inner = recordingSink();
    const sink = createChronicleCounterSink({ inner, level: 'full', windowMs: 60_000 });
    await sink.append(event());
    expect(inner.written).toHaveLength(1);
    expect(inner.written[0]?.eventType).toBe('permission.evaluated');
    await sink.dispose();
  });
});
