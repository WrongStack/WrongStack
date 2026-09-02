import { describe, expect, it } from 'vitest';
import { SddTaskDecomposer } from '../src/sdd-task-decomposer.js';
import { TaskTracker } from '../src/task-tracker.js';
import type { TaskGraph, TaskNode, TaskStore } from '@wrongstack/core/types/task-graph.js';

function makeFakeStore(): TaskStore {
  const graphs = new Map<string, TaskGraph>();
  return {
    async saveGraph(g: TaskGraph) {
      graphs.set(g.id, {
        ...g,
        nodes: new Map(g.nodes),
        edges: [...g.edges],
        rootNodes: [...g.rootNodes],
      });
    },
    async loadGraph(id: string) {
      const g = graphs.get(id);
      return g
        ? { ...g, nodes: new Map(g.nodes), edges: [...g.edges], rootNodes: [...g.rootNodes] }
        : null;
    },
    async listGraphs() {
      return [...graphs.values()].map((g) => ({
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

async function harness() {
  const tracker = new TaskTracker({ store: makeFakeStore() });
  await tracker.createGraph('spec', 'Decomp');
  const add = (title: string, priority: TaskNode['priority'] = 'medium') =>
    tracker.addNode({
      title,
      description: '',
      type: 'feature',
      priority,
      status: 'pending',
    } as never);
  return { tracker, add };
}

describe('SddTaskDecomposer', () => {
  it('clamps parallel slots into 1..16', async () => {
    const { tracker } = await harness();
    const graph = { nodes: new Map(), edges: [] } as never as TaskGraph;
    expect(
      (new SddTaskDecomposer(tracker, graph, { parallelSlots: 100 }) as never as { slots: number })
        .slots,
    ).toBe(16);
    expect(
      (new SddTaskDecomposer(tracker, graph, { parallelSlots: 0 }) as never as { slots: number })
        .slots,
    ).toBe(1);
    expect((new SddTaskDecomposer(tracker, graph) as never as { slots: number }).slots).toBe(4);
  });

  it('returns ready pending nodes, capped to the slot count and priority-sorted', async () => {
    const { tracker, add } = await harness();
    add('low one', 'low');
    add('crit one', 'critical');
    add('high one', 'high');
    const d = new SddTaskDecomposer(tracker, {} as TaskGraph, { parallelSlots: 2 });
    const batch = d.nextBatch();
    expect(batch.tasks).toHaveLength(2);
    expect(batch.tasks[0]!.title).toBe('crit one'); // critical first
    expect(batch.tasks[1]!.title).toBe('high one');
    expect(batch.allDone).toBe(false);
    expect(batch.deadlocked).toBe(false);
  });

  it('breaks ties on createdAt for equal priority', async () => {
    const { tracker, add } = await harness();
    const first = add('first', 'high');
    const second = add('second', 'high');
    // force a later createdAt on the second node
    (tracker.getAllNodes().find((n) => n.id === second.id) as TaskNode).createdAt =
      first.createdAt + 1000;
    const d = new SddTaskDecomposer(tracker, {} as TaskGraph, { parallelSlots: 5 });
    expect(d.nextBatch().tasks.map((t) => t.title)).toEqual(['first', 'second']);
  });

  it('excludes a task whose blocker is not yet complete, then includes it once unblocked', async () => {
    const { tracker, add } = await harness();
    const a = add('A', 'high');
    const b = add('B', 'high');
    tracker.addEdge(a.id, b.id, 'depends_on'); // B depends on A
    const d = new SddTaskDecomposer(tracker, {} as TaskGraph, { parallelSlots: 5 });
    expect(d.nextBatch().tasks.map((t) => t.title)).toEqual(['A']); // B blocked
    tracker.updateNodeStatus(a.id, 'in_progress');
    tracker.updateNodeStatus(a.id, 'completed');
    expect(d.nextBatch().tasks.map((t) => t.title)).toEqual(['B']); // now unblocked
  });

  it('reports deadlock when the only remaining tasks are blocked', async () => {
    const { tracker, add } = await harness();
    const a = add('A');
    tracker.updateNodeStatus(a.id, 'in_progress');
    tracker.updateNodeStatus(a.id, 'blocked');
    const d = new SddTaskDecomposer(tracker, {} as TaskGraph);
    const batch = d.nextBatch();
    expect(batch.tasks).toHaveLength(0);
    expect(batch.deadlocked).toBe(true);
  });

  it('returns no batch and not-deadlocked when remaining tasks are merely in progress', async () => {
    const { tracker, add } = await harness();
    const a = add('A');
    tracker.updateNodeStatus(a.id, 'in_progress');
    const d = new SddTaskDecomposer(tracker, {} as TaskGraph);
    const batch = d.nextBatch();
    expect(batch.tasks).toHaveLength(0);
    expect(batch.deadlocked).toBe(false);
  });

  it('reports allDone when every node is completed', async () => {
    const { tracker, add } = await harness();
    const a = add('A');
    tracker.updateNodeStatus(a.id, 'in_progress');
    tracker.updateNodeStatus(a.id, 'completed');
    const d = new SddTaskDecomposer(tracker, {} as TaskGraph);
    expect(d.isDone()).toBe(true);
    const batch = d.nextBatch();
    expect(batch.allDone).toBe(true);
    expect(batch.tasks).toHaveLength(0);
  });

  it('advances the wave counter on acknowledge', async () => {
    const { tracker } = await harness();
    const d = new SddTaskDecomposer(tracker, {} as TaskGraph);
    expect(d.getWaveCount()).toBe(0);
    d.acknowledgeBatch(['t1']);
    d.acknowledgeBatch(['t2']);
    expect(d.getWaveCount()).toBe(2);
  });
});
