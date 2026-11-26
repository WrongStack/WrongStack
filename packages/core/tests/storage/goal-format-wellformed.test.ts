import { describe, expect, it } from 'vitest';
import type { GoalFile } from '../../src/storage/goal-store.js';
import { formatGoal } from '../../src/storage/goal-store.js';

const ROCKET = '\u{1F680}';

function goal(text: string): GoalFile {
  return {
    goal: text,
    refinedGoal: 'refined goal',
    goalState: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    journal: [],
    checkpoint: {},
    iterations: 0,
  } as unknown as GoalFile;
}

/**
 * F2647: the `/goal` status block renders the original goal as a 60-unit
 * snippet with a plain `.slice`. Goals are user text; a split astral character
 * leaves a lone surrogate in the rendered block.
 */
describe('goal status block keeps valid UTF-16 (F2647)', () => {
  it('drops the orphaned half in the original-goal snippet', () => {
    const out = formatGoal(goal(`${'g'.repeat(59)}${ROCKET}tail`));

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('g'.repeat(59));
  });

  it('keeps a short goal unchanged (control)', () => {
    const out = formatGoal(goal('plain goal'));

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('plain goal');
  });
});
