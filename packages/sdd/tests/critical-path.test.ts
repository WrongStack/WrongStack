import type { TaskGraph, TaskNode } from '@wrongstack/core/types/task-graph.js';
import { describe, expect, it } from 'vitest';
import { analyzeCriticalPath } from '../src/critical-path.js';

function makeNode(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    estimateHours: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeGraph(opts: {
  nodes: TaskNode[];
  edges?: Array<{ from: string; to: string }>;
}): TaskGraph {
  const nodes = new Map(opts.nodes.map((n) => [n.id, n]));
  const edges = (opts.edges ?? []).map((e) => ({
    id: `${e.from}-${e.to}`,
    from: e.from,
    to: e.to,
    type: 'depends_on' as const,
  }));
  return {
    id: 'graph-1',
    specId: 'spec-1',
    title: 'Test',
    nodes,
    edges,
    rootNodes: opts.nodes.filter((n) => !opts.edges?.some((e) => e.from === n.id)).map((n) => n.id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Critical Path Analysis', () => {
  it('handles empty graph', () => {
    const graph = makeGraph({ nodes: [] });
    const result = analyzeCriticalPath(graph);
    expect(result.criticalPath).toEqual([]);
    expect(result.totalHours).toBe(0);
    expect(result.readyTasks).toEqual([]);
  });

  it('identifies ready tasks (no blockers)', () => {
    const graph = makeGraph({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.readyTasks).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(result.blockedTasks).toEqual([]);
  });

  it('identifies blocked tasks', () => {
    const graph = makeGraph({
      nodes: [makeNode('a'), makeNode('b')],
      edges: [{ from: 'b', to: 'a' }], // b depends on a
    });
    const result = analyzeCriticalPath(graph);
    expect(result.readyTasks).toContain('a');
    expect(result.blockedTasks).toContain('b');
  });

  it('detects bottlenecks', () => {
    const graph = makeGraph({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
      edges: [
        { from: 'b', to: 'a' },
        { from: 'c', to: 'a' },
        { from: 'd', to: 'a' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.bottlenecks.length).toBeGreaterThan(0);
    expect(result.bottlenecks[0]!.taskId).toBe('a');
    expect(result.bottlenecks[0]!.blockedCount).toBe(3);
  });

  it('computes parallel groups', () => {
    const graph = makeGraph({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      edges: [{ from: 'c', to: 'a' }], // c depends on a, b is independent
    });
    const result = analyzeCriticalPath(graph);
    // Group 1: a, b (both have no blockers)
    // Group 2: c (depends on a)
    expect(result.parallelGroups.length).toBe(2);
    expect(result.parallelGroups[0]).toContain('a');
    expect(result.parallelGroups[0]).toContain('b');
    expect(result.parallelGroups[1]).toContain('c');
  });

  it('skips completed tasks in ready list', () => {
    const graph = makeGraph({
      nodes: [makeNode('a', { status: 'completed' }), makeNode('b')],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.readyTasks).not.toContain('a');
    expect(result.readyTasks).toContain('b');
  });

  it('handles linear dependency chain', () => {
    const graph = makeGraph({
      nodes: [
        makeNode('a', { estimateHours: 2 }),
        makeNode('b', { estimateHours: 3 }),
        makeNode('c', { estimateHours: 1 }),
      ],
      edges: [
        { from: 'b', to: 'a' },
        { from: 'c', to: 'b' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.criticalPath).toEqual(['a', 'b', 'c']);
    expect(result.totalHours).toBe(6);
  });

  it('marks a task ready when every blocker is completed', () => {
    const graph = makeGraph({
      nodes: [makeNode('a', { status: 'completed' }), makeNode('b')],
      edges: [{ from: 'b', to: 'a' }],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.readyTasks).toContain('b');
    expect(result.blockedTasks).not.toContain('b');
  });

  it('breaks circular dependencies into bounded parallel groups', () => {
    const graph = makeGraph({
      nodes: [makeNode('a'), makeNode('b')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.parallelGroups.flat().sort()).toEqual(['a', 'b']);
  });

  it('tolerates unrelated and dangling edges with missing estimates', () => {
    const graph = makeGraph({
      nodes: [
        makeNode('a', { estimateHours: undefined }),
        makeNode('b', { estimateHours: undefined }),
        makeNode('c'),
      ],
    });
    graph.edges.push(
      { id: 'related', from: 'a', to: 'b', type: 'related_to' },
      { id: 'dangling-task', from: 'missing', to: 'a', type: 'depends_on' },
      { id: 'dangling-blocker', from: 'b', to: 'absent', type: 'depends_on' },
      { id: 'second-blocker', from: 'b', to: 'c', type: 'depends_on' },
    );
    const result = analyzeCriticalPath(graph);
    expect(result.bottlenecks.find((item) => item.taskId === 'a')?.blockedHours).toBe(0);
    expect(result.totalHours).toBeGreaterThanOrEqual(0);
  });
});
