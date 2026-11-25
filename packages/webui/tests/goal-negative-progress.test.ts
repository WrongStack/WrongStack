import { describe, expect, it } from 'vitest';
import { parseGoalState } from '../src/lib/goal';

describe('parseGoalState negative numeric bounds', () => {
  it('clamps negative iterations and progress to 0', () => {
    const neg = parseGoalState({ goal: 'ship', iterations: -5, progress: -20 });
    expect(neg?.iterations).toBe(0);
    expect(neg?.progress).toBe(0);
  });
});
