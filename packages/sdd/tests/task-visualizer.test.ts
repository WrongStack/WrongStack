import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Specification } from '@wrongstack/contracts/types';
import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { computeTaskProgress } from '@wrongstack/contracts/types/task-graph';
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

function makeSpec(title: string): Specification {
  return {
    id: 'spec-1',
    title,
    version: '1.0.0',
    status: 'draft',
    overview: 'Overview',
    sections: [],
    requirements: [],
    createdAt: 1,
    updatedAt: 1,
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
    // Canonical depends_on direction is dependency (from) → dependent (to).
    rootNodes: nodes.filter((n) => !edges.some((e) => e.to === n.id)).map((n) => n.id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function loadWebuiUxGraph(): TaskGraph {
  const file = resolve(
    import.meta.dirname,
    '../../../docs/specs/webui-ux-improvements.task-graph.json',
  );
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Omit<TaskGraph, 'nodes'> & {
    nodes: [string, TaskNode][];
  };
  return { ...parsed, nodes: new Map(parsed.nodes) };
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

  it('renders canonical dependency → dependent edges from root to indented dependent', () => {
    const graph = makeGraph([makeNode('a'), makeNode('b')], [{ from: 'a', to: 'b' }]);
    const taskLines = renderTaskGraph(graph)
      .split('\n')
      .filter((line) => line.includes('Task a') || line.includes('Task b'));

    expect(taskLines).toEqual([
      expect.stringMatching(/^○ .* Task a$/),
      expect.stringMatching(/^ {2}○ .* Task b ← \[Task a\]$/),
    ]);
  });

  it('renders the WebUI UX graph from its two canonical roots toward dependents', () => {
    const output = renderTaskGraph(loadWebuiUxGraph());
    const lines = output.split('\n');
    const baseline = lines.find((line) => line.includes('Establish the WebUI UX browser baseline'));
    const measures = lines.find((line) =>
      line.includes('Add privacy-preserving UX performance measures'),
    );
    const welcome = lines.find((line) =>
      line.includes('Refactor WelcomeScreen into a task-first empty state'),
    );

    expect(baseline).toMatch(/^○ .* Establish the WebUI UX browser baseline$/);
    expect(measures).toMatch(/^○ .* Add privacy-preserving UX performance measures$/);
    expect(welcome).toMatch(/^ {2}○ .* ← \[Establish th\]$/);
  });

  it('derives roots when none are declared and ignores non-dependency edges', () => {
    const graph = makeGraph(
      [makeNode('a'), makeNode('b'), makeNode('c')],
      [{ from: 'a', to: 'b' }],
    );
    graph.rootNodes = [];
    graph.edges.push({ id: 'related', from: 'c', to: 'a', type: 'relates_to' });

    const taskLines = renderTaskGraph(graph)
      .split('\n')
      .filter(
        (line) => line.includes('Task a') || line.includes('Task b') || line.includes('Task c'),
      );

    expect(taskLines).toEqual([
      expect.stringMatching(/^○ .* Task a$/),
      expect.stringMatching(/^ {2}○ .* Task b ← \[Task a\]$/),
      expect.stringMatching(/^○ .* Task c$/),
    ]);
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
      from: 'missing-node',
      to: 'a',
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
    const output = renderSpecAnalysis(makeSpec('Analyzed'), {
      completeness: 75,
      gaps: ['Missing API contract'],
      risks: ['Migration risk'],
      suggestions: ['Add rollback steps'],
    });

    expect(output).toContain('Completeness:');
    expect(output).toContain('Missing API contract');
    expect(output).toContain('Migration risk');
    expect(output).toContain('Add rollback steps');
  });

  it('omits empty spec analysis sections', () => {
    const output = renderSpecAnalysis(makeSpec('Complete'), {
      completeness: 100,
      gaps: [],
      risks: [],
      suggestions: [],
    });

    expect(output).not.toContain('Gaps:');
    expect(output).not.toContain('Risks:');
    expect(output).not.toContain('Suggestions:');
  });
});
