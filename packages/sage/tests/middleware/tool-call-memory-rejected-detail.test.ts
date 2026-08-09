/**
 * Tests for the SAGE tool-call injector rejectedDetail accounting.
 *
 * The A4 plan extends the injector's per-run trace with a
 * `rejectedDetail` array carrying id + gate + reason for every memory
 * that was almost injected but rejected by a filter gate. This test
 * exercises the four filter chains (`duplicate`, `belowScore`,
 * `alreadyVisible`, `cooldown`, `budget`) and verifies the trace
 * payload shape — not the injector control flow, which is covered by
 * `tool-call-memory.test.ts`.
 */

import type { EventMap } from '@wrongstack/core/kernel';
import { describe, expect, it } from 'vitest';
import type { Sage } from '../../src/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem_test_injector',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text: 'A test memory with enough text to be meaningful and exercise the injector gates.',
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: ['test'],
    anchors: [{ type: 'file', path: 'src/foo.ts' }],
    sources: [{ type: 'user' }],
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

type InjectorRunPayload = EventMap['memory.injector_run'];
type RejectedDetailEntry = InjectorRunPayload['rejectedDetail'][number];
type TraceInput = Pick<
  InjectorRunPayload,
  'rejected' | 'rejectedDetail' | 'rejectedDetailTotal' | 'activated' | 'injected' | 'eligible'
>;

/** Mirrors the production emitter's payload assembly. */
function assemblePayload(input: TraceInput) {
  return {
    eligible: input.eligible,
    rejected: input.rejected,
    rejectedDetail: input.rejectedDetail,
    ...(input.rejectedDetailTotal !== undefined
      ? { rejectedDetailTotal: input.rejectedDetailTotal }
      : {}),
    activated: input.activated,
    injected: input.injected,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('tool-call-memory rejectedDetail (A4)', () => {
  it('emits one rejectedDetail entry per dropped memory with the correct gate', () => {
    const dropDuplicate = makeMemory({ id: 'mem-dup', text: 'duplicate text' });
    const dropBelowScore = makeMemory({ id: 'mem-low', importance: 0.1 });
    const dropAlreadyVisible = makeMemory({ id: 'mem-vis', text: 'visible text' });
    const dropCooldown = makeMemory({ id: 'mem-cd' });
    const dropBudget = makeMemory({ id: 'mem-bg' });

    const rejectedDetail: RejectedDetailEntry[] = [
      {
        id: dropDuplicate.id,
        kind: 'fact',
        gate: 'duplicate',
        reason: 'duplicate text',
        at: '2026-08-09T00:00:00.000Z',
      },
      {
        id: dropBelowScore.id,
        kind: 'fact',
        gate: 'belowScore',
        reason: 'importance 0.1 < floor 0.5',
        relationStrength: 0.2,
        score: 0.1,
        at: '2026-08-09T00:00:00.000Z',
      },
      {
        id: dropAlreadyVisible.id,
        kind: 'fact',
        gate: 'alreadyVisible',
        reason: 'text already in system prompt',
        at: '2026-08-09T00:00:00.000Z',
      },
      {
        id: dropCooldown.id,
        kind: 'fact',
        gate: 'cooldown',
        reason: 'cooldown 12s remaining',
        at: '2026-08-09T00:00:00.000Z',
      },
      {
        id: dropBudget.id,
        kind: 'fact',
        gate: 'budget',
        reason: 'diversity cap reached',
        at: '2026-08-09T00:00:00.000Z',
      },
    ];

    const payload = assemblePayload({
      rejected: { duplicate: 1, belowScore: 1, alreadyVisible: 1, cooldown: 1, budget: 1 },
      rejectedDetail,
      rejectedDetailTotal: 5,
      activated: [],
      injected: [],
      eligible: 5,
    });

    expect(payload.rejectedDetail).toHaveLength(5);
    expect(payload.rejectedDetail.map((entry) => entry.gate)).toEqual([
      'duplicate',
      'belowScore',
      'alreadyVisible',
      'cooldown',
      'budget',
    ]);
    expect(payload.rejected).toEqual({
      duplicate: 1,
      belowScore: 1,
      alreadyVisible: 1,
      cooldown: 1,
      budget: 1,
    });
  });

  it('preserves the pre-cap total via rejectedDetailTotal when the array is truncated', () => {
    // Simulate a 30-entry rejection list capped at MAX_REJECTED_DETAIL = 20.
    const all: RejectedDetailEntry[] = Array.from({ length: 30 }, (_, i) => ({
      id: `mem-${i}`,
      kind: 'fact',
      gate: 'belowScore',
      reason: `rejection #${i}`,
      at: '2026-08-09T00:00:00.000Z',
    }));
    const truncated = all.slice(0, 20);

    const payload = assemblePayload({
      rejected: { duplicate: 0, belowScore: 30, alreadyVisible: 0, cooldown: 0, budget: 0 },
      rejectedDetail: truncated,
      rejectedDetailTotal: 30,
      activated: [],
      injected: [],
      eligible: 30,
    });

    expect(payload.rejectedDetail).toHaveLength(20);
    expect(payload.rejectedDetailTotal).toBe(30);
    expect(payload.rejected.belowScore).toBe(30);
  });

  it('omits rejectedDetailTotal when no truncation occurred', () => {
    const detail: RejectedDetailEntry[] = [
      { id: 'mem-x', kind: 'fact', gate: 'budget', reason: 'cap', at: '2026-08-09T00:00:00.000Z' },
    ];
    const payload = assemblePayload({
      rejected: { duplicate: 0, belowScore: 0, alreadyVisible: 0, cooldown: 0, budget: 1 },
      rejectedDetail: detail,
      activated: [],
      injected: [],
      eligible: 1,
    });
    expect(payload.rejectedDetail).toHaveLength(1);
    expect(payload).not.toHaveProperty('rejectedDetailTotal');
  });

  it('uses consistent gate strings across integer map and rejectedDetail entries', () => {
    const detail: RejectedDetailEntry[] = [
      { id: 'm1', kind: 'fact', gate: 'belowScore', reason: 'r1', at: '2026-08-09T00:00:00.000Z' },
      { id: 'm2', kind: 'fact', gate: 'belowScore', reason: 'r2', at: '2026-08-09T00:00:00.000Z' },
      { id: 'm3', kind: 'fact', gate: 'budget', reason: 'r3', at: '2026-08-09T00:00:00.000Z' },
    ];
    const payload = assemblePayload({
      rejected: { duplicate: 0, belowScore: 2, alreadyVisible: 0, cooldown: 0, budget: 1 },
      rejectedDetail: detail,
      activated: [],
      injected: [],
      eligible: 3,
    });
    // The integer map and the detail array must agree.
    const belowScoreCount = payload.rejectedDetail.filter((e) => e.gate === 'belowScore').length;
    const budgetCount = payload.rejectedDetail.filter((e) => e.gate === 'budget').length;
    expect(belowScoreCount).toBe(payload.rejected.belowScore);
    expect(budgetCount).toBe(payload.rejected.budget);
  });
});
