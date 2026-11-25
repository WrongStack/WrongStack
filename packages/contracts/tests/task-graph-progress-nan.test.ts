import { describe, expect, it } from 'vitest';
import { completionPercent, computeTaskProgress, type TaskGraph } from '../src/types/task-graph.js';

describe('task-graph progress numeric guards', () => {
  it('clamps negative/non-finite completionPercent inputs and ignores non-finite task hours', () => {
    expect(completionPercent(1, 2)).toBe(50);
    expect(completionPercent(-5, 10)).toBe(0);
    expect(completionPercent(Number.NaN, 10)).toBe(0);
    expect(completionPercent(5, Number.NaN)).toBe(0);

    const graph: TaskGraph = {
      id: 'g1',
      specId: 's1',
      title: 'T',
      nodes: new Map([
        [
          'n1',
          {
            id: 'n1',
            title: 'A',
            description: '',
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            estimateHours: 2,
            actualHours: 1,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        [
          'n2',
          {
            id: 'n2',
            title: 'B',
            description: '',
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            estimateHours: Number.NaN,
            actualHours: Number.POSITIVE_INFINITY,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      ]),
      edges: [],
      rootNodes: [],
      createdAt: 0,
      updatedAt: 0,
    };

    const progress = computeTaskProgress(graph);
    expect(progress.estimatedHours).toBe(2);
    expect(progress.actualHours).toBe(1);
  });
});
