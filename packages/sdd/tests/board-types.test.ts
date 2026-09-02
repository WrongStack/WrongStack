import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskGraph, TaskNode } from '@wrongstack/core/types/task-graph.js';
import { afterAll, describe, expect, it } from 'vitest';
import { buildBoardSnapshot, buildBoardTasks } from '../src/board-types.js';
import { SddBoardStore } from '../src/sdd-board-store.js';

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: id.toUpperCase(),
    description: `desc ${id}`,
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** a → b → c chain (c depends on b, b depends on a); d is independent. */
function chainGraph(): TaskGraph {
  const nodes = new Map<string, TaskNode>([
    ['a', node('a', { createdAt: 1, status: 'completed' })],
    ['b', node('b', { createdAt: 2, status: 'completed' })],
    ['c', node('c', { createdAt: 3, status: 'pending' })],
    ['d', node('d', { createdAt: 4, status: 'in_progress', assignee: 'Einstein' })],
  ]);
  return {
    id: 'g1',
    specId: 's1',
    title: 'Chain',
    nodes,
    edges: [
      { id: 'e1', from: 'a', to: 'b', type: 'depends_on' },
      { id: 'e2', from: 'b', to: 'c', type: 'depends_on' },
    ],
    rootNodes: ['a', 'd'],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('buildBoardTasks', () => {
  it('assigns stable short ids in creation order', () => {
    const { tasks } = buildBoardTasks(chainGraph());
    expect(tasks.map((t) => t.shortId)).toEqual(['t01', 't02', 't03', 't04']);
    expect(tasks.find((t) => t.id === 'a')?.shortId).toBe('t01');
  });

  it('lays tasks into topological columns by dependency depth', () => {
    const { columns } = buildBoardTasks(chainGraph());
    // a (depth0) + d (depth0) → Start; b → Phase 1; c → Phase 2
    expect(columns.map((c) => c.label)).toEqual(['Start', 'Phase 1', 'Phase 2']);
    expect(columns[0]!.taskIds.sort()).toEqual(['t01', 't04']);
    expect(columns[1]!.taskIds).toEqual(['t02']);
    expect(columns[2]!.taskIds).toEqual(['t03']);
  });

  it('exposes blocker refs as short ids', () => {
    const { tasks } = buildBoardTasks(chainGraph());
    expect(tasks.find((t) => t.id === 'c')?.deps).toEqual(['t02']);
    expect(tasks.find((t) => t.id === 'a')?.deps).toEqual([]);
  });

  it("derives 'queued' for a pending task whose blockers are all done", () => {
    const { tasks } = buildBoardTasks(chainGraph());
    // c is pending; its blocker b is completed → queued
    expect(tasks.find((t) => t.id === 'c')?.displayStatus).toBe('queued');
    // a is completed → stays completed
    expect(tasks.find((t) => t.id === 'a')?.displayStatus).toBe('completed');
  });

  it('carries the live agent from the node assignee', () => {
    const { tasks } = buildBoardTasks(chainGraph());
    expect(tasks.find((t) => t.id === 'd')?.agentName).toBe('Einstein');
  });

  it('handles dependency cycles without infinite recursion', () => {
    const g = chainGraph();
    g.edges.push({ id: 'e3', from: 'c', to: 'a', type: 'depends_on' }); // a←c cycle
    expect(() => buildBoardTasks(g)).not.toThrow();
  });
});

describe('buildBoardSnapshot', () => {
  it('wraps graph + run state into a snapshot', () => {
    const snap = buildBoardSnapshot(
      chainGraph(),
      { runId: 'r1', specId: 's1', status: 'running', startedAt: 100, wave: 2 },
      500,
    );
    expect(snap.runId).toBe('r1');
    expect(snap.status).toBe('running');
    expect(snap.wave).toBe(2);
    expect(snap.updatedAt).toBe(500);
    expect(snap.progress.total).toBe(4);
    expect(snap.progress.completed).toBe(2);
    expect(snap.tasks).toHaveLength(4);
    expect(snap.columns).toHaveLength(3);
  });
});

describe('SddBoardStore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-board-'));
  const store = new SddBoardStore({ baseDir: dir });

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a snapshot and indexes it', async () => {
    const snap = buildBoardSnapshot(
      chainGraph(),
      { runId: 'run-1', specId: 's1', status: 'running', startedAt: 1, wave: 0 },
      10,
    );
    await store.saveSnapshot(snap);
    const loaded = await store.load('run-1');
    expect(loaded?.runId).toBe('run-1');
    expect(loaded?.tasks).toHaveLength(4);

    const list = await store.list();
    expect(list.find((e) => e.runId === 'run-1')?.total).toBe(4);

    const latest = await store.loadLatestForSpec('s1');
    expect(latest?.runId).toBe('run-1');
  });

  it('invalidates a cached index after another store updates it', async () => {
    const cacheDir = join(dir, 'index-cache');
    const writer = new SddBoardStore({ baseDir: cacheDir });
    const reader = new SddBoardStore({ baseDir: cacheDir });
    await writer.saveSnapshot(
      buildBoardSnapshot(
        chainGraph(),
        { runId: 'cache-1', specId: 's1', status: 'running', startedAt: 1, wave: 0 },
        10,
      ),
    );
    expect((await reader.latest())?.runId).toBe('cache-1');

    await writer.saveSnapshot(
      buildBoardSnapshot(
        chainGraph(),
        { runId: 'cache-2', specId: 's2', status: 'running', startedAt: 2, wave: 0 },
        20,
      ),
    );
    expect((await reader.latest())?.runId).toBe('cache-2');
  });

  it('appends + drains the control queue', async () => {
    await store.appendControl('run-1', { ts: 1, type: 'pause' });
    await store.appendControl('run-1', { ts: 2, type: 'retry', payload: { taskId: 'c' } });
    const cmds = await store.drainControl('run-1');
    expect(cmds.map((c) => c.type)).toEqual(['pause', 'retry']);
    // queue is truncated after draining
    expect(await store.drainControl('run-1')).toEqual([]);
  });

  it('does not rewrite an already-empty control queue', async () => {
    await store.appendControl('empty-queue', { ts: 1, type: 'pause' });
    await store.drainControl('empty-queue');
    const controlPath = store.controlPath('empty-queue');
    const before = await fs.stat(controlPath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await store.drainControl('empty-queue')).toEqual([]);
    const after = await fs.stat(controlPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('serializes concurrent control appends and drains each batch once', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.appendControl('concurrent-control', { ts: index, type: `command-${index}` }),
      ),
    );
    const drains = await Promise.all([
      store.drainControl('concurrent-control'),
      store.drainControl('concurrent-control'),
    ]);
    expect(drains.map((commands) => commands.length).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it('appendEvent never throws', async () => {
    await expect(
      store.appendEvent('run-1', { ts: 1, type: 'sdd.task.started' }),
    ).resolves.toBeUndefined();
  });

  it('bounds event logs by compacting a valid JSONL tail', async () => {
    const bounded = new SddBoardStore({
      baseDir: dir,
      eventMaxBytes: 1024,
      eventKeepBytes: 512,
      eventSizeCheckEvery: 1,
    });
    for (let index = 0; index < 40; index++) {
      await bounded.appendEvent('bounded', {
        ts: index,
        type: 'sdd.task.updated',
        payload: { text: 'x'.repeat(120) },
      });
    }

    const eventPath = bounded.eventsPath('bounded');
    expect((await fs.stat(eventPath)).size).toBeLessThanOrEqual(1024);
    const lines = (await fs.readFile(eventPath, 'utf8')).trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => JSON.parse(line))).toBe(true);
  });
});
