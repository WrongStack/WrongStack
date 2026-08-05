import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DirectorStateCheckpoint,
  type DirectorStateSnapshot,
} from '../../src/storage/director-state.js';

describe('DirectorStateCheckpoint.applyLiveMaxSpawns', () => {
  it('rewrites checkpoint ceiling while preserving spawnCount', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-ceiling-'));
    const file = path.join(dir, 'director-state.json');
    try {
      const cp = new DirectorStateCheckpoint(
        file,
        { directorRunId: 'run', maxSpawns: 48, spawnDepth: 0, maxSpawnDepth: 2 },
        5,
      );
      const snapshot: DirectorStateSnapshot = {
        version: 1,
        directorRunId: 'run',
        updatedAt: new Date().toISOString(),
        spawnCount: 40,
        maxSpawns: 48,
        spawnDepth: 0,
        maxSpawnDepth: 2,
        subagents: [],
        tasks: [],
      };
      cp.resume(snapshot);
      cp.applyLiveMaxSpawns(256);
      const cur = cp.current();
      expect(cur.spawnCount).toBe(40);
      expect(cur.maxSpawns).toBe(256);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
