import * as path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  locks: new Map<string, Promise<void>>(),
  mtime: undefined as number | undefined,
  /** One-shot read failure for the next lease read (e.g. 'EBUSY'). */
  readFault: undefined as string | undefined,
}));
function missing() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}
vi.mock('node:fs/promises', () => ({
  mkdir: async (dir: string) => {
    for (let current = dir; ; current = path.dirname(current)) {
      fixture.dirs.add(current);
      if (path.dirname(current) === current) break;
    }
  },
  open: async (file: string) => {
    if (fixture.files.has(file)) throw Object.assign(new Error('owned'), { code: 'EEXIST' });
    fixture.files.set(file, '');
    return {
      writeFile: async (value: string) => {
        fixture.files.set(file, value);
      },
      sync: async () => {},
      close: async () => {},
    };
  },
  readFile: async (file: string) => {
    if (fixture.readFault && file.endsWith('.active-run.lock')) {
      const code = fixture.readFault;
      fixture.readFault = undefined;
      throw Object.assign(new Error(code), { code });
    }
    const value = fixture.files.get(file);
    if (value === undefined) throw missing();
    return value;
  },
  unlink: async (file: string) => {
    if (!fixture.files.delete(file)) throw missing();
  },
  stat: async (file: string) => {
    if (!fixture.files.has(file)) throw missing();
    return { mtimeMs: fixture.mtime ?? Date.now() };
  },
  readdir: async (dir: string) => {
    if (!fixture.dirs.has(dir)) throw missing();
    return [...fixture.dirs]
      .filter((entry) => path.dirname(entry) === dir)
      .map((entry) => ({ name: path.basename(entry), isDirectory: () => true }));
  },
}));
vi.mock('../../core/src/utils/atomic-write.js', () => ({
  withFileLock: async (key: string, fn: () => Promise<unknown>) => {
    const previous = fixture.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    fixture.locks.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (fixture.locks.get(key) === tail) fixture.locks.delete(key);
    }
  },
  atomicWrite: vi.fn(),
}));
const { PhaseStore } = await import('../src/phase-store.js');
beforeEach(() => {
  fixture.files.clear();
  fixture.dirs.clear();
  fixture.locks.clear();
  fixture.mtime = undefined;
  fixture.readFault = undefined;
});
const store = () => new PhaseStore({ baseDir: path.resolve('virtual-goal-admission') });

it('admits separate goals while refusing duplicate owners and project maintenance', async () => {
  const goals = store();
  const releaseA = await goals.acquireGoalRunLease('a', 'owner-a');
  const releaseB = await goals.acquireGoalRunLease('b', 'owner-b');
  await expect(goals.acquireGoalRunLease('a', 'duplicate')).rejects.toThrow('Another Goal run');
  await expect(goals.acquireRunLease('maintenance')).rejects.toThrow('Another Goal run');
  await releaseA();
  await expect(goals.acquireRunLease('maintenance')).rejects.toThrow('Another Goal run');
  await releaseB();
  const releaseMaintenance = await goals.acquireRunLease('maintenance');
  await expect(goals.acquireGoalRunLease('c', 'owner-c')).rejects.toThrow('maintenance');
  await releaseMaintenance();
  await (await goals.acquireGoalRunLease('c', 'owner-c'))();
});

it('serializes the maintenance check and goal claim so exactly one wins admission', async () => {
  const goals = store();
  const results = await Promise.allSettled([
    goals.acquireRunLease('maintenance'),
    goals.acquireGoalRunLease('a', 'owner-a'),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  for (const result of results) if (result.status === 'fulfilled') await result.value();
});

it('refuses unknown ownership and permits a known dead owner to be reclaimed', async () => {
  const goals = store();
  const release = await goals.acquireGoalRunLease('a', 'owner-a');
  const file = [...fixture.files.keys()].find((key) => key.endsWith('.active-run.lock'))!;
  fixture.files.set(file, 'incomplete');
  await expect(goals.acquireRunLease('maintenance')).rejects.toThrow('unknown lease owner');
  fixture.files.set(
    file,
    JSON.stringify({ ownerId: 'dead', pid: -1, acquiredAt: new Date().toISOString() }),
  );
  const releaseMaintenance = await goals.acquireRunLease('maintenance');
  await releaseMaintenance();
  await release();
});

it('never reclaims a live lease that is only unreadable for a moment', async () => {
  // An unreadable lease looked like a torn write; past the grace window it was
  // unlinked and a second Goal run admitted against the same project.
  const goals = store();
  const release = await goals.acquireRunLease('owner-a');
  const file = [...fixture.files.keys()].find((key) => key.endsWith('.active-run.lock'))!;
  const before = fixture.files.get(file);
  fixture.mtime = Date.now() - 3_600_000;
  fixture.readFault = 'EBUSY';
  await expect(goals.acquireRunLease('owner-b')).rejects.toThrow('Another Goal run');
  expect(fixture.files.get(file)).toBe(before);
  await release();
});

it('self-heals a torn lease file once the grace window elapses', async () => {
  const goals = store();
  const release = await goals.acquireGoalRunLease('a', 'owner-a');
  const file = [...fixture.files.keys()].find((key) => key.endsWith('.active-run.lock'))!;
  fixture.files.set(file, 'incomplete');
  fixture.mtime = Date.now() - 60_000;
  const releaseMaintenance = await goals.acquireRunLease('maintenance');
  await releaseMaintenance();
  await release();
});
