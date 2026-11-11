import { describe, expect, it } from 'vitest';
import { buildContextTimeline, indexAt } from '../../src/lib/session-context-timeline';
import type { ChronicleEventView } from '../../src/types';

let n = 0;
function event(
  eventType: string,
  at: number,
  attributes: Record<string, unknown>,
  scope: Record<string, string | undefined> = { sessionId: 's1' },
): ChronicleEventView {
  n++;
  return {
    schemaVersion: 1,
    eventId: `e${n}`,
    eventType,
    occurredAt: new Date(at).toISOString(),
    observedAt: new Date(at).toISOString(),
    persistedAt: new Date(at).toISOString(),
    sequence: n,
    hash: '',
    previousHash: '',
    scope,
    correlation: {},
    attributes,
  };
}

const residency = (at: number, seq: number, over: Record<string, unknown> = {}) =>
  event('context.residency', at, {
    agentId: 'leader',
    seq,
    provider: 'anthropic',
    model: 'opus',
    mechanism: 'explicit',
    maxContext: 200_000,
    total: 30_000,
    cached: 24_000,
    written: 4_000,
    uncached: 2_000,
    usageInput: 1_000,
    usageCacheRead: 26_000,
    usageCacheWrite: 4_000,
    verdict: 'hit',
    breakers: [],
    segments: [
      { kind: 'history-prior', tokens: 20_000, lane: 'cached', count: 10 },
      { kind: 'history-new', tokens: 4_000, lane: 'written', count: 2 },
      { kind: 'live-tail', tokens: 2_000, lane: 'uncached', count: 3 },
    ],
    live: [{ source: 'ledger', tokens: 2_000 }],
    historyMessages: 12,
    ...over,
  });

describe('buildContextTimeline', () => {
  it('turns residency events into ordered points with in-flow and cache stats', () => {
    const t = buildContextTimeline([residency(3_000, 2), residency(1_000, 1)]);
    expect(t.agent).toBe('leader');
    expect(t.points.map((p) => p.seq)).toEqual([1, 2]);
    expect(t.points[0]).toMatchObject({ usage: 31_000, added: 6_000, historyMessages: 12 });
    expect(t.maxContext).toBe(200_000);
    expect(t.peak).toBe(31_000);
    expect(t.cacheRate).toBeCloseTo(26_000 / 31_000);
  });

  it('reads compaction, trim, repair and rewind as out-flow marks', () => {
    const t = buildContextTimeline([
      residency(1_000, 1),
      event('compaction.fired', 2_000, {
        level: 'soft',
        report: {
          before: 50_000,
          after: 20_000,
          fullRequestTokensBefore: 60_000,
          fullRequestTokensAfter: 28_000,
          reductions: [
            { phase: 'elide', saved: 25_000 },
            { phase: 'noop', saved: 0 },
          ],
        },
      }),
      event('compaction.emergency_trim', 2_500, {
        saved: 4_000,
        trimmedBlocks: 3,
        droppedMessages: 1,
      }),
      event('context.repaired', 2_600, {
        changed: true,
        removedToolUses: ['a'],
        removedToolResults: { items: ['b'], total: 30, truncated: true },
        removedMessages: 0,
      }),
      event('context.repaired', 2_700, { changed: false }),
      event('session.rewound', 2_800, { toPromptIndex: 3, removedEvents: 9 }),
      residency(3_000, 2),
    ]);
    expect(t.marks.map((m) => m.kind)).toEqual(['compaction', 'trim', 'repair', 'rewind']);
    expect(t.marks[0]).toMatchObject({ removed: 32_000, before: 60_000, after: 28_000 });
    expect(t.marks[0]?.facts).toEqual(['elide −25,000']);
    expect(t.marks[2]?.facts).toContain('30 tool_result');
    expect(t.removedTotal).toBe(36_000);
  });

  it('says WHY it fired when the long-context price cliff capped the pass', () => {
    // The distinction the whole feature exists to make: on a 1M window a
    // compaction at 210K is not capacity pressure, it is the 2x billing
    // boundary at 200K. Without this fact the timeline reads like a runaway.
    const t = buildContextTimeline([
      residency(1_000, 1),
      event('compaction.fired', 2_000, {
        level: 'soft',
        report: {
          before: 210_000,
          after: 120_000,
          reductions: [{ phase: 'summary', saved: 90_000 }],
        },
        priceCliff: { cliffTokens: 200_000, triggerTokens: 190_000 },
      }),
    ]);
    expect(t.marks[0]?.facts).toEqual(['price cliff 200,000 → fired 190,000', 'summary −90,000']);
  });

  it('leaves window-relative marks untouched when no cliff was applied', () => {
    const t = buildContextTimeline([
      residency(1_000, 1),
      event('compaction.fired', 2_000, {
        level: 'hard',
        report: {
          before: 900_000,
          after: 400_000,
          reductions: [{ phase: 'elide', saved: 50_000 }],
        },
      }),
    ]);
    expect(t.marks[0]?.facts).toEqual(['elide −50,000']);
  });

  it('separates agent lanes and keeps agentless marks on the main lane', () => {
    const events = [
      residency(1_000, 1),
      residency(1_500, 1, { agentId: 'worker-1' }),
      event('compaction.fired', 2_000, { report: { before: 10, after: 5 } }),
    ];
    const main = buildContextTimeline(events);
    expect(main.agents).toEqual(['leader', 'worker-1']);
    expect(main.marks).toHaveLength(1);
    const worker = buildContextTimeline(events, 'worker-1');
    expect(worker.points).toHaveLength(1);
    expect(worker.marks).toHaveLength(0);
    // An unknown lane falls back to the main one instead of an empty chart.
    expect(buildContextTimeline(events, 'ghost').agent).toBe('leader');
  });

  it('places a mark between the two requests it happened between', () => {
    const t = buildContextTimeline([residency(1_000, 1), residency(3_000, 2)]);
    expect(indexAt(t.points, 2_000)).toBeCloseTo(0.5);
    expect(indexAt(t.points, 500)).toBe(-0.5);
    expect(indexAt(t.points, 9_000)).toBe(1.5);
  });
});
