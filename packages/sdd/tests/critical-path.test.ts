import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TaskGraph, TaskNode } from '@wrongstack/contracts/types/task-graph';
import { TaskTracker } from '@wrongstack/core/tasking';
import { describe, expect, it } from 'vitest';
import { analyzeCriticalPath } from '../src/critical-path.js';
import { splitGraphNode } from '../src/graph-split.js';

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
    rootNodes: opts.nodes.filter((n) => !opts.edges?.some((e) => e.to === n.id)).map((n) => n.id),
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
      edges: [{ from: 'a', to: 'b' }], // a is the dependency; b is the dependent
    });
    const result = analyzeCriticalPath(graph);
    expect(result.readyTasks).toContain('a');
    expect(result.blockedTasks).toContain('b');
  });

  it('detects bottlenecks', () => {
    const graph = makeGraph({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.bottlenecks.length).toBeGreaterThan(0);
    expect(result.bottlenecks[0]!.taskId).toBe('a');
    expect(result.bottlenecks[0]!.blockedCount).toBe(3);
  });

  it('computes bottleneck severity and sorts bottlenecks descending by severity, excluding completed tasks from executionOrder', () => {
    const graph = makeGraph({
      nodes: [
        makeNode('done', { status: 'completed' }),
        makeNode('minor-blocker'),
        makeNode('major-blocker'),
        makeNode('dep-1'),
        makeNode('dep-2'),
      ],
      edges: [
        { from: 'done', to: 'minor-blocker' },
        { from: 'minor-blocker', to: 'dep-1' }, // minor-blocker blocks 1 active task (severity 20)
        { from: 'major-blocker', to: 'dep-1' },
        { from: 'major-blocker', to: 'dep-2' }, // major-blocker blocks 2 active tasks (severity 40)
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.bottlenecks.map((b) => ({ id: b.taskId, severity: b.severity }))).toEqual([
      { id: 'major-blocker', severity: 40 },
      { id: 'minor-blocker', severity: 20 },
    ]);
    expect(result.executionOrder).not.toContain('done');
    expect(result.executionOrder).toContain('major-blocker');
  });

  it('preserves explicit 0-hour task estimates without falling back to 1 hour in critical path', () => {
    const graph = makeGraph({
      nodes: [
        makeNode('solo', { estimateHours: 1.5 }),
        makeNode('zero-root', { estimateHours: 1 }),
        makeNode('zero-mid', { estimateHours: 0 }),
        makeNode('zero-leaf', { estimateHours: 0 }),
      ],
      edges: [
        { from: 'zero-root', to: 'zero-mid' },
        { from: 'zero-mid', to: 'zero-leaf' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.criticalPath).toEqual(['solo']);
    expect(result.totalHours).toBe(1.5);
  });

  it('computes parallel groups', () => {
    const graph = makeGraph({
      nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
      edges: [{ from: 'a', to: 'c' }], // a is the dependency; c is the dependent, b is independent
    });
    const result = analyzeCriticalPath(graph);
    // Group 1: a, b (both have no blockers)
    // Group 2: c (depends on a)
    expect(result.parallelGroups.length).toBe(2);
    expect(result.parallelGroups[0]).toContain('a');
    expect(result.parallelGroups[0]).toContain('b');
    expect(result.parallelGroups[1]).toContain('c');
  });

  it('computes parallel groups for tasks whose dependencies are completed', () => {
    const graph = makeGraph({
      nodes: [
        makeNode('setup', { status: 'completed' }),
        makeNode('api', { status: 'pending' }),
        makeNode('ui', { status: 'pending' }),
      ],
      edges: [
        { from: 'setup', to: 'api' },
        { from: 'setup', to: 'ui' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.parallelGroups).toHaveLength(1);
    expect(result.parallelGroups[0]).toEqual(expect.arrayContaining(['api', 'ui']));
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
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.criticalPath).toEqual(['a', 'b', 'c']);
    expect(result.totalHours).toBe(6);
  });

  it('marks a task ready when every blocker is completed', () => {
    const graph = makeGraph({
      nodes: [makeNode('a', { status: 'completed' }), makeNode('b')],
      edges: [{ from: 'a', to: 'b' }],
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
      { id: 'related', from: 'a', to: 'b', type: 'relates_to' },
      { id: 'dangling-task', from: 'missing', to: 'a', type: 'depends_on' },
      { id: 'dangling-blocker', from: 'b', to: 'absent', type: 'depends_on' },
      { id: 'second-blocker', from: 'c', to: 'b', type: 'depends_on' },
    );
    const result = analyzeCriticalPath(graph);
    expect(result.bottlenecks.find((item) => item.taskId === 'c')?.blockedHours).toBe(0);
    expect(result.totalHours).toBeGreaterThanOrEqual(0);
  });

  it('uses canonical dependency-to-dependent edges for the WebUI UX graph', () => {
    const result = analyzeCriticalPath(loadWebuiUxGraph());

    expect(result.readyTasks.sort()).toEqual(['WUX-S0.1', 'WUX-S0.2']);
    expect(result.criticalPath).toEqual([
      'WUX-S0.1',
      'WUX-S1.1',
      'WUX-S1.2',
      'WUX-S4.2',
      'WUX-S5.2',
    ]);
    expect(result.executionOrder.indexOf('WUX-S0.1')).toBeLessThan(
      result.executionOrder.indexOf('WUX-S1.1'),
    );
    expect(result.parallelGroups[0]?.sort()).toEqual(['WUX-S0.1', 'WUX-S0.2']);
  });

  it('ignores dangling depends_on edges whose endpoints are missing from graph.nodes', () => {
    const graph = makeGraph({
      nodes: [makeNode('a', { status: 'pending', estimateHours: 2 })],
      edges: [
        { from: 'missing-upstream', to: 'a' },
        { from: 'a', to: 'missing-downstream' },
      ],
    });
    const result = analyzeCriticalPath(graph);
    expect(result.readyTasks).toEqual(['a']);
    expect(result.blockedTasks).toEqual([]);
    expect(result.bottlenecks).toEqual([]);
  });
});

describe('splitGraphNode', () => {
  it('splits a pending task, inherits blockers, rewires dependents, and enforces refusal guards', async () => {
    const tracker = new TaskTracker({
      store: {
        saveGraph: async () => {},
        loadGraph: async () => null,
        listGraphs: async () => [],
        deleteGraph: async () => {},
      } as never,
    });
    await tracker.createGraph('spec-1', 'Split Graph');
    const blocker = tracker.addNode({
      title: 'Blocker',
      description: 'upstream',
      type: 'chore',
      priority: 'medium',
      status: 'pending',
    });
    const parent = tracker.addNode({
      title: 'Parent',
      description: 'container',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    const dependent = tracker.addNode({
      title: 'Dependent',
      description: 'downstream',
      type: 'chore',
      priority: 'low',
      status: 'pending',
    });
    tracker.addDependency(blocker.id, parent.id);
    tracker.addDependency(parent.id, dependent.id);

    // Refuses missing node, empty subtasks, isRunning predicate, and in_progress status
    expect(splitGraphNode(tracker, 'missing-id', [{ title: 'Sub', description: 'd' }])).toEqual([]);
    expect(splitGraphNode(tracker, parent.id, [])).toEqual([]);
    expect(
      splitGraphNode(tracker, parent.id, [{ title: 'Sub', description: 'd' }], {
        isRunning: (id) => id === parent.id,
      }),
    ).toEqual([]);

    tracker.updateNodeStatus(blocker.id, 'in_progress');
    expect(splitGraphNode(tracker, blocker.id, [{ title: 'Sub', description: 'd' }])).toEqual([]);
    tracker.updateNodeStatus(blocker.id, 'pending');

    const leafIds = splitGraphNode(tracker, parent.id, [
      { title: 'Leaf 1', description: 'First part', successCriterion: 'Must pass unit test' },
      { title: 'Leaf 2', description: 'Second part', type: 'bugfix', priority: 'critical' },
    ]);

    expect(leafIds).toHaveLength(2);
    expect(tracker.getNode(parent.id)?.status).toBe('completed');
    expect(tracker.getNode(leafIds[0]!)?.description).toContain(
      '**Acceptance Criteria:**\n- Must pass unit test',
    );
    expect(tracker.getBlockers(leafIds[0]!)).toContain(blocker.id);
    expect(tracker.getBlockers(leafIds[1]!)).toContain(blocker.id);
    expect(tracker.getBlockers(dependent.id)).toEqual(expect.arrayContaining(leafIds));
  });
});
