/**
 * The legend under `renderTaskGraph` must explain the glyphs the nodes are
 * actually drawn with. It listed `⊗ blocked` and `◒ review` while blocked and
 * review nodes render as `⊘` and `◑`.
 */
import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { renderTaskGraph } from '../src/task-visualizer.js';

const STATUSES: Array<[TaskNode['status'], string]> = [
  ['completed', 'done'],
  ['in_progress', 'in-progress'],
  ['pending', 'pending'],
  ['blocked', 'blocked'],
  ['failed', 'failed'],
  ['review', 'review'],
];

function graphWithEveryStatus(): TaskGraph {
  const nodes = STATUSES.map(
    ([status]): TaskNode => ({
      id: status,
      title: `task-${status}`,
      description: '',
      type: 'feature',
      priority: 'medium',
      status,
      createdAt: 0,
      updatedAt: 0,
    }),
  );
  return {
    id: 'g',
    specId: 'spec-0001',
    title: 'Legend',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [],
    rootNodes: nodes.map((n) => n.id),
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('renderTaskGraph legend', () => {
  it('names the same glyph every status is drawn with', () => {
    const lines = renderTaskGraph(graphWithEveryStatus(), { compact: true }).split('\n');
    const legend = lines.find((line) => line.startsWith('Legend:'));
    expect(legend).toBeDefined();
    for (const [status, label] of STATUSES) {
      const drawn = lines.find((line) => line.includes(`task-${status}`))?.trim()[0];
      expect(drawn, status).toBeDefined();
      expect(legend, status).toContain(`${drawn} ${label}`);
    }
  });
});
