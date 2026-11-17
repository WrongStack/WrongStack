import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskGraph } from '@wrongstack/contracts/types/task-graph';
import { expect, it, vi } from 'vitest';
import { TaskGraphStore } from '../src/task-graph-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const realRename = vi.mocked(fs.rename).getMockImplementation()!;

function graph(id: string, completed = false): TaskGraph {
  return {
    id,
    specId: 'fixture-spec',
    title: id,
    nodes: new Map([
      [
        'task',
        {
          id: 'task',
          title: 'Task',
          description: 'Fixture',
          type: 'feature',
          priority: 'high',
          status: completed ? 'completed' : 'pending',
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
}

it.each(['create', 'replace', 'delete'] as const)(
  'rebuilds its index after an index commit fails during %s',
  async (operation) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'task-index-failure-'));
    const store = new TaskGraphStore({ baseDir: dir });
    try {
      await store.save(graph('control'));
      const failure = Object.assign(new Error('injected index commit ENOSPC'), { code: 'ENOSPC' });
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (String(to) === join(dir, '_index.json')) throw failure;
        return realRename(from, to);
      });
      const pending =
        operation === 'delete'
          ? store.delete('control')
          : store.save(graph(operation === 'create' ? 'durable' : 'control', true));
      await expect(pending).rejects.toBe(failure);
      vi.mocked(fs.rename).mockImplementation(realRename);
      const recovered = new TaskGraphStore({ baseDir: dir });
      const list = await recovered.list();
      if (operation === 'delete') {
        expect(await recovered.load('control')).toBeNull();
        expect(list).toEqual([]);
      } else if (operation === 'create') {
        expect((await recovered.load('durable'))?.nodes.get('task')?.status).toBe('completed');
        expect(list.map((entry) => entry.id).sort()).toEqual(['control', 'durable']);
      } else {
        expect((await recovered.load('control'))?.nodes.get('task')?.status).toBe('completed');
        expect(list).toMatchObject([{ id: 'control', completedCount: 1 }]);
      }
      await recovered.save(graph('next'));
      expect((await recovered.list()).some((entry) => entry.id === 'next')).toBe(true);
    } finally {
      vi.mocked(fs.rename).mockImplementation(realRename);
      await store.flush();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
