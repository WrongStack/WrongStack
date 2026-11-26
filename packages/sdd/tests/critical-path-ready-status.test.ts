import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { expect, it } from 'vitest';
import { analyzeCriticalPath } from '../src/critical-path.js';

function makeGraph(status: TaskNode['status']): TaskGraph {
  const entries: Array<[string, TaskNode['status']]> = [
    ['target', status],
    ['done', 'completed'],
    ['next', 'pending'],
    ['waiting', 'pending'],
  ];
  const nodes: TaskNode[] = entries.map(([id, nodeStatus]) => ({
    id,
    title: id,
    description: '',
    type: 'feature',
    priority: 'medium',
    status: nodeStatus,
    createdAt: 0,
    updatedAt: 0,
  }));
  return {
    id: 'ready-status',
    specId: 'spec',
    title: 'Ready status',
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edges: [
      { id: 'done-next', from: 'done', to: 'next', type: 'depends_on' },
      { id: 'next-waiting', from: 'next', to: 'waiting', type: 'depends_on' },
    ],
    rootNodes: ['target', 'done'],
    createdAt: 0,
    updatedAt: 0,
  };
}

it.each(['in_progress', 'review', 'failed', 'blocked'] as const)(
  'does not list a %s task as ready to start',
  (status) => {
    const analysis = analyzeCriticalPath(makeGraph(status));
    expect(analysis.readyTasks).toEqual(['next']);
    expect(analysis.blockedTasks).toEqual(['waiting']);
  },
);

it('lists pending tasks with no blockers or with completed prerequisites', () => {
  const analysis = analyzeCriticalPath(makeGraph('pending'));
  expect(analysis.readyTasks).toEqual(['target', 'next']);
  expect(analysis.blockedTasks).toEqual(['waiting']);
});
