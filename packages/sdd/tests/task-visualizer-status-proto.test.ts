import type { TaskGraph } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { renderTaskList } from '../src/task-visualizer.js';

describe('renderTaskList prototype status guard (F1997)', () => {
  it('ignores unknown or prototype status keys without throwing', () => {
    const graph = {
      id: 'g2',
      specId: 's1',
      title: 'Graph',
      nodes: new Map([
        [
          't1',
          {
            id: 't1',
            title: 'Task 1',
            description: '',
            type: 'feature',
            priority: 'medium',
            status: 'toString',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        [
          't2',
          {
            id: 't2',
            title: 'Task 2',
            description: '',
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      ]),
      edges: [],
      rootNodes: ['t1', 't2'],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as TaskGraph;
    expect(renderTaskList(graph)).toContain('Task 2');
  });
});
