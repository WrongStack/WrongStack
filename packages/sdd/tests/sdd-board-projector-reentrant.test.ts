import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { TaskGraph } from '@wrongstack/contracts/types/task-graph';
import { DefaultTaskStore, TaskTracker } from '@wrongstack/core/tasking';
import { expect, it, vi } from 'vitest';
import type { SddBoardSnapshot } from '../src/board-types.js';
import { SddBoardProjector } from '../src/sdd-board-projector.js';
import { SddBoardStore } from '../src/sdd-board-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const rename = vi.mocked(fs.rename).getMockImplementation()!;

it.each(['completed', 'stopped', 'deadlocked', 'failed'] as const)(
  'persists %s when a snapshot observer finishes the run reentrantly',
  async (terminal) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'projector-reentrant-'));
    const graph: TaskGraph = {
      id: 'graph',
      specId: 'spec',
      title: 'Fixture',
      nodes: new Map([
        [
          'task',
          {
            id: 'task',
            title: 'Task',
            description: '',
            type: 'feature',
            priority: 'high',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      ]),
      edges: [],
      rootNodes: ['task'],
      createdAt: 1,
      updatedAt: 1,
    };
    const tracker = new TaskTracker({ store: new DefaultTaskStore() });
    tracker.setGraph(graph);
    const events = new EventBus();
    const store = new SddBoardStore({ baseDir: dir });
    const projector = new SddBoardProjector({
      runId: 'run',
      graph,
      tracker,
      events,
      store,
      throttleMs: 60_000,
      now: () => 1000,
    });
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const committed: string[] = [];
    let pending: Promise<void> | undefined;
    let held = false;
    let finalized = false;
    const off = events.on('sdd.board.snapshot', (event) => {
      if ((event.snapshot as SddBoardSnapshot).status !== 'running' || finalized) return;
      finalized = true;
      if (terminal !== 'stopped')
        tracker.updateNodeStatus('task', terminal === 'completed' ? 'completed' : 'failed');
      events.emit('sdd.run.finished', {
        runId: 'run',
        deadlocked: terminal === 'deadlocked',
        completed: terminal === 'completed' ? 1 : 0,
        failed: terminal === 'failed' || terminal === 'deadlocked' ? 1 : 0,
        stopped: terminal === 'stopped',
      });
    });
    try {
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (String(to) !== store.snapshotPath('run')) return rename(from, to);
        const snapshot = JSON.parse(await fs.readFile(from, 'utf8')) as SddBoardSnapshot;
        if (snapshot.status === terminal && !held) {
          held = true;
          entered.resolve();
          await gate.promise;
        }
        await rename(from, to);
        committed.push(snapshot.status);
      });
      events.emit('sdd.run.started', {
        runId: 'run',
        graphId: graph.id,
        specId: graph.specId,
        total: 1,
      });
      let drained = false;
      pending = projector.drain().then(() => {
        drained = true;
      });
      await entered.promise;
      expect(drained).toBe(false);
      expect(projector.snapshot().status).toBe(terminal);
      gate.resolve();
      await pending;
      expect(committed.at(-1)).toBe(terminal);
      expect((await new SddBoardStore({ baseDir: dir }).load('run'))?.status).toBe(terminal);
      await projector.drain();
      expect((await store.load('run'))?.status).toBe(terminal);
      projector.dispose();
      const writes = committed.length;
      events.emit('sdd.wave', { runId: 'run', wave: 99, batchSize: 1 });
      await projector.drain();
      expect(committed).toHaveLength(writes);
    } finally {
      gate.resolve();
      off();
      projector.dispose();
      await pending;
      await projector.drain();
      vi.mocked(fs.rename).mockImplementation(rename);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
