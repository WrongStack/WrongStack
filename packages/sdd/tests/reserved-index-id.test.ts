import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Specification, TaskGraph } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { SpecStore } from '../src/spec-store.js';
import { TaskGraphStore } from '../src/task-graph-store.js';

describe('store index ownership', () => {
  it('rejects reserved ID aliases without losing existing spec/graph index entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-index-id-'));
    try {
      const spec = new SpecStore({ baseDir: join(dir, 'spec') });
      const graph = new TaskGraphStore({ baseDir: join(dir, 'graph') });
      const s = (id: string) =>
        ({
          id,
          title: id,
          version: '0.1.0',
          status: 'draft',
          updatedAt: 1,
          createdAt: 1,
          overview: '',
          sections: [],
          requirements: [],
        }) as Specification;
      const g = (id: string) =>
        ({
          id,
          specId: 's',
          title: id,
          updatedAt: 1,
          createdAt: 1,
          rootNodes: [],
          nodes: new Map(),
          edges: [],
        }) as TaskGraph;
      await spec.save(s('control'));
      await graph.save(g('control'));
      for (const id of ['_index', '_INDEX', '_InDeX']) {
        await expect(spec.save(s(id))).rejects.toThrow('Invalid spec id');
        await expect(graph.save(g(id))).rejects.toThrow('Invalid task-graph id');
        await expect(spec.delete(id)).rejects.toThrow('Invalid spec id');
        expect(await graph.delete(id)).toBe(false);
      }
      await spec.save(s('_index-safe'));
      await graph.save(g('_index-safe'));
      expect((await spec.list()).map((v) => v.id).sort()).toEqual(['_index-safe', 'control']);
      expect((await graph.list()).map((v) => v.id).sort()).toEqual(['_index-safe', 'control']);
      expect((await spec.load('control'))?.id).toBe('control');
      expect((await graph.load('control'))?.id).toBe('control');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
