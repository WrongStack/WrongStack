import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskTracker } from '@wrongstack/core/tasking';
import type { TaskGraph, TaskNode } from '@wrongstack/core/types/task-graph.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { TaskGraphStore } from '../src/task-graph-store.js';

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `task-graph-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function makeGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  const now = Date.now();
  const node: TaskNode = {
    id: 'node-1',
    title: 'Test Task',
    description: 'Test description',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  return {
    id: 'graph-1',
    specId: 'spec-1',
    title: 'Test Graph',
    nodes: new Map([[node.id, node]]),
    edges: [],
    rootNodes: [node.id],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TaskGraphStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  it('saves and loads a task graph', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const graph = makeGraph();
    await store.save(graph);

    const loaded = await store.load(graph.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Test Graph');
    expect(loaded!.nodes.size).toBe(1);
    expect(loaded!.nodes.get('node-1')!.title).toBe('Test Task');
  });

  it('lists saved graphs', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    await store.save(makeGraph({ id: 'g1', title: 'Graph A' }));
    await store.save(makeGraph({ id: 'g2', title: 'Graph B' }));

    const list = await store.list();
    expect(list.length).toBe(2);
  });

  it('deletes a graph', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const graph = makeGraph();
    await store.save(graph);
    const deleted = await store.delete(graph.id);
    expect(deleted).toBe(true);

    const loaded = await store.load(graph.id);
    expect(loaded).toBeNull();
  });

  it('deleteGraph removes a saved graph', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const graph = makeGraph();
    await store.save(graph);
    await store.deleteGraph(graph.id);
    expect(await store.load(graph.id)).toBeNull();
  });

  it('returns null for non-existent graph', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('checks existence', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const graph = makeGraph();
    await store.save(graph);
    expect(await store.exists(graph.id)).toBe(true);
    expect(await store.exists('nonexistent')).toBe(false);
  });

  it('persists Map serialization correctly', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const node1: TaskNode = {
      id: 'n1',
      title: 'Node 1',
      description: '',
      type: 'feature',
      priority: 'high',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const node2: TaskNode = {
      id: 'n2',
      title: 'Node 2',
      description: '',
      type: 'test',
      priority: 'medium',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const graph = makeGraph({
      nodes: new Map([
        [node1.id, node1],
        [node2.id, node2],
      ]),
    });
    await store.save(graph);

    const loaded = await store.load(graph.id);
    expect(loaded!.nodes.size).toBe(2);
    expect(loaded!.nodes.get('n2')!.status).toBe('completed');
  });

  it('updates index on save', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const graph = makeGraph();
    await store.save(graph);

    const list = await store.list();
    expect(list[0]!.nodeCount).toBe(1);
    expect(list[0]!.completedCount).toBe(0);
  });

  it('keeps the write chain consistent when a save fails', async () => {
    // Point baseDir at a regular file so ensureDir/atomicWrite throws; the
    // write-chain `.catch(() => undefined)` at task-graph-store.ts:68 must
    // swallow the failure without wedging later saves.
    await fs.mkdir(dir, { recursive: true });
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'i am a file');
    const store = new TaskGraphStore({ baseDir: blocker });
    const graph = makeGraph();
    await expect(store.save(graph)).rejects.toBeDefined();
    // A subsequent save with a valid baseDir still works.
    const healthy = new TaskGraphStore({ baseDir: dir });
    await expect(healthy.save(graph)).resolves.toBeUndefined();
    expect((await healthy.list()).length).toBe(1);
  });

  it('implements TaskStore and persists tracker transitions for process recovery', async () => {
    const store = new TaskGraphStore({ baseDir: dir });
    const tracker = new TaskTracker({ store });
    const graph = makeGraph();
    tracker.setGraph(graph);
    tracker.updateNodeStatus('node-1', 'in_progress', 'started');
    tracker.updateNodeStatus('node-1', 'completed', 'finished');

    const recoveredStore = new TaskGraphStore({ baseDir: dir });
    await expect
      .poll(async () => (await recoveredStore.loadGraph(graph.id))?.nodes.get('node-1')?.status)
      .toBe('completed');
    expect(await recoveredStore.listGraphs()).toMatchObject([{ id: graph.id, title: graph.title }]);
  });
});
