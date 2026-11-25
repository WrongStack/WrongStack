import { describe, expect, it } from 'vitest';
import { parseGoalState } from '../src/lib/goal.js';

describe('parseGoalState non-finite numbers and malformed deliverables (F1879)', () => {
  it('defaults non-finite iterations/progress to 0 and filters malformed deliverables', () => {
    const parsed = parseGoalState({
      goal: 'Ship v2',
      iterations: Number.NaN,
      progress: Number.POSITIVE_INFINITY,
      deliverables: [
        null,
        42,
        {},
        { id: 'd1', text: 'valid', status: 'done' },
        '[x] done item',
        'pending item',
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.iterations).toBe(0);
    expect(parsed?.progress).toBe(0);
    expect(parsed?.deliverables).toHaveLength(3);
    expect(parsed?.deliverables?.[0]).toEqual({ id: 'd1', text: 'valid', status: 'done' });
    expect(parsed?.deliverables?.[1]?.status).toBe('done');
    expect(parsed?.deliverables?.[2]?.status).toBe('pending');
  });
});
