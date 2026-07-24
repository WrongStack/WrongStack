import type { TaskGraph, TaskNode } from '@wrongstack/core/types/task-graph.js';
import { computeTaskProgress } from '@wrongstack/core/types/task-graph.js';
import { describe, expect, it } from 'vitest';
import {
  renderProgress,
  renderSpecAnalysis,
  renderTaskGraph,
  renderTaskList,
} from '../src/task-visualizer.js';

function makeNode(id: string, overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: 'Description for task',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeGraph(nodes: TaskNode[], edges: Array<{ from: string; to: string }> = []): TaskGraph {
  return {
    id: 'graph-1',
    specId: 'spec-1',
    title: 'Test Graph',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: edges.map((e) => ({
      id: `${e.from}-${e.to}`,
      from: e.from,
      to: e.to,
      type: 'depends_on',
    })),
    rootNodes: nodes.filter((n) => !edges.some((e) => e.from === n.id)).map((n) => n.id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Task Visualizer', () => {
  it('renders a graph with header', () => {
    const graph = makeGraph([makeNode('a')]);
    const output = renderTaskGraph(graph);
    expect(output).toContain('Task Graph: Test Graph');
    expect(output).toContain('Nodes: 1');
  });

  it('renders progress bar', () => {
    const graph = makeGraph([makeNode('a', { status: 'completed' }), makeNode('b')]);
    const progress = computeTaskProgress(graph);
    const output = renderProgress(progress);
    expect(output).toContain('Progress:');
    expect(output).toContain('50%');
  });

  it('renders task list grouped by status', () => {
    const graph = makeGraph([
      makeNode('a', { status: 'completed' }),
      makeNode('b', { status: 'in_progress' }),
      makeNode('c'),
    ]);
    const output = renderTaskList(graph);
    expect(output).toContain('COMPLETED');
    expect(output).toContain('IN_PROGRESS');
    expect(output).toContain('PENDING');
  });

  it('renders compact mode', () => {
    const graph = makeGraph([
      makeNode('a', { title: 'A very long task title that should be truncated in compact mode' }),
    ]);
    const output = renderTaskGraph(graph, { compact: true });
    expect(output).toContain('…');
  });

  it('renders dependency arrows', () => {
    const graph = makeGraph([makeNode('a'), makeNode('b')], [{ from: 'b', to: 'a' }]);
    const output = renderTaskGraph(graph);
    // Should show that b depends on a
    expect(output).toContain('Task a');
    expect(output).toContain('Task b');
  });

  it('derives roots when none are declared and ignores non-dependency edges', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b'), makeNode('c')],
      [{ from: 'b', to: 'a' }],
    );
    graph.rootNodes = [];
    graph.edges.push({ id: 'related', from: 'c', to: 'a', type: 'relates_to' });

    const output = renderTaskGraph(graph);

    expect(output).toContain('Task a');
    expect(output).toContain('Task b');
    expect(output).toContain('Task c');
  });

  it('renders cyclic orphan nodes only once', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    graph.rootNodes = [];

    const output = renderTaskGraph(graph);

    expect(output.match(/Task a/g)).toHaveLength(2);
    expect(output.match(/Task b/g)).toHaveLength(2);
  });

  it('renders missing dependency labels, blank descriptions, and duplicate roots', () => {
    const graph = makeGraph([makeNode('a', { description: '' })]);
    graph.rootNodes = ['a', 'a'];
    graph.edges.push({
      id: 'missing',
      from: 'a',
      to: 'missing-node',
      type: 'depends_on',
    });

    expect(renderTaskGraph(graph)).toContain('← [?]');
  });

  it('renders empty graph', () => {
    const graph = makeGraph([]);
    const output = renderTaskGraph(graph);
    expect(output).toContain('Nodes: 0');
  });

  it('renders legend', () => {
    const graph = makeGraph([makeNode('a')]);
    const output = renderTaskGraph(graph);
    expect(output).toContain('Legend:');
  });

  it('renders mixed statuses', () => {
    const graph = makeGraph([
      makeNode('a', { status: 'completed' }),
      makeNode('b', { status: 'in_progress' }),
      makeNode('c', { status: 'blocked' }),
      makeNode('d', { status: 'failed' }),
      makeNode('e', { status: 'review' }),
    ]);
    const output = renderTaskList(graph);
    expect(output).toContain('COMPLETED');
    expect(output).toContain('IN_PROGRESS');
    expect(output).toContain('BLOCKED');
    expect(output).toContain('FAILED');
    expect(output).toContain('REVIEW');
  });

  it('renders spec analysis details', () => {
    const output = renderSpecAnalysis(
      {
        id: 'spec-1',
        title: 'Analyzed',
        version: '1.0.0',
        status: 'draft',
        overview: 'Overview',
        sections: [],
        requirements: [],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        completeness: 75,
        gaps: ['Missing API contract'],
        risks: ['Migration risk'],
        suggestions: ['Add rollback steps'],
      },
    );

    expect(output).toContain('Completeness:');
    expect(output).toContain('Missing API contract');
    expect(output).toContain('Migration risk');
    expect(output).toContain('Add rollback steps');
  });

  it('omits empty spec analysis sections', () => {
    const output = renderSpecAnalysis(
      {
        id: 'spec-1',
        title: 'Complete',
        version: '1.0.0',
        status: 'draft',
        overview: 'Overview',
        sections: [],
        requirements: [],
        createdAt: 1,
        updatedAt: 1,
      },
      { completeness: 100, gaps: [], risks: [], suggestions: [] },
    );

    expect(output).not.toContain('Gaps:');
    expect(output).not.toContain('Risks:');
    expect(output).not.toContain('Suggestions:');
  });
});
