import { describe, expect, it } from 'vitest';
import { canTransitionGoalRun, type GoalRunState } from '../src/goal-run-state.js';

describe('canTransitionGoalRun (F2208)', () => {
  it('rejects self-transitions on unknown/corrupted states while allowing valid ones', () => {
    expect(
      canTransitionGoalRun(
        'corrupted_state' as unknown as GoalRunState,
        'corrupted_state' as unknown as GoalRunState,
      ),
    ).toBe(false);
    expect(canTransitionGoalRun('running', 'running')).toBe(true);
  });
});
