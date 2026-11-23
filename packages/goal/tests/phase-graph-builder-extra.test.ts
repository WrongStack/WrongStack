import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';

function node(
  id: string,
  title: string,
  priority: TaskNode['priority'] = 'medium',
  estimateHours?: number,
): TaskNode {
  return {
    id,
    title,
    description: `desc ${title}`,
    type: 'feature',
    priority,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...(estimateHours !== undefined ? { estimateHours } : {}),
  } as TaskNode;
}

function taskGraphOf(nodes: TaskNode[]): TaskGraph {
  return {
    id: 'g',
    specId: 's',
    title: 'TG',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [],
    rootNodes: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('PhaseGraphBuilder.fromTaskGraph', () => {
  it('groups tasks into phases (tasksPerPhase) and flags critical groups', async () => {
    const nodes = [
      node('n1', 'Critical work', 'critical', 3),
      node('n2', 'High work', 'high'),
      node('n3', 'Medium A'),
      node('n4', 'Medium B'),
      node('n5', 'Low work', 'low'),
      node('n6', 'Extra one'),
      node('n7', 'Extra two'),
    ];
    const graph = await PhaseGraphBuilder.fromTaskGraph(taskGraphOf(nodes), {
      title: 'My Plan',
      tasksPerPhase: 5,
    });
    const phases = Array.from(graph.phases.values());
    expect(phases).toHaveLength(2); // 7 tasks / 5 per phase → 2 groups
    // First group contains the critical task (sorted first) → critical priority
    expect(phases[0]!.priority).toBe('critical');
    // estimateHours sums group task hours (critical=3, rest default 2 → 3 + 2*4 = 11)
    expect(phases[0]!.estimateHours).toBe(11);
    // Second group has no critical → high
    expect(phases[1]!.priority).toBe('high');
    expect(graph.title).toBe('My Plan');
  });

  it('defaults tasksPerPhase to 5 when omitted', async () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(`n${i}`, `Task ${i}`));
    const graph = await PhaseGraphBuilder.fromTaskGraph(taskGraphOf(nodes), { title: 'Default' });
    expect(Array.from(graph.phases.values())).toHaveLength(2); // 6 / 5 → 2 groups
  });

  it('orders only by depends_on/blocks edges, never by relates_to or implements (F1437)', async () => {
    const source = taskGraphOf([
      node('low', 'Low', 'low'),
      node('crit', 'Crit', 'critical'),
      node('a', 'A', 'medium'),
      node('b', 'B', 'medium'),
    ]);
    source.edges = [
      { id: 'e1', from: 'low', to: 'crit', type: 'relates_to' },
      { id: 'e2', from: 'a', to: 'b', type: 'implements' },
      { id: 'e3', from: 'b', to: 'a', type: 'relates_to' },
    ];
    const graph = await PhaseGraphBuilder.fromTaskGraph(source, { title: 'Links' });
    const phase = Array.from(graph.phases.values())[0]!;
    // A "related" link is not a prerequisite: no blocker is invented and the
    // critical task keeps its place at the front.
    expect(phase.taskGraph.edges.filter((edge) => edge.type === 'depends_on')).toEqual([]);
    expect(Array.from(phase.taskGraph.nodes.values())[0]?.title).toBe('Crit');

    // A real ordering edge is still honoured.
    source.edges = [{ id: 'e4', from: 'low', to: 'crit', type: 'blocks' }];
    const ordered = Array.from(
      (await PhaseGraphBuilder.fromTaskGraph(source, { title: 'Blocks' })).phases.values(),
    )[0]!;
    const titleOf = (id: string) => ordered.taskGraph.nodes.get(id)?.title;
    expect(
      ordered.taskGraph.edges.map((edge) => `${titleOf(edge.from)}->${titleOf(edge.to)}`),
    ).toEqual(['Low->Crit']);
  });
});
