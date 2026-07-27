/**
 * Tests for TaskTracker — task graph management with dependencies,
 * status transitions, filtering, sorting, and change notifications.
 */
import { describe, expect, it, vi } from 'vitest';
import { TaskTracker } from '../../src/tasking/task-tracker.js';
import type { TaskStore } from '../../src/tasking/task-tracker.js';

function makeStore(): TaskStore {
  const graphs = new Map<string, unknown>();
  return {
    saveGraph: vi.fn(async (g: { id: string }) => { graphs.set(g.id, g); }),
    loadGraph: vi.fn(async (id: string) => (graphs.get(id) as never) ?? null),
    listGraphs: vi.fn(async () => []),
    deleteGraph: vi.fn(async (id: string) => { graphs.delete(id); }),
  };
}

function makeTracker(store?: TaskStore) {
  return new TaskTracker({ store: store ?? makeStore() });
}

async function withGraph(tracker?: TaskTracker) {
  const t = tracker ?? makeTracker();
  await t.createGraph('spec-1', 'Test Graph');
  return t;
}

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Test Task',
    description: '',
    type: 'feature' as const,
    priority: 'medium' as const,
    status: 'pending' as const,
    ...overrides,
  };
}

describe('TaskTracker — graph lifecycle', () => {
  it('creates a graph with a unique id', async () => {
    const t = makeTracker();
    const g = await t.createGraph('spec-1', 'My Graph');
    expect(g.id).toBeDefined();
    expect(g.title).toBe('My Graph');
    expect(g.specId).toBe('spec-1');
    expect(g.nodes.size).toBe(0);
  });

  it('loads a graph from the store', async () => {
    const store = makeStore();
    const t = makeTracker(store);
    const g = await t.createGraph('spec-1', 'Saved');
    const t2 = makeTracker(store);
    const loaded = await t2.loadGraph(g.id);
    expect(loaded?.title).toBe('Saved');
  });

  it('setGraph attaches an existing graph', async () => {
    const t = makeTracker();
    const g = await t.createGraph('spec-1', 'Original');
    const t2 = makeTracker();
    t2.setGraph(g);
    expect(t2.getNode('nonexistent')).toBeUndefined();
    expect(t2.getAllNodes()).toEqual([]);
  });
});

describe('TaskTracker — addNode', () => {
  it('adds a node and returns it with an id', async () => {
    const t = await withGraph();
    const node = t.addNode(makeNode());
    expect(node.id).toBeDefined();
    expect(node.title).toBe('Test Task');
    expect(node.status).toBe('pending');
    expect(t.getNode(node.id)).toBe(node);
  });

  it('adds root nodes to rootNodes list', async () => {
    const t = await withGraph();
    t.addNode(makeNode());
    const all = t.getAllNodes();
    expect(all).toHaveLength(1);
  });

  it('throws when no graph is loaded', () => {
    const t = makeTracker();
    expect(() => t.addNode(makeNode())).toThrow('No graph loaded');
  });
});

describe('TaskTracker — addEdge and addDependency', () => {
  it('adds a dependency edge between two nodes', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'A' }));
    const b = t.addNode(makeNode({ title: 'B' }));
    const result = t.addDependency(a.id, b.id);
    expect(result).toBe(true);
    expect(t.getBlockers(b.id)).toContain(a.id);
    expect(t.getDependents(a.id)).toContain(b.id);
  });

  it('rejects self-dependency', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode());
    expect(t.addDependency(a.id, a.id)).toBe(false);
  });

  it('rejects dependency with missing nodes', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode());
    expect(t.addDependency(a.id, 'nonexistent')).toBe(false);
    expect(t.addDependency('nonexistent', a.id)).toBe(false);
  });

  it('is idempotent for existing dependencies', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'A' }));
    const b = t.addNode(makeNode({ title: 'B' }));
    t.addDependency(a.id, b.id);
    expect(t.addDependency(a.id, b.id)).toBe(true);
    // Only one edge
    expect(t.getBlockers(b.id)).toHaveLength(1);
  });

  it('rejects cycles', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'A' }));
    const b = t.addNode(makeNode({ title: 'B' }));
    const c = t.addNode(makeNode({ title: 'C' }));
    t.addDependency(a.id, b.id);
    t.addDependency(b.id, c.id);
    // c → a would create a cycle
    expect(t.addDependency(c.id, a.id)).toBe(false);
  });

  it('returns false when no graph is loaded', () => {
    const t = makeTracker();
    expect(t.addDependency('a', 'b')).toBe(false);
  });
});

describe('TaskTracker — updateNodeStatus', () => {
  it('updates status and records transition', async () => {
    const t = await withGraph();
    const node = t.addNode(makeNode());
    t.updateNodeStatus(node.id, 'in_progress');
    expect(t.getNode(node.id)?.status).toBe('in_progress');
    expect(t.getNode(node.id)?.startedAt).toBeDefined();
    const transitions = t.getTransitions();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.from).toBe('pending');
    expect(transitions[0]?.to).toBe('in_progress');
  });

  it('sets completedAt on completion', async () => {
    const t = await withGraph();
    const node = t.addNode(makeNode());
    t.updateNodeStatus(node.id, 'completed');
    expect(t.getNode(node.id)?.completedAt).toBeDefined();
  });

  it('throws for missing node', async () => {
    const t = await withGraph();
    expect(() => t.updateNodeStatus('nonexistent', 'completed')).toThrow('not found');
  });

  it('throws when no graph is loaded', () => {
    const t = makeTracker();
    expect(() => t.updateNodeStatus('x', 'completed')).toThrow('No graph loaded');
  });

  it('auto-unblocks dependents when blocker completes', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'Blocker' }));
    const b = t.addNode(makeNode({ title: 'Dependent', status: 'blocked' }));
    t.addDependency(a.id, b.id);
    t.updateNodeStatus(a.id, 'completed');
    expect(t.getNode(b.id)?.status).toBe('pending');
  });

  it('auto-blocks a task started with incomplete blockers', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'Blocker' }));
    const b = t.addNode(makeNode({ title: 'Dependent' }));
    t.addDependency(a.id, b.id);
    t.updateNodeStatus(b.id, 'in_progress');
    expect(t.getNode(b.id)?.status).toBe('blocked');
  });
});

describe('TaskTracker — updateNode', () => {
  it('patches node fields', async () => {
    const t = await withGraph();
    const node = t.addNode(makeNode());
    t.updateNode(node.id, { title: 'Updated', priority: 'high', assignee: 'agent-1' });
    const updated = t.getNode(node.id);
    expect(updated?.title).toBe('Updated');
    expect(updated?.priority).toBe('high');
    expect(updated?.assignee).toBe('agent-1');
  });

  it('throws for missing node', async () => {
    const t = await withGraph();
    expect(() => t.updateNode('nonexistent', { title: 'x' })).toThrow('not found');
  });
});

describe('TaskTracker — patchMetadata', () => {
  it('merges metadata into a node', async () => {
    const t = await withGraph();
    const node = t.addNode(makeNode());
    t.patchMetadata(node.id, { provider: 'openai', model: 'gpt-4o' });
    expect(t.getNode(node.id)?.metadata).toEqual({ provider: 'openai', model: 'gpt-4o' });
    t.patchMetadata(node.id, { model: 'gpt-4o-mini' });
    expect(t.getNode(node.id)?.metadata).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('is a no-op for missing node or graph', () => {
    const t = makeTracker();
    t.patchMetadata('x', { a: 1 }); // no graph — no throw
  });
});

describe('TaskTracker — removeNode', () => {
  it('removes a node and its edges', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'A' }));
    const b = t.addNode(makeNode({ title: 'B' }));
    t.addDependency(a.id, b.id);
    expect(t.removeNode(a.id)).toBe(true);
    expect(t.getNode(a.id)).toBeUndefined();
    expect(t.getBlockers(b.id)).toHaveLength(0);
  });

  it('returns false for missing node', async () => {
    const t = await withGraph();
    expect(t.removeNode('nonexistent')).toBe(false);
  });

  it('returns false when no graph is loaded', () => {
    expect(makeTracker().removeNode('x')).toBe(false);
  });
});

describe('TaskTracker — getAllNodes filtering and sorting', () => {
  it('filters by status', async () => {
    const t = await withGraph();
    t.addNode(makeNode({ title: 'A', status: 'pending' }));
    t.addNode(makeNode({ title: 'B', status: 'completed' }));
    const pending = t.getAllNodes({ status: ['pending'] });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.title).toBe('A');
  });

  it('filters by priority', async () => {
    const t = await withGraph();
    t.addNode(makeNode({ title: 'A', priority: 'high' }));
    t.addNode(makeNode({ title: 'B', priority: 'low' }));
    const high = t.getAllNodes({ priority: ['high'] });
    expect(high).toHaveLength(1);
  });

  it('sorts by priority descending', async () => {
    const t = await withGraph();
    t.addNode(makeNode({ title: 'Low', priority: 'low' }));
    t.addNode(makeNode({ title: 'Critical', priority: 'critical' }));
    const sorted = t.getAllNodes(undefined, { field: 'priority', direction: 'asc' });
    expect(sorted[0]?.title).toBe('Critical');
  });

  it('returns empty array when no graph', () => {
    expect(makeTracker().getAllNodes()).toEqual([]);
  });
});

describe('TaskTracker — canStart', () => {
  it('returns true when no blockers', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode());
    expect(t.canStart(a.id)).toBe(true);
  });

  it('returns false when blocker is pending', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'Blocker' }));
    const b = t.addNode(makeNode({ title: 'Dependent' }));
    t.addDependency(a.id, b.id);
    expect(t.canStart(b.id)).toBe(false);
  });

  it('returns true when blocker is completed', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'Blocker' }));
    const b = t.addNode(makeNode({ title: 'Dependent' }));
    t.addDependency(a.id, b.id);
    t.updateNodeStatus(a.id, 'completed');
    expect(t.canStart(b.id)).toBe(true);
  });

  it('returns true when blocker has failed', async () => {
    const t = await withGraph();
    const a = t.addNode(makeNode({ title: 'Blocker' }));
    const b = t.addNode(makeNode({ title: 'Dependent' }));
    t.addDependency(a.id, b.id);
    t.updateNodeStatus(a.id, 'failed');
    expect(t.canStart(b.id)).toBe(true);
  });
});

describe('TaskTracker — getProgress', () => {
  it('returns zeroed progress when no graph', () => {
    const p = makeTracker().getProgress();
    expect(p.total).toBe(0);
    expect(p.percentComplete).toBe(0);
  });

  it('computes progress from nodes', async () => {
    const t = await withGraph();
    t.addNode(makeNode({ title: 'A', status: 'completed' }));
    t.addNode(makeNode({ title: 'B', status: 'pending' }));
    const p = t.getProgress();
    expect(p.total).toBe(2);
    expect(p.completed).toBe(1);
    expect(p.pending).toBe(1);
  });
});

describe('TaskTracker — subscribe', () => {
  it('notifies listeners on node add', async () => {
    const t = await withGraph();
    const changes: unknown[] = [];
    t.subscribe((c) => changes.push(c));
    t.addNode(makeNode());
    expect(changes).toHaveLength(1);
    expect((changes[0] as { type: string }).type).toBe('node_added');
  });

  it('notifies on status change with transition', async () => {
    const t = await withGraph();
    const node = t.addNode(makeNode());
    const changes: unknown[] = [];
    t.subscribe((c) => changes.push(c));
    t.updateNodeStatus(node.id, 'in_progress', 'starting work');
    expect(changes).toHaveLength(1);
    const change = changes[0] as { type: string; transition?: { reason?: string } };
    expect(change.type).toBe('status_changed');
    expect(change.transition?.reason).toBe('starting work');
  });

  it('unsubscribe stops notifications', async () => {
    const t = await withGraph();
    const changes: unknown[] = [];
    const unsub = t.subscribe((c) => changes.push(c));
    unsub();
    t.addNode(makeNode());
    expect(changes).toHaveLength(0);
  });

  it('a throwing listener does not break mutations', async () => {
    const t = await withGraph();
    t.subscribe(() => { throw new Error('listener boom'); });
    // Should not throw
    const node = t.addNode(makeNode());
    expect(node.id).toBeDefined();
  });
});

describe('TaskTracker — persist error handling', () => {
  it('calls onPersistError when fire-and-forget persist rejects', async () => {
    const errors: unknown[] = [];
    let shouldFail = false;
    const store: TaskStore = {
      saveGraph: vi.fn(async () => {
        if (shouldFail) throw new Error('disk full');
      }),
      loadGraph: vi.fn(async () => null),
      listGraphs: vi.fn(async () => []),
      deleteGraph: vi.fn(async () => {}),
    };
    const t = new TaskTracker({ store, onPersistError: (e) => errors.push(e) });
    // createGraph succeeds (shouldFail is false)
    await t.createGraph('spec-1', 'Test');
    // Now make persist fail — addNode uses fire-and-forget persist()
    shouldFail = true;
    t.addNode(makeNode());
    // Wait for the microtask to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('createGraph propagates store errors directly', async () => {
    const store: TaskStore = {
      saveGraph: vi.fn(async () => { throw new Error('disk full'); }),
      loadGraph: vi.fn(async () => null),
      listGraphs: vi.fn(async () => []),
      deleteGraph: vi.fn(async () => {}),
    };
    const t = new TaskTracker({ store });
    await expect(t.createGraph('spec-1', 'Test')).rejects.toThrow('disk full');
  });
});

describe('TaskTracker — getChildren', () => {
  it('returns children of a parent node', async () => {
    const t = await withGraph();
    const parent = t.addNode(makeNode({ title: 'Parent' }));
    t.addNode(makeNode({ title: 'Child', parentId: parent.id }));
    t.addNode(makeNode({ title: 'Other' }));
    const children = t.getChildren(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe('Child');
  });

  it('returns empty when no graph', () => {
    expect(makeTracker().getChildren('x')).toEqual([]);
  });
});
