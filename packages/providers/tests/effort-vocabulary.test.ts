import { REASONING_EFFORT_LEVELS } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { GENERIC_EFFORT_FALLBACK, OPENAI_EFFORT_ACCEPT } from '../src/openai-shared.js';

/**
 * Drift guards for the exhaustive effort vocabulary tables (report item C1).
 *
 * A2/A3 diverged because effort vocabularies were hand-listed Sets and switch
 * statements whose `.has()` / `default:` branches silently swallowed any level
 * they didn't enumerate. The tables are now `Record<ReasoningEffort, …>` — a
 * NEW core level fails the build until classified — and these tests pin the
 * coupling between the tables at runtime, so a value can never again fall
 * through every allowlist at once.
 */
describe('effort vocabulary tables (C1 drift guard)', () => {
  it('accept table classifies every canonical level', () => {
    for (const level of REASONING_EFFORT_LEVELS) {
      expect(typeof OPENAI_EFFORT_ACCEPT[level]).toBe('boolean');
    }
  });

  it('fallback is defined exactly where acceptance is false (no gaps, no overlap)', () => {
    // The coupling invariant: a level the base builder accepts needs NO
    // fallback (and must not get one — that would double-write), and a level
    // it drops MUST have one — a silent drop was the A3 failure mode.
    for (const level of REASONING_EFFORT_LEVELS) {
      const accepted = OPENAI_EFFORT_ACCEPT[level];
      const fallback = GENERIC_EFFORT_FALLBACK[level];
      expect(fallback === undefined).toBe(accepted === true);
    }
  });

  it('every fallback lands inside the accepted set', () => {
    // A fallback that itself gets dropped would reintroduce the A3 inversion.
    for (const level of REASONING_EFFORT_LEVELS) {
      const fallback = GENERIC_EFFORT_FALLBACK[level];
      if (fallback === undefined) continue;
      expect(OPENAI_EFFORT_ACCEPT[fallback]).toBe(true);
    }
  });

  it('documented accept/drop split holds (Chat Completions vocabulary)', () => {
    expect({ ...OPENAI_EFFORT_ACCEPT }).toEqual({
      none: true,
      minimal: false,
      low: true,
      medium: true,
      high: true,
      xhigh: false,
      max: false,
    });
  });

  it('documented fallback mapping holds', () => {
    expect({ ...GENERIC_EFFORT_FALLBACK }).toEqual({
      none: undefined,
      minimal: 'low',
      low: undefined,
      medium: undefined,
      high: undefined,
      xhigh: 'high',
      max: 'high',
    });
  });
});
