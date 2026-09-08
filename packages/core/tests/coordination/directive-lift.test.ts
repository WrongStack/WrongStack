import { describe, expect, it } from 'vitest';
import {
  DIRECTIVE_QUARANTINE_MAX_LIFT,
  shouldRetireDirective,
} from '../../src/coordination/agents/project-agent-directive-outcome.js';
import {
  directiveControl,
  directiveLift,
  directiveUtility,
  hasDirectiveLiftEvidence,
  isProvenDirective,
  type StructuredLearnedEntry,
} from '../../src/coordination/agents/project-agent-learning-structured.js';

const entry = (over: Partial<StructuredLearnedEntry> = {}): StructuredLearnedEntry => ({
  key: 'k',
  category: 'convention',
  what: 'Always run the storage slice from the repository root.',
  why: 'why',
  how: 'npx vitest run packages/core/tests/storage',
  capturedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('directiveControl', () => {
  it('reads a missing counter as zero, never NaN', () => {
    expect(directiveControl(entry())).toEqual({ skipped: 0, skippedWins: 0 });
    expect(directiveControl(entry({ skipped: -3, skippedWins: 2 }))).toEqual({
      skipped: 0,
      skippedWins: 0,
    });
  });

  it('cannot report more control wins than control trials', () => {
    expect(directiveControl(entry({ skipped: 2, skippedWins: 99 })).skippedWins).toBe(2);
  });
});

describe('directiveLift', () => {
  it('scores an entry with no evidence at exactly zero', () => {
    // Neutral, not a penalty: "no evidence" must never sort below "evidence of
    // harm" wherever this is used as a ranking key.
    expect(directiveLift(entry())).toBe(0);
  });

  it('is the number the raw success rate could not be', () => {
    // Both directives look excellent on the old metric because the baseline is
    // high — which is exactly the recorded situation: >90% task success made
    // every directive score near the ceiling and the ranking a constant.
    const helpful = entry({ applied: 20, wins: 20, skipped: 20, skippedWins: 14 });
    const inert = entry({ applied: 20, wins: 19, skipped: 20, skippedWins: 19 });

    expect(directiveUtility(helpful)).toBeGreaterThan(0.9);
    expect(directiveUtility(inert)).toBeGreaterThan(0.9);
    // Indistinguishable on utility; clearly separated on lift.
    expect(Math.abs(directiveUtility(helpful) - directiveUtility(inert))).toBeLessThan(0.05);
    expect(directiveLift(helpful)).toBeGreaterThan(0.2);
    expect(Math.abs(directiveLift(inert))).toBeLessThan(0.05);
  });

  it('goes negative when tasks go worse with the directive than without it', () => {
    expect(
      directiveLift(entry({ applied: 20, wins: 8, skipped: 20, skippedWins: 19 })),
    ).toBeLessThan(-0.4);
  });

  it('is bounded by its own smoothing when evidence is thin', () => {
    // One trial on each side is mostly prior, which is why the gates require
    // `hasDirectiveLiftEvidence` before acting on the number.
    const thin = entry({ applied: 1, wins: 1, skipped: 1, skippedWins: 0 });
    expect(directiveLift(thin)).toBeCloseTo(2 / 3 - 1 / 3, 5);
    expect(hasDirectiveLiftEvidence(thin)).toBe(false);
  });

  it('requires trials on BOTH arms before the number is trusted', () => {
    expect(hasDirectiveLiftEvidence(entry({ applied: 40, wins: 40 }))).toBe(false);
    expect(hasDirectiveLiftEvidence(entry({ skipped: 40, skippedWins: 40 }))).toBe(false);
    expect(
      hasDirectiveLiftEvidence(entry({ applied: 5, wins: 5, skipped: 5, skippedWins: 3 })),
    ).toBe(true);
  });
});

describe('shouldRetireDirective', () => {
  it('retires a directive that correlates with worse outcomes than its absence', () => {
    const harmful = entry({ applied: 20, wins: 6, skipped: 20, skippedWins: 18 });
    expect(directiveLift(harmful)).toBeLessThan(DIRECTIVE_QUARANTINE_MAX_LIFT);
    expect(shouldRetireDirective(harmful)).toBe(true);
  });

  it('keeps a directive that merely fails to help', () => {
    // Useless is not the same as harmful. Deleting on "no measurable benefit"
    // would retire most correct-but-rarely-decisive conventions.
    expect(
      shouldRetireDirective(entry({ applied: 20, wins: 18, skipped: 20, skippedWins: 18 })),
    ).toBe(false);
  });

  it('still retires on the absolute floor without any control evidence', () => {
    // The original rule survives for a directive followed by outright failure.
    expect(shouldRetireDirective(entry({ applied: 10, wins: 1 }))).toBe(true);
  });

  it('does not retire on a bad ratio before there are enough trials', () => {
    expect(shouldRetireDirective(entry({ applied: 3, wins: 0 }))).toBe(false);
  });

  it('leaves an untouched directive alone', () => {
    expect(shouldRetireDirective(entry())).toBe(false);
  });
});

describe('isProvenDirective', () => {
  it('protects a directive that beats its own baseline', () => {
    expect(isProvenDirective(entry({ applied: 20, wins: 20, skipped: 20, skippedWins: 12 }))).toBe(
      true,
    );
  });

  it('withdraws protection from one that is measurably worse than its absence', () => {
    // On the raw rate alone this cleared the bar — 0.86 utility, five-plus
    // trials — so "proven" protected a directive whose only track record was
    // that tasks tend to succeed anyway.
    const worse = entry({ applied: 20, wins: 17, skipped: 20, skippedWins: 20 });
    expect(directiveUtility(worse)).toBeGreaterThan(0.7);
    expect(isProvenDirective(worse)).toBe(false);
  });

  it('keeps the old behaviour for entries with no control evidence', () => {
    // Pre-existing buffers have no `skipped` counter; they must not lose
    // protection they already had just because the measurement improved.
    expect(isProvenDirective(entry({ applied: 20, wins: 20 }))).toBe(true);
  });

  it('still requires enough trials', () => {
    expect(isProvenDirective(entry({ applied: 2, wins: 2, skipped: 20, skippedWins: 2 }))).toBe(
      false,
    );
  });
});
