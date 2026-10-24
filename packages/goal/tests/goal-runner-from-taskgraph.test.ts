/**
 * Regression: createGoalRunnerFromTaskGraph grouped the TaskGraph into phases
 * with task templates, then handed GoalRunner phase templates WITHOUT
 * `taskTemplates`. start() rebuilds the graph from those templates, so every
 * phase had zero tasks, the first phase failed with "Phase has no executable
 * tasks", and none of the TaskGraph's tasks ever ran.
 */

import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { describe, expect, it } from 'vitest';
import { createGoalRunnerFromTaskGraph } from '../src/goal-runner.js';

function node(id: string, title: string): TaskNode {
  return {
    id,
    title,
    description: `${title} details`,
    type: 'implementation',
    priority: 'high',
    status: 'pending',
    estimateHours: 1,
    tags: ['auth'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskNode;
}

function taskGraph(): TaskGraph {
  return {
    id: 'tg',
    specId: 'spec',
    title: 'Auth refactor',
    nodes: new Map([
      ['a', node('a', 'Write schema')],
      ['b', node('b', 'Add migration')],
      ['c', node('c', 'Wire endpoint')],
    ]),
    edges: [
      { from: 'a', to: 'b', type: 'blocks' },
      { from: 'b', to: 'c', type: 'blocks' },
    ],
    rootNodes: ['a'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskGraph;
}

describe('createGoalRunnerFromTaskGraph runs the task graph', () => {
  it.each([1, 2, 5])('executes every task with tasksPerPhase=%i', async (tasksPerPhase) => {
    const executed: string[] = [];
    const runner = await createGoalRunnerFromTaskGraph(taskGraph(), {
      tasksPerPhase,
      executeTask: async (task: TaskNode) => {
        executed.push(task.title);
      },
      maxRunDurationMs: 0,
    });

    const graph = await runner.start();

    expect(executed).toEqual(['Write schema', 'Add migration', 'Wire endpoint']);
    expect(graph.failedPhaseIds).toEqual([]);
    expect([...graph.phases.values()].every((phase) => phase.status === 'completed')).toBe(true);
  });

  it('keeps the task fields on the rebuilt phases', async () => {
    const runner = await createGoalRunnerFromTaskGraph(taskGraph(), {
      tasksPerPhase: 5,
      executeTask: async () => {},
      maxRunDurationMs: 0,
    });

    const graph = await runner.start();
    const [first] = [...[...graph.phases.values()][0]!.taskGraph.nodes.values()];

    expect(first).toMatchObject({
      title: 'Write schema',
      description: 'Write schema details',
      type: 'implementation',
      priority: 'high',
      estimateHours: 1,
      tags: ['auth'],
    });
  });
});
