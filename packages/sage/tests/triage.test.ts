/**
 * Tests for SAGE Memory Triage — Phase 1 (pre-filter) and Phase 2 (value score).
 *
 * Uses diverse seed memories to exercise every rule in both phases:
 * - Clearly KEEP: high-importance, permanent, used, decision/bug_root_cause
 * - Clearly DISCARD: empty text, transient, orphaned, stale+abandoned, expired
 * - UNCERTAIN edge cases: mid-importance, unanchored but injected, etc.
 * - Value scoring: anchor diversity, usage signals, freshness, quality, persistence
 */

import { describe, expect, it } from 'vitest';
import { preFilter, preFilterBatch } from '../src/triage/pre-filter.js';
import { computeValueScore } from '../src/triage/value-score.js';
import type { Sage } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Ages are derived from the real clock, not hardcoded.
 *
 * `computeValueScore` takes no injectable `now` — `computeFreshnessScore` calls
 * `daysSince()`, which reads `Date.now()` directly. Absolute dates therefore age
 * on their own and eventually drift across the FRESH_DAYS (30) / AGING_DAYS (90)
 * boundaries, turning these into time bombs: `RECENT` was written as "3 days
 * ago" on 2026-08-04 and started failing on 2026-09-01, the day it turned 31.
 * `MONTH_AGO` was 5 weeks from doing the same at the 90-day line.
 *
 * Offsets are placed mid-band rather than one day inside an edge, so a rounding
 * difference in `daysSince()` cannot flip a bucket.
 */
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const NOW = new Date().toISOString();
const RECENT = daysAgo(3); // well inside FRESH_DAYS (30)
const MONTH_AGO = daysAgo(45); // mid aging band (30 < age <= 90)
const THREE_MONTHS_AGO = daysAgo(120); // beyond AGING_DAYS (90)
const YEAR_AGO = daysAgo(365);

let idCounter = 0;

function makeMemory(overrides: Partial<Sage> & { id?: string } = {}): Sage {
  idCounter++;
  const id = overrides.id ?? `mem_test_${String(idCounter).padStart(3, '0')}`;
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    persistence: 'long_lived',
    text: 'This is a test memory with enough text to pass the minimum meaningful length check.',
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: ['test', 'triage'],
    anchors: [{ type: 'file', path: 'packages/sage/src/triage/pre-filter.ts' }],
    sources: [{ type: 'user' }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('injector rejection evidence', () => {
  it('reports the dominant gate count and applies the bounded below-score usage penalty', () => {
    const score = computeValueScore(makeMemory(), {
      injectorEvidence: {
        rejectedByGate: { belowScore: 5, budget: 2 },
        lastActivated: false,
        lastInjected: false,
        rejectionCount: 5,
      },
    });

    expect(score.rejectionGate).toBe('belowScore');
    expect(score.rejectionCount).toBe(5);
    expect(score.rejectionPressure).toBe(1);
    expect(score.usage).toBe(8);
  });

  it('does not invent a dominant gate when the lookback has no rejections', () => {
    const score = computeValueScore(makeMemory(), {
      injectorEvidence: {
        rejectedByGate: {},
        lastActivated: false,
        lastInjected: false,
      },
    });

    expect(score.rejectionPressure).toBe(0);
    expect(score.rejectionGate).toBeUndefined();
    expect(score.rejectionCount).toBeUndefined();
  });
});

// ── Phase 1: Pre-Filter ─────────────────────────────────────────────────

describe('Phase 1: deterministic pre-filter', () => {
  // ── KEEP rules ────────────────────────────────────────────────────

  describe('KEEP rules', () => {
    it('importance >= 0.9 → keep', () => {
      const m = makeMemory({ importance: 0.9 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('importance > 0.9 → keep', () => {
      const m = makeMemory({ importance: 1.0 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('persistence = permanent → keep', () => {
      const m = makeMemory({ persistence: 'permanent', importance: 0.3 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('useCount > 0 → keep', () => {
      const m = makeMemory({ useCount: 1, importance: 0.3 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('kind = decision → keep', () => {
      const m = makeMemory({ kind: 'decision', importance: 0.3 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('kind = bug_root_cause → keep', () => {
      const m = makeMemory({ kind: 'bug_root_cause', importance: 0.3 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('injected >= 10 AND used > 0 → keep', () => {
      const m = makeMemory({ injectionCount: 10, useCount: 1, importance: 0.3 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('injected >= 10 but useCount = 0 → NOT keep (no keep rule match)', () => {
      const m = makeMemory({ injectionCount: 10, useCount: 0, importance: 0.5 });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('kind = preference + importance >= 0.8 → keep', () => {
      const m = makeMemory({ kind: 'preference', importance: 0.8, anchors: [], injectionCount: 0 });
      expect(preFilter(m).verdict).toBe('keep');
    });

    it('kind = preference + importance 0.79 → uncertain (below threshold)', () => {
      const m = makeMemory({
        kind: 'preference',
        importance: 0.79,
        anchors: [],
        injectionCount: 0,
      });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('first matching keep reason wins', () => {
      const m = makeMemory({ importance: 1.0, persistence: 'permanent', useCount: 5 });
      const result = preFilter(m);
      expect(result.verdict).toBe('keep');
      expect(result.reasons[0]).toContain('importance');
    });
  });

  // ── DISCARD rules ─────────────────────────────────────────────────

  describe('DISCARD rules', () => {
    it('empty text → discard', () => {
      const m = makeMemory({ text: '', importance: 0.3 });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('text < 20 chars → discard', () => {
      const m = makeMemory({ text: 'too short', importance: 0.3 });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('transient "WIP:" prefix → discard', () => {
      const m = makeMemory({
        text: 'WIP: still working on the auth module refactor',
        importance: 0.3,
      });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('transient "TODO:" prefix → discard', () => {
      const m = makeMemory({ text: 'TODO: implement rate limiting', importance: 0.3 });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('transient "fix:" prefix → discard', () => {
      const m = makeMemory({ text: 'fix: the session leak in middleware', importance: 0.3 });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('orphaned noise → discard', () => {
      const m = makeMemory({
        anchors: [],
        tags: [],
        importance: 0.2,
        injectionCount: 0,
      });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('orphaned but importance >= 0.5 → uncertain (not discard)', () => {
      const m = makeMemory({
        anchors: [],
        tags: [],
        importance: 0.5,
        injectionCount: 0,
      });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('orphaned but has tags → uncertain (not discard)', () => {
      const m = makeMemory({
        anchors: [],
        tags: ['auth'],
        importance: 0.2,
        injectionCount: 0,
      });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('stale + unverified > 90d + importance < 0.6 → discard', () => {
      const m = makeMemory({
        status: 'stale',
        importance: 0.5,
        lastVerifiedAt: YEAR_AGO,
      });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('stale + unverified > 90d but importance >= 0.6 → uncertain', () => {
      const m = makeMemory({
        status: 'stale',
        importance: 0.6,
        lastVerifiedAt: YEAR_AGO,
      });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('stale but recently verified → uncertain (not discard)', () => {
      const m = makeMemory({
        status: 'stale',
        importance: 0.3,
        lastVerifiedAt: RECENT,
      });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('expired → discard', () => {
      const m = makeMemory({
        expiresAt: '2026-01-01T00:00:00.000Z',
        importance: 0.3,
      });
      expect(preFilter(m).verdict).toBe('discard');
    });

    it('multiple discard reasons compound', () => {
      const m = makeMemory({
        text: 'WIP: fix auth',
        anchors: [],
        tags: [],
        importance: 0.1,
        injectionCount: 0,
        status: 'stale',
        lastVerifiedAt: YEAR_AGO,
      });
      const result = preFilter(m);
      expect(result.verdict).toBe('discard');
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── UNCERTAIN ─────────────────────────────────────────────────────

  describe('UNCERTAIN (default)', () => {
    it('mid-importance, no keep triggers → uncertain', () => {
      const m = makeMemory({ importance: 0.6 });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('low importance but anchored and has tags → uncertain', () => {
      const m = makeMemory({
        importance: 0.3,
        anchors: [{ type: 'file', path: 'src/foo.ts' }],
        tags: ['architecture'],
      });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('high injection count but 0 use → uncertain', () => {
      const m = makeMemory({ injectionCount: 15, useCount: 0, importance: 0.6 });
      expect(preFilter(m).verdict).toBe('uncertain');
    });

    it('stale but high importance → uncertain (no keep trigger)', () => {
      const m = makeMemory({
        status: 'stale',
        importance: 0.7,
        lastVerifiedAt: YEAR_AGO,
      });
      expect(preFilter(m).verdict).toBe('uncertain');
    });
  });

  // ── Batch API ─────────────────────────────────────────────────────

  describe('preFilterBatch', () => {
    it('splits into keep/discard/uncertain', () => {
      const memories = [
        makeMemory({ id: 'k1', importance: 1.0 }),
        makeMemory({ id: 'k2', persistence: 'permanent', importance: 0.3 }),
        makeMemory({ id: 'd1', text: '', importance: 0.3 }),
        makeMemory({ id: 'd2', text: 'WIP: stuff', importance: 0.3 }),
        makeMemory({ id: 'u1', importance: 0.6 }),
        makeMemory({ id: 'u2', importance: 0.3, anchors: [{ type: 'file', path: 'x.ts' }] }),
      ];

      const { keep, discard, uncertain, results } = preFilterBatch(memories);

      expect(keep.map((m) => m.id)).toEqual(['k1', 'k2']);
      expect(discard.map((m) => m.id)).toEqual(['d1', 'd2']);
      expect(uncertain.map((m) => m.id)).toEqual(['u1', 'u2']);
      expect(results.size).toBe(6);
    });
  });
});

// ── Phase 2: Value Score ────────────────────────────────────────────────

describe('Phase 2: deterministic value score', () => {
  // ── Anchor sub-score ──────────────────────────────────────────────

  describe('anchor score (0-25)', () => {
    it('no anchors → 0', () => {
      const m = makeMemory({ anchors: [] });
      expect(computeValueScore(m).anchor).toBe(0);
    });

    it('one file anchor, active → 18 (15 + 3 for 1 type)', () => {
      const m = makeMemory({
        anchors: [{ type: 'file', path: 'src/foo.ts' }],
        status: 'active',
        lastVerifiedAt: RECENT,
      });
      expect(computeValueScore(m).anchor).toBe(18);
    });

    it('two anchor types → 21 (15 + 6 for 2 types)', () => {
      const m = makeMemory({
        anchors: [
          { type: 'file', path: 'src/foo.ts' },
          { type: 'symbol', symbol: 'doThing', path: 'src/foo.ts' },
        ],
        status: 'active',
        lastVerifiedAt: RECENT,
      });
      expect(computeValueScore(m).anchor).toBe(21);
    });

    it('three anchor types → 24 (15 + 9)', () => {
      const m = makeMemory({
        anchors: [
          { type: 'file', path: 'src/foo.ts' },
          { type: 'symbol', symbol: 'doThing', path: 'src/foo.ts' },
          { type: 'command', command: 'pnpm test' },
        ],
        status: 'active',
        lastVerifiedAt: RECENT,
      });
      expect(computeValueScore(m).anchor).toBe(24);
    });

    it('four+ anchor types → capped at 25', () => {
      const m = makeMemory({
        anchors: [
          { type: 'file', path: 'src/foo.ts' },
          { type: 'symbol', symbol: 'doThing', path: 'src/foo.ts' },
          { type: 'command', command: 'pnpm test' },
          { type: 'package', path: 'packages/sage' },
          { type: 'test', path: 'src/foo.test.ts' },
        ],
        status: 'active',
        lastVerifiedAt: RECENT,
      });
      expect(computeValueScore(m).anchor).toBe(25);
    });

    it('stale + not recently verified → 5', () => {
      const m = makeMemory({
        status: 'stale',
        anchors: [{ type: 'file', path: 'src/old.ts' }],
        lastVerifiedAt: MONTH_AGO,
      });
      expect(computeValueScore(m).anchor).toBe(5);
    });
  });

  // ── Usage sub-score ───────────────────────────────────────────────

  describe('usage score (0-25)', () => {
    it('used 1x → 21', () => {
      const m = makeMemory({ useCount: 1, injectionCount: 5 });
      expect(computeValueScore(m).usage).toBe(21);
    });

    it('used 3x → 23', () => {
      const m = makeMemory({ useCount: 3, injectionCount: 10 });
      expect(computeValueScore(m).usage).toBe(23);
    });

    it('used 5x → 25 (capped)', () => {
      const m = makeMemory({ useCount: 10, injectionCount: 20 });
      expect(computeValueScore(m).usage).toBe(25);
    });

    it('injected >= 5, never used → 3', () => {
      const m = makeMemory({ injectionCount: 5, useCount: 0 });
      expect(computeValueScore(m).usage).toBe(3);
    });

    it('injected 1-4, never used → 8', () => {
      const m = makeMemory({ injectionCount: 2, useCount: 0 });
      expect(computeValueScore(m).usage).toBe(8);
    });

    it('never injected, never used → 10', () => {
      const m = makeMemory({ injectionCount: 0, useCount: 0 });
      expect(computeValueScore(m).usage).toBe(10);
    });

    it('undefined counts → neutral 10', () => {
      const m = makeMemory({});
      // injectionCount and useCount default to undefined via makeMemory
      // (they're not set in the spread unless overridden)
      expect(computeValueScore(m).usage).toBe(10);
    });
  });

  // ── Freshness sub-score ───────────────────────────────────────────

  describe('freshness score (0-20)', () => {
    it('verified <= 30 days → 20', () => {
      const m = makeMemory({ lastVerifiedAt: RECENT });
      expect(computeValueScore(m).freshness).toBe(20);
    });

    it('verified 30-90 days → 12', () => {
      const m = makeMemory({ lastVerifiedAt: MONTH_AGO });
      expect(computeValueScore(m).freshness).toBe(12);
    });

    it('verified > 90 days → 5', () => {
      const m = makeMemory({ lastVerifiedAt: YEAR_AGO });
      expect(computeValueScore(m).freshness).toBe(5);
    });

    it('never verified → 5', () => {
      const m = makeMemory({ lastVerifiedAt: undefined });
      expect(computeValueScore(m).freshness).toBe(5);
    });
  });

  // ── Quality sub-score ─────────────────────────────────────────────

  describe('quality score (0-15)', () => {
    it('durable kind + 3 tags + sweet-spot text → 15', () => {
      const m = makeMemory({
        kind: 'convention',
        tags: ['auth', 'middleware', 'session'],
        text: 'A'.repeat(120),
      });
      expect(computeValueScore(m).quality).toBe(15);
    });

    it('fact with 1 tag and sweet-spot text → 13 (5 + 3 + 5)', () => {
      const m = makeMemory({
        kind: 'fact',
        tags: ['auth'],
        text: 'A'.repeat(100),
      });
      expect(computeValueScore(m).quality).toBe(13);
    });

    it('summary kind → 0 for kind + tag/text still count', () => {
      const m = makeMemory({
        kind: 'summary',
        tags: ['test'],
      });
      // 0 (transient kind) + 3 (1 tag) + text (depends on length)
      const textLen = m.text.length;
      const textPoints = textLen >= 80 && textLen <= 500 ? 5 : 2;
      expect(computeValueScore(m).quality).toBe(3 + textPoints);
    });

    it('memory_review kind → same as summary', () => {
      const m = makeMemory({ kind: 'memory_review', tags: ['test'] });
      const textLen = m.text.length;
      const textPoints = textLen >= 80 && textLen <= 500 ? 5 : 2;
      expect(computeValueScore(m).quality).toBe(3 + textPoints);
    });

    it('no tags → quality reflects 0 tag points', () => {
      const m = makeMemory({ tags: [], kind: 'fact' });
      // 5 (durable kind) + 0 (no tags) + text
      const textLen = m.text.length;
      const textPoints = textLen >= 80 && textLen <= 500 ? 5 : 2;
      expect(computeValueScore(m).quality).toBe(5 + textPoints);
    });

    it('text outside sweet spot → 2 text points', () => {
      const m = makeMemory({
        kind: 'fact',
        tags: ['x'],
        text: 'short',
      });
      // 5 + 3 + 2 = 10
      expect(computeValueScore(m).quality).toBe(10);
    });
  });

  // ── Persistence sub-score ─────────────────────────────────────────

  describe('persistence score (0-15)', () => {
    it('permanent → 15', () => {
      const m = makeMemory({ persistence: 'permanent' });
      expect(computeValueScore(m).persistence).toBe(15);
    });

    it('long_lived → 10', () => {
      const m = makeMemory({ persistence: 'long_lived' });
      expect(computeValueScore(m).persistence).toBe(10);
    });

    it('short_lived → 3', () => {
      const m = makeMemory({ persistence: 'short_lived' });
      expect(computeValueScore(m).persistence).toBe(3);
    });

    it('undefined persistence → 10 (long_lived default)', () => {
      const m = makeMemory({});
      expect(computeValueScore(m).persistence).toBe(10);
    });
  });

  // ── Band mapping ──────────────────────────────────────────────────

  describe('band mapping', () => {
    it('score 70 → keep', () => {
      // Build a memory that scores exactly 70
      // anchor: 18 (1 file anchor) + usage: 21 (1 use) + freshness: 20 (recent) + quality: 11 (mid) + persistence: 10 = 80 — too high
      // Let's use a typical mid memory
      const m = makeMemory({
        importance: 0.6,
        kind: 'fact',
        tags: ['test'],
        injectionCount: 0,
        useCount: 0,
        lastVerifiedAt: RECENT,
        anchors: [{ type: 'file', path: 'x.ts' }],
      });
      // anchor:18 + usage:10 + freshness:20 + quality: expected 5+3+? (text length dependent)
      const score = computeValueScore(m);
      // This should be well above 30
      expect(score.band).toBe('keep');
      expect(score.total).toBeGreaterThanOrEqual(70);
    });

    it('score 29 → discard', () => {
      const m = makeMemory({
        anchors: [],
        kind: 'summary',
        tags: [],
        injectionCount: 0,
        useCount: 0,
        lastVerifiedAt: YEAR_AGO,
        persistence: 'short_lived',
        text: 'short',
        importance: 0.2,
      });
      // anchor:0 + usage:10 + freshness:5 + quality: ~0+0+2=2 + persistence:3 = 20
      const score = computeValueScore(m);
      expect(score.band).toBe('discard');
      expect(score.total).toBeLessThanOrEqual(29);
    });

    it('score 45 → gray', () => {
      const m = makeMemory({
        anchors: [{ type: 'file', path: 'x.ts' }],
        kind: 'fact',
        tags: ['test'],
        injectionCount: 0,
        useCount: 0,
        lastVerifiedAt: THREE_MONTHS_AGO,
        persistence: 'long_lived',
        importance: 0.5,
      });
      // anchor:18 + usage:10 + freshness:5 + quality: text-dependent + persistence:10
      const score = computeValueScore(m);
      expect(score.total).toBeGreaterThanOrEqual(30);
      expect(score.total).toBeLessThan(70);
      expect(score.band).toBe('gray');
    });
  });

  // ── Breakdown completeness ────────────────────────────────────────

  describe('breakdown structure', () => {
    it('includes all sub-scores and maxes', () => {
      const m = makeMemory({});
      const score = computeValueScore(m);

      expect(score).toHaveProperty('total');
      expect(score).toHaveProperty('band');
      expect(score).toHaveProperty('anchor');
      expect(score).toHaveProperty('usage');
      expect(score).toHaveProperty('freshness');
      expect(score).toHaveProperty('quality');
      expect(score).toHaveProperty('persistence');
      expect(score).toHaveProperty('maxes');
      expect(score).toHaveProperty('reasons');

      // Maxes match constants
      expect(score.maxes.anchor).toBe(25);
      expect(score.maxes.usage).toBe(25);
      expect(score.maxes.freshness).toBe(20);
      expect(score.maxes.quality).toBe(15);
      expect(score.maxes.persistence).toBe(15);

      // Total is sum of sub-scores
      expect(score.total).toBe(
        score.anchor + score.usage + score.freshness + score.quality + score.persistence,
      );
    });

    it('reasons array is non-empty for a normal memory', () => {
      const m = makeMemory({});
      const score = computeValueScore(m);
      expect(score.reasons.length).toBeGreaterThanOrEqual(4); // one per sub-score
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('max score achievable memory', () => {
      const m = makeMemory({
        kind: 'decision',
        persistence: 'permanent',
        importance: 1.0,
        confidence: 1.0,
        tags: ['auth', 'security', 'critical'],
        anchors: [
          { type: 'file', path: 'src/auth.ts' },
          { type: 'symbol', symbol: 'verifySession', path: 'src/auth.ts' },
          { type: 'command', command: 'pnpm test auth' },
          { type: 'test', path: 'tests/auth.test.ts' },
        ],
        useCount: 10,
        injectionCount: 50,
        lastVerifiedAt: RECENT,
        text: 'A'.repeat(200),
      });
      const score = computeValueScore(m);
      // anchor: 25, usage: 25, freshness: 20, quality: 15, persistence: 15 = 100
      expect(score.total).toBe(100);
      expect(score.band).toBe('keep');
    });

    it('min score achievable memory', () => {
      const m = makeMemory({
        anchors: [],
        kind: 'summary',
        tags: [],
        injectionCount: 100, // many injections, never used → 3
        useCount: 0,
        lastVerifiedAt: undefined,
        persistence: 'short_lived',
        text: 'tiny',
        importance: 0.1,
      });
      const score = computeValueScore(m);
      // anchor: 0, usage: 3, freshness: 5, quality: 0+0+2=2, persistence: 3 = 13
      expect(score.total).toBe(13);
      expect(score.band).toBe('discard');
    });
  });
});
