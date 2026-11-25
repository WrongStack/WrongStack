import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskGraph } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { TaskGraphStore } from '../src/task-graph-store.js';

describe('TaskGraphStore corrupt payload validation (F1829)', () => {
  it('returns null for valid-JSON files with invalid TaskGraph shape or mismatched id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-task-graph-corrupt-'));
    try {
      const store = new TaskGraphStore({ baseDir: dir });
      const now = Date.now();
      const valid: TaskGraph = {
        id: 'valid-graph',
        specId: 'spec-1',
        title: 'Valid Graph',
        nodes: new Map(),
        edges: [],
        rootNodes: [],
        createdAt: now,
        updatedAt: now,
      };
      await store.save(valid);
      expect((await store.load('valid-graph'))?.id).toBe('valid-graph');

      await fs.writeFile(
        path.join(dir, 'corrupt.json'),
        JSON.stringify({ hello: 'world' }),
        'utf8',
      );
      await fs.writeFile(
        path.join(dir, 'mismatch.json'),
        JSON.stringify({
          id: 'other-graph',
          specId: 'spec-1',
          title: 'Other',
          nodes: [],
          edges: [],
          rootNodes: [],
          createdAt: now,
          updatedAt: now,
        }),
        'utf8',
      );

      expect(await store.load('corrupt')).toBeNull();
      expect(await store.load('mismatch')).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
