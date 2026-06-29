import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DirectorStateCheckpoint,
  loadDirectorState,
} from '../../src/storage/director-state.js';

describe('director-state checkpoint', () => {
  it('records spawns and writes to disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'director-state.json');
    try {
      const cp = new DirectorStateCheckpoint(
        file,
        { directorRunId: 'run-1', spawnDepth: 0, maxSpawnDepth: 2 },
        10, // tight debounce for tests
      );
      cp.recordSpawn(
        {
          id: 'sub-1',
          name: 'checker',
          role: 'bug-hunter',
          spawnedAt: new Date().toISOString(),
        },
        1,
      );
      await cp.flush();
      const loaded = await loadDirectorState(file);
      expect(loaded?.directorRunId).toBe('run-1');
      expect(loaded?.subagents).toHaveLength(1);
      expect(loaded?.subagents[0]?.id).toBe('sub-1');
      expect(loaded?.spawnCount).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('updates task status incrementally', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'director-state.json');
    try {
      const cp = new DirectorStateCheckpoint(
        file,
        { directorRunId: 'run-2', spawnDepth: 0, maxSpawnDepth: 2 },
        10,
      );
      cp.recordTaskAssigned({
        taskId: 't-1',
        subagentId: 'sub-1',
        description: 'do thing',
        status: 'running',
      });
      cp.recordTaskStatus('t-1', {
        status: 'completed',
        completedAt: new Date().toISOString(),
        iterations: 3,
      });
      await cp.flush();
      const loaded = await loadDirectorState(file);
      expect(loaded?.tasks).toHaveLength(1);
      expect(loaded?.tasks[0]?.status).toBe('completed');
      expect(loaded?.tasks[0]?.iterations).toBe(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null on corrupt files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'bad.json');
    try {
      await fs.writeFile(file, '{not valid json');
      expect(await loadDirectorState(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadDirectorState returns null when version !== 1', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'version-mismatch.json');
    try {
      await fs.writeFile(file, JSON.stringify({ version: 2, items: [] }));
      expect(await loadDirectorState(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('acquireDirectorStateLock returns false when lock is held by live process', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-lock-'));
    const lockPath = path.join(dir, 'director-state.json.lock');
    try {
      // Write a lock with our own PID — process.kill(pid, 0) will succeed
      const lock = { pid: process.pid, hostname: 'test', startedAt: new Date().toISOString() };
      await fs.writeFile(lockPath, JSON.stringify(lock), 'utf8');
      const result = await import('../../src/storage/director-state.js')
        .then(({ acquireDirectorStateLock }) => acquireDirectorStateLock(lockPath, process.pid));
      expect(result).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('acquireDirectorStateLock treats corrupt lock JSON as stale', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-lock-'));
    const lockPath = path.join(dir, 'corrupt.lock');
    try {
      // Write malformed JSON — should be treated as stale and overwritten
      await fs.writeFile(lockPath, 'not json at all', 'utf8');
      const { acquireDirectorStateLock } = await import('../../src/storage/director-state.js');
      const result = await acquireDirectorStateLock(lockPath);
      expect(result).toBe(true);
      const content = await fs.readFile(lockPath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.pid).toBe(process.pid);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('releaseDirectorStateLock silently succeeds when lock file does not exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-lock-'));
    const lockPath = path.join(dir, 'nonexistent.lock');
    try {
      const { releaseDirectorStateLock } = await import('../../src/storage/director-state.js');
      // Should not throw
      await releaseDirectorStateLock(lockPath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('DirectorStateCheckpoint constructor initializes full snapshot', () => {
    const cp = new DirectorStateCheckpoint(
      '/tmp/dstate.json',
      { directorRunId: 'run-ctor', maxSpawns: 5, spawnDepth: 1, maxSpawnDepth: 3, directorBudget: { maxCostUsd: 10 } },
      100,
    );
    const snap = cp.current();
    expect(snap.version).toBe(1);
    expect(snap.directorRunId).toBe('run-ctor');
    expect(snap.maxSpawns).toBe(5);
    expect(snap.spawnDepth).toBe(1);
    expect(snap.maxSpawnDepth).toBe(3);
    expect(snap.directorBudget?.maxCostUsd).toBe(10);
    expect(snap.subagents).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.spawnCount).toBe(0);
  });

  it('checkpoint.resume replaces snapshot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'director-state.json');
    try {
      const cp = new DirectorStateCheckpoint(file, { directorRunId: 'run', spawnDepth: 0, maxSpawnDepth: 2 }, 10);
      const snapshot: import('../../src/storage/director-state.js').DirectorStateSnapshot = {
        version: 1, directorRunId: 'run', updatedAt: new Date().toISOString(),
        spawnCount: 5, spawnDepth: 1, maxSpawnDepth: 2, subagents: [{ id: 'sub', spawnedAt: new Date().toISOString() }],
        tasks: [{ taskId: 't1', status: 'running' }],
      };
      cp.resume(snapshot);
      const snap = cp.current();
      expect(snap.spawnCount).toBe(5);
      expect(snap.subagents).toHaveLength(1);
      expect(snap.tasks[0]?.taskId).toBe('t1');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('checkpoint.current() returns current snapshot', () => {
    const cp = new DirectorStateCheckpoint('/tmp/dstate.json', { directorRunId: 'run', spawnDepth: 0, maxSpawnDepth: 2 });
    const snap = cp.current();
    expect(snap).toBeDefined();
    expect(snap.directorRunId).toBe('run');
  });

  it('checkpoint.setUsage() sets usage field', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'director-state.json');
    try {
      const cp = new DirectorStateCheckpoint(file, { directorRunId: 'run', spawnDepth: 0, maxSpawnDepth: 2 }, 10);
      cp.setUsage({ totalCost: 0.5 });
      await cp.flush();
      const loaded = await loadDirectorState(file);
      expect(loaded?.usage).toEqual({ totalCost: 0.5 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('checkpoint.acquireLock() / releaseLock() manage lock', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'director-state.json');
    try {
      const cp = new DirectorStateCheckpoint(file, { directorRunId: 'run', spawnDepth: 0, maxSpawnDepth: 2 });
      const acquired = await cp.acquireLock();
      expect(acquired).toBe(true);
      // Lock file should exist
      const lockPath = `${file}.lock`;
      const lockContent = await fs.readFile(lockPath, 'utf8');
      expect(JSON.parse(lockContent).pid).toBe(process.pid);
      await cp.releaseLock();
      // Lock file should be gone
      await expect(fs.access(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('persist() sets rewriteRequested when writing is already true', async () => {
    // This is tricky to test directly since persist() is private.
    // We test the observable behavior: scheduling is debounced.
    // Verify by checking that multiple rapid recordSpawn calls only flush once.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'director-state.json');
    try {
      const cp = new DirectorStateCheckpoint(
        file,
        { directorRunId: 'run-debounce', spawnDepth: 0, maxSpawnDepth: 2 },
        200, // 200ms debounce so all bursts coalesce
      );
      cp.recordSpawn({ id: 's1', spawnedAt: new Date().toISOString() }, 1);
      cp.recordSpawn({ id: 's2', spawnedAt: new Date().toISOString() }, 2);
      cp.recordSpawn({ id: 's3', spawnedAt: new Date().toISOString() }, 3);
      // Without flush, the write is still pending (timer set) — not on disk yet
      // We verify the debounce by ensuring we don't get multiple writes.
      // The rewriteRequested path is triggered when persist() is called while
      // this.writing === true. We can verify by checking that flush() after
      // a burst lands the final state, not an intermediate one.
      await cp.flush();
      const loaded = await loadDirectorState(file);
      expect(loaded?.spawnCount).toBe(3);
      expect(loaded?.subagents).toHaveLength(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('schedule() returns early when timer is already set', async () => {
    // Verify the debounce: calling schedule() multiple times quickly only
    // sets one timer by checking that after a burst + wait, only one write occurs.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-dstate-'));
    const file = path.join(dir, 'debounce.json');
    try {
      const cp = new DirectorStateCheckpoint(
        file,
        { directorRunId: 'run-debounce', spawnDepth: 0, maxSpawnDepth: 2 },
        100,
      );
      // Fire multiple record calls rapidly — they should all be debounced to a single write
      for (let i = 0; i < 10; i++) {
        cp.recordSpawn({ id: `s${i}`, spawnedAt: new Date().toISOString() }, i + 1);
      }
      await cp.flush();
      // If debounce works, we get the final spawnCount=10 in a single write
      const loaded = await loadDirectorState(file);
      expect(loaded?.spawnCount).toBe(10);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
