import { describe, expect, it } from 'vitest';
import { buildDirective } from '../../src/execution/eternal-autonomy-directives.js';

const ROCKET = '\u{1F680}';

const goal = (note: string | undefined) =>
  ({
    goal: 'ship it',
    iterations: 0,
    journal: [{ iteration: 1, status: 'success', task: 'build', ...(note ? { note } : {}) }],
  }) as never;

/**
 * F2653: `buildDirective` caps each recent-journal note at 80 UTF-16 units with
 * a plain `.slice`. The directive is the autonomous loop's prompt, so a split
 * astral character reaches the provider wire.
 */
describe('eternal directive journal notes keep valid UTF-16 (F2653)', () => {
  it('drops the orphaned half in a journal note', () => {
    const out = buildDirective(
      {} as never,
      goal(`${'n'.repeat(79)}${ROCKET}tail`),
      'manual',
      'task',
    );

    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain('n'.repeat(79));
  });

  it('keeps a short note unchanged (control)', () => {
    const out = buildDirective({} as never, goal('plain note'), 'manual', 'task');

    expect(out).toContain('plain note');
  });
});
