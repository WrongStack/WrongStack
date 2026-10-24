import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../phase-graph-builder.js';

function task(id: string): TaskNode {
  return {
    id,
    title: id,
    description: id,
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
}

function graph(edges: Array<Pick<TaskGraph['edges'][number], 'from' | 'to'>>): TaskGraph {
  return {
    id: 'dag',
    specId: 'spec',
    title: 'Dependencies',
    nodes: new Map(['A', 'B', 'C'].map((id) => [id, task(id)])),
    edges: edges.map((edge, index) => ({ ...edge, id: `edge-${index}`, type: 'depends_on' })),
    rootNodes: ['A', 'B'],
    createdAt: 0,
    updatedAt: 0,
  };
}

async function groupedTasks(
  edges: Array<Pick<TaskGraph['edges'][number], 'from' | 'to'>>,
): Promise<string[][]> {
  const result = await PhaseGraphBuilder.fromTaskGraph(graph(edges), {
    title: 'Dependencies',
    tasksPerPhase: 2,
  });
  return Array.from(result.phases.values(), (phase) =>
    Array.from(phase.taskGraph.nodes.values(), (node) => node.title),
  );
}

describe('PhaseGraphBuilder.fromTaskGraph dependency order', () => {
  it('never places a shared dependent before either prerequisite', async () => {
    const grouped = await groupedTasks([
      { from: 'A', to: 'C' },
      { from: 'B', to: 'C' },
    ]);
    const index = (id: string) => grouped.findIndex((group) => group.includes(id));
    expect(index('C')).toBeGreaterThanOrEqual(index('A'));
    expect(index('C')).toBeGreaterThanOrEqual(index('B'));
    expect(grouped.flat().sort()).toEqual(['A', 'B', 'C']);
  });

  it('still groups a dependent with its only prerequisite when there is room', async () => {
    const grouped = await groupedTasks([{ from: 'A', to: 'C' }]);
    expect(grouped[0]).toEqual(['A', 'C']);
    expect(grouped.flat().sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps a task whose only incoming edge comes from a task that no longer exists', async () => {
    // The dangling edge raised B's in-degree with nothing able to lower it, so
    // B never left the topological queue and vanished from the plan.
    const grouped = await groupedTasks([{ from: 'deleted-task', to: 'B' }]);
    expect(grouped.flat().sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps the members of a dependency cycle instead of dropping them', async () => {
    const grouped = await groupedTasks([
      { from: 'B', to: 'C' },
      { from: 'C', to: 'B' },
    ]);
    expect(grouped.flat().sort()).toEqual(['A', 'B', 'C']);
  });
});
