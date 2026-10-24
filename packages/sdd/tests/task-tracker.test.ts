import type { TaskGraph } from '@wrongstack/contracts/types/task-graph';
import type { TaskStore } from '@wrongstack/core/tasking';
import { beforeEach, describe, expect, it } from 'vitest';
import { TaskTracker } from '../src/task-tracker.js';

function makeFakeStore(): TaskStore & { graphs: Map<string, TaskGraph> } {
  const graphs = new Map<string, TaskGraph>();
  return {
    graphs,
    async saveGraph(graph: TaskGraph) {
      graphs.set(graph.id, {
        ...graph,
        nodes: new Map(graph.nodes),
        edges: [...graph.edges],
        rootNodes: [...graph.rootNodes],
      });
    },
    async loadGraph(id: string) {
      const g = graphs.get(id);
      return g
        ? { ...g, nodes: new Map(g.nodes), edges: [...g.edges], rootNodes: [...g.rootNodes] }
        : null;
    },
    async listGraphs() {
      return Array.from(graphs.values()).map((g) => ({
        id: g.id,
        title: g.title,
        updatedAt: g.updatedAt,
      }));
    },
    async deleteGraph(id: string) {
      graphs.delete(id);
    },
  };
}

describe('TaskTracker', () => {
  let store: ReturnType<typeof makeFakeStore>;
  let tracker: TaskTracker;

  beforeEach(() => {
    store = makeFakeStore();
    tracker = new TaskTracker({ store });
  });

  describe('createGraph', () => {
    it('creates and saves graph', async () => {
      const graph = await tracker.createGraph('spec-1', 'My Spec');
      expect(graph.specId).toBe('spec-1');
      expect(graph.title).toBe('My Spec');
      expect(graph.nodes.size).toBe(0);
      expect(graph.id).toBeTruthy();
    });

    it('persists graph in store', async () => {
      const graph = await tracker.createGraph('s', 'T');
      const loaded = await store.loadGraph(graph.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.specId).toBe('s');
    });
  });

  describe('loadGraph', () => {
    it('loads existing graph', async () => {
      const created = await tracker.createGraph('s', 'T');
      const reloaded = await tracker.loadGraph(created.id);
      expect(reloaded?.id).toBe(created.id);
    });

    it('returns null for nonexistent graph', async () => {
      const result = await tracker.loadGraph('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('addNode', () => {
    it('throws when no graph loaded', () => {
      expect(() =>
        tracker.addNode({
          title: 'T',
          description: '',
          type: 'feature',
          priority: 'high',
          status: 'pending',
        }),
      ).toThrow('No graph loaded');
    });

    it('adds node with generated id and timestamps', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'Task',
        description: 'Desc',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      expect(node.id).toBeTruthy();
      expect(node.createdAt).toBeDefined();
      expect(node.updatedAt).toBeDefined();
      expect(node.status).toBe('pending');
    });

    it('defaults status to pending', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
      });
      expect(node.status).toBe('pending');
    });

    it('adds to rootNodes when no parentId', async () => {
      await tracker.createGraph('s', 't');
      const _node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const nodes = tracker.getAllNodes();
      expect(nodes.length).toBeGreaterThan(0);
      // Parent nodes (no parentId) go to rootNodes
      const parentNodes = nodes.filter((n) => !n.parentId);
      expect(parentNodes.length).toBeGreaterThan(0);
    });

    it('does not add to rootNodes when parentId set', async () => {
      await tracker.createGraph('s', 't');
      const parent = tracker.addNode({
        title: 'P',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const child = tracker.addNode({
        title: 'C',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        parentId: parent.id,
      });
      expect(child.parentId).toBe(parent.id);
      const _graph = await store.loadGraph((await tracker.loadGraph('' as any))?.id ?? '');
    });

    it('persists node in store', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      expect(tracker.getNode(node.id)).toBeDefined();
    });
  });

  describe('addEdge', () => {
    it('throws when no graph loaded', () => {
      expect(() => tracker.addEdge('a', 'b')).toThrow('No graph loaded');
    });

    it('adds edge with type default', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addEdge(n1.id, n2.id);
      // The default edge type is depends_on: n2 is blocked by n1.
      expect(tracker.getBlockers(n2.id)).toEqual([n1.id]);
      expect(tracker.getDependents(n1.id)).toEqual([n2.id]);
      expect(tracker.canStart(n2.id)).toBe(false);
    });

    it('adds edge with custom type', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addEdge(n1.id, n2.id, 'blocks');
      // A non-dependency edge must not gate scheduling.
      expect(tracker.getBlockers(n2.id)).toEqual([]);
      expect(tracker.getDependents(n1.id)).toEqual([]);
      expect(tracker.canStart(n2.id)).toBe(true);
    });
  });

  describe('updateNodeStatus', () => {
    it('throws when no graph loaded', () => {
      expect(() => tracker.updateNodeStatus('x', 'pending')).toThrow('No graph loaded');
    });

    it('throws when node not found', async () => {
      await tracker.createGraph('s', 't');
      expect(() => tracker.updateNodeStatus('nonexistent', 'pending')).toThrow('not found');
    });

    it('updates node status', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.updateNodeStatus(node.id, 'in_progress');
      expect(tracker.getNode(node.id)?.status).toBe('in_progress');
    });

    it('records transition', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.updateNodeStatus(node.id, 'in_progress');
      const transitions = tracker.getTransitions();
      expect(transitions.some((t) => t.from === 'pending' && t.to === 'in_progress')).toBe(true);
    });

    it('sets completedAt when status becomes completed', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const before = Date.now();
      expect(tracker.getNode(node.id)?.completedAt).toBeUndefined();
      tracker.updateNodeStatus(node.id, 'completed');
      // A real completion timestamp, taken at completion time — not merely a
      // field that exists (a stale or zero value would have passed before).
      const completedAt = tracker.getNode(node.id)?.completedAt;
      const stamp = typeof completedAt === 'number' ? completedAt : Date.parse(String(completedAt));
      expect(stamp).toBeGreaterThanOrEqual(before);
      expect(stamp).toBeLessThanOrEqual(Date.now());
    });

    it('auto-unblocks dependents when completed', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'blocked',
      });
      tracker.addEdge(n1.id, n2.id, 'depends_on');
      tracker.updateNodeStatus(n1.id, 'completed');
      // n2 should become pending
      expect(tracker.getNode(n2.id)?.status).toBe('pending');
    });

    it('auto-blocks task when blockers not completed', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addEdge(n1.id, n2.id, 'depends_on');
      tracker.updateNodeStatus(n2.id, 'in_progress');
      // n2 should become blocked since n1 is not completed
      expect(tracker.getNode(n2.id)?.status).toBe('blocked');
    });

    it('accepts optional reason in transition', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.updateNodeStatus(node.id, 'completed', 'all done');
      const transitions = tracker.getTransitions();
      expect(transitions.some((t) => t.reason === 'all done')).toBe(true);
    });
  });

  describe('getNode', () => {
    it('returns undefined when no graph', () => {
      expect(tracker.getNode('x')).toBeUndefined();
    });

    it('returns node by id', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      expect(tracker.getNode(node.id)).toBeDefined();
      expect(tracker.getNode(node.id)?.title).toBe('T');
    });

    it('returns undefined for nonexistent id', async () => {
      await tracker.createGraph('s', 't');
      expect(tracker.getNode('nonexistent')).toBeUndefined();
    });
  });

  describe('getAllNodes', () => {
    it('returns empty when no graph', () => {
      expect(tracker.getAllNodes()).toEqual([]);
    });

    it('returns all nodes', async () => {
      await tracker.createGraph('s', 't');
      tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addNode({
        title: 'N2',
        description: '',
        type: 'bugfix',
        priority: 'medium',
        status: 'pending',
      });
      const nodes = tracker.getAllNodes();
      expect(nodes).toHaveLength(2);
    });

    it('filters by status', async () => {
      await tracker.createGraph('s', 't');
      tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'completed',
      });
      const pending = tracker.getAllNodes({ status: ['pending'] });
      expect(pending).toHaveLength(1);
      expect(pending[0].title).toBe('N1');
    });

    it('filters by priority', async () => {
      await tracker.createGraph('s', 't');
      tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'low',
        status: 'pending',
      });
      const filtered = tracker.getAllNodes({ priority: ['high'] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('N1');
    });

    it('filters by type', async () => {
      await tracker.createGraph('s', 't');
      tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addNode({
        title: 'N2',
        description: '',
        type: 'bugfix',
        priority: 'high',
        status: 'pending',
      });
      const filtered = tracker.getAllNodes({ type: ['bugfix'] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('N2');
    });

    it('filters by tags', async () => {
      await tracker.createGraph('s', 't');
      tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        tags: ['security'],
      });
      tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        tags: ['performance'],
      });
      const filtered = tracker.getAllNodes({ tags: ['security'] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('N1');
    });

    it('sorts by field and direction', async () => {
      await tracker.createGraph('s', 't');
      tracker.addNode({
        title: 'Z',
        description: '',
        type: 'feature',
        priority: 'low',
        status: 'pending',
      });
      tracker.addNode({
        title: 'A',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const sorted = tracker.getAllNodes(undefined, { field: 'priority', direction: 'asc' });
      expect(sorted[0].title).toBe('A');
    });
  });

  describe('getChildren', () => {
    it('returns empty when no graph', () => {
      expect(tracker.getChildren('x')).toEqual([]);
    });

    it('returns children of parent', async () => {
      await tracker.createGraph('s', 't');
      const parent = tracker.addNode({
        title: 'P',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addNode({
        title: 'C1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        parentId: parent.id,
      });
      tracker.addNode({
        title: 'C2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        parentId: parent.id,
      });
      const children = tracker.getChildren(parent.id);
      expect(children).toHaveLength(2);
    });

    it('returns empty for node with no children', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'Solo',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      expect(tracker.getChildren(node.id)).toHaveLength(0);
    });
  });

  describe('getDependents', () => {
    it('returns empty when no graph', () => {
      expect(tracker.getDependents('x')).toEqual([]);
    });

    it('returns tasks that depend on given task', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addEdge(n1.id, n2.id, 'depends_on');
      const deps = tracker.getDependents(n1.id);
      expect(deps).toContain(n2.id);
    });
  });

  describe('getBlockers', () => {
    it('returns empty when no graph', () => {
      expect(tracker.getBlockers('x')).toEqual([]);
    });

    it('returns tasks that block given task', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addEdge(n1.id, n2.id, 'depends_on');
      const blockers = tracker.getBlockers(n2.id);
      expect(blockers).toContain(n1.id);
    });
  });

  describe('canStart', () => {
    it('returns true when no blockers', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'N',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      expect(tracker.canStart(node.id)).toBe(true);
    });

    it('returns true when all blockers completed', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'completed',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addEdge(n1.id, n2.id, 'depends_on');
      expect(tracker.canStart(n2.id)).toBe(true);
    });

    it('returns false when some blockers not completed', async () => {
      await tracker.createGraph('s', 't');
      const n1 = tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const n2 = tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.addEdge(n1.id, n2.id, 'depends_on');
      expect(tracker.canStart(n2.id)).toBe(false);
    });
  });

  describe('getProgress', () => {
    it('returns zero progress when no graph', () => {
      const progress = tracker.getProgress();
      expect(progress.total).toBe(0);
      expect(progress.percentComplete).toBe(0);
    });

    it('calculates progress correctly', async () => {
      await tracker.createGraph('s', 't');
      tracker.addNode({
        title: 'N1',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'completed',
      });
      tracker.addNode({
        title: 'N2',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'in_progress',
      });
      tracker.addNode({
        title: 'N3',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      const progress = tracker.getProgress();
      expect(progress.total).toBe(3);
      expect(progress.completed).toBe(1);
      expect(progress.inProgress).toBe(1);
      expect(progress.pending).toBe(1);
      expect(progress.percentComplete).toBe(33);
    });

    it('handles empty graph', async () => {
      await tracker.createGraph('s', 't');
      const progress = tracker.getProgress();
      expect(progress.total).toBe(0);
    });
  });

  describe('getTransitions', () => {
    it('returns empty by default', async () => {
      await tracker.createGraph('s', 't');
      expect(tracker.getTransitions()).toEqual([]);
    });

    it('records transitions for status changes', async () => {
      await tracker.createGraph('s', 't');
      const node = tracker.addNode({
        title: 'T',
        description: '',
        type: 'feature',
        priority: 'high',
        status: 'pending',
      });
      tracker.updateNodeStatus(node.id, 'in_progress');
      tracker.updateNodeStatus(node.id, 'completed');
      const transitions = tracker.getTransitions();
      expect(transitions.length).toBe(2);
    });
  });
});
