import { describe, expect, it } from 'vitest';
import { computeTaskItemProgress, type TaskItem } from '../src/utils/task-format.js';

describe('computeTaskItemProgress non-finite estimateHours guard', () => {
  it('ignores NaN, negative, and Infinity estimateHours', () => {
    const base: TaskItem = {
      id: '1',
      title: 'A',
      type: 'feature',
      priority: 'medium',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const progress = computeTaskItemProgress([
      { ...base, estimateHours: 2 },
      { ...base, id: '2', estimateHours: Number.NaN },
      { ...base, id: '3', estimateHours: -10 },
      { ...base, id: '4', estimateHours: Number.POSITIVE_INFINITY },
    ]);
    expect(progress.estimatedHours).toBe(2);
  });
});
