/**
 * Tests for SAGE value-score injection-evidence input.
 *
 * The A4 plan extends `computeValueScore` with an optional
 * `injectorEvidence` argument so triage can fold SAGE injector gate data
 * into a memory's value score:
 *
 *   - `rejectionPressure` (0..1) appears in the breakdown only when
 *     evidence is supplied.
 *   - `rejectionGate` is the dominant gate from the rolling window.
 *   - `usage` sub-score subtracts 2 (clamped at 0) when belowScore
 *     rejections cross the threshold (5 by default).
 *   - `clampFloor` is 0 so the penalty remains effective for every usage branch.
 *
 * These tests assert all four contracts.
 */

import { describe, expect, it } from 'vitest';
import { computeValueScore, type InjectorEvidence } from '../../src/triage/value-score.js';
import type { Sage } from '../../src/types.js';

function makeMemory(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'mem_test_value_score',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text: 'A test memory with enough text to be meaningful and exercise value-score reasoning.',
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

function makeEvidence(partial: Partial<InjectorEvidence> = {}): InjectorEvidence {
  return {
    rejectedByGate: {},
    lastActivated: false,
    lastInjected: false,
    ...partial,
  };
}

describe('computeValueScore — injectorEvidence (A4)', () => {
  it('returns rejectionPressure undefined when no evidence is supplied', () => {
    const breakdown = computeValueScore(makeMemory());
    expect(breakdown.rejectionPressure).toBeUndefined();
    expect(breakdown.rejectionGate).toBeUndefined();
  });

  it('reports rejectionGate as belowScore when belowScore dominates the gate map', () => {
    const breakdown = computeValueScore(makeMemory(), {
      injectorEvidence: makeEvidence({ rejectedByGate: { belowScore: 5, cooldown: 1 } }),
    });
    expect(breakdown.rejectionPressure).toBeDefined();
    expect(breakdown.rejectionGate).toBe('belowScore');
  });

  it('subtracts 2 from the usage sub-score when belowScore >= 5', () => {
    const baseline = computeValueScore(
      makeMemory({ confidence: 0.8, injectionCount: 0, useCount: 0 }),
    );
    const penalized = computeValueScore(
      makeMemory({ confidence: 0.8, injectionCount: 0, useCount: 0 }),
      { injectorEvidence: makeEvidence({ rejectedByGate: { belowScore: 8 } }) },
    );
    expect(penalized.usage).toBe(Math.max(0, baseline.usage - 2));
  });

  it('allows the suspicious usage branch to fall below its unpenalized score of 3', () => {
    const penalized = computeValueScore(
      makeMemory({ confidence: 0.1, injectionCount: 5, useCount: 0 }),
      { injectorEvidence: makeEvidence({ rejectedByGate: { belowScore: 8 } }) },
    );
    expect(penalized.usage).toBe(1);
  });

  it('dominant gate is undefined when there are zero rejections', () => {
    const breakdown = computeValueScore(makeMemory(), {
      injectorEvidence: makeEvidence({ rejectedByGate: {} }),
    });
    expect(breakdown.rejectionGate).toBeUndefined();
  });
});
