import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../src/kernel/events.js';
import { isSessionError } from '../../src/types/errors.js';
import { emptyTaskFile, loadTasks, mutateTasks, saveTasks } from '../../src/storage/task-store.js';

// vi.mock is hoisted above imports.  We use vi.importActual inside the factory
// to lazily get the real module, avoiding TDZ issues.  The returned plain object
// replaces 'node:fs/promises' before the second import runs.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  // In-memory store so writes and reads share state within a test.
  const store: Record<string, string> = {};

  const mockFs = {
    // Fall through to the real module for everything not overridden below
    // (open, stat, …). `mutateTasks` goes through withFileLock/atomicWrite,
    // which lock + stat real files in the real temp dirs these tests use.
    ...real,
    mkdtemp: async (prefix: string) => {
      const dir = await real.mkdtemp(prefix);
      store[dir] = '';
      return dir;
    },
    readFile: vi.fn(async (filepath: string) => {
      if (store[filepath] !== undefined) return store[filepath];
      return await real.readFile(filepath, 'utf8');
    }),
    writeFile: vi.fn(async (filepath: string, data: string) => {
      store[filepath] = data;
      try {
        await real.writeFile(filepath, data, 'utf8');
      } catch {
        /* best-effort */
      }
    }),
    rename: real.rename,
    access: vi.fn(async (filepath: string) => {
      if (store[filepath] !== undefined) return;
      try {
        await real.access(filepath);
      } catch {
        /* fall through */
      }
      if (store[filepath] === undefined)
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    unlink: vi.fn(async (filepath: string) => {
      delete store[filepath];
      try {
        await real.unlink(filepath);
      } catch {
        /* best-effort */
      }
    }),
    mkdir: real.mkdir,
    readdir: real.readdir,
    rm: vi.fn(async (filepath: string, opts?: { recursive?: boolean; force?: boolean }) => {
      if (opts?.recursive) {
        for (const key of Object.keys(store)) {
          if (key.startsWith(filepath)) delete store[key];
        }
      } else {
        delete store[filepath];
      }
      try {
        await real.rm(filepath, opts);
      } catch {
        /* best-effort */
      }
    }),
    chmod: real.chmod,
  };
  return mockFs;
});

import * as fsp from 'node:fs/promises';

function makeTask(
  overrides: Partial<import('../../src/utils/task-format.js').TaskItem> = {},
): import('../../src/utils/task-format.js').TaskItem {
  return {
    id: 't1',
    title: 'Test task',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('task-store', () => {
  // ── Basic persistence tests ────────────────────────────────────────────────

  it('round-trips tasks through save and load', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'sess.tasks.json');
    try {
      const taskFile: import('../../src/storage/task-store.js').TaskFile = {
        ...emptyTaskFile('sess'),
        tasks: [makeTask({ id: 't1', title: 'first' }), makeTask({ id: 't2', title: 'second' })],
      };
      await saveTasks(fp, taskFile);
      const loaded = await loadTasks(fp);
      expect(loaded?.tasks).toHaveLength(2);
      expect(loaded?.tasks[0]?.title).toBe('first');
      expect(loaded?.tasks[1]?.title).toBe('second');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadTasks returns null when file is missing', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    try {
      const loaded = await loadTasks(path.join(dir, 'missing.json'));
      expect(loaded).toBeNull();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadTasks returns null when version is wrong', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'bad.json');
    try {
      await fsp.writeFile(
        fp,
        JSON.stringify({
          version: 999,
          sessionId: 'sess',
          updatedAt: new Date().toISOString(),
          tasks: [],
        }),
        'utf8',
      );
      expect(await loadTasks(fp)).toBeNull();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadTasks returns null when file is not valid JSON', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'bad.json');
    try {
      await fsp.writeFile(fp, 'not-json{', 'utf8');
      expect(await loadTasks(fp)).toBeNull();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('mutateTasks creates a new file when none exists', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'new.tasks.json');
    try {
      const result = await mutateTasks(fp, 'sess', (file) => {
        file.tasks.push(makeTask({ id: 't1', title: 'created' }));
        return file;
      });
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.title).toBe('created');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('mutateTasks updates an existing file', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'sess.tasks.json');
    try {
      await saveTasks(fp, {
        ...emptyTaskFile('sess'),
        tasks: [makeTask({ id: 't1', title: 'original' })],
      });
      const result = await mutateTasks(fp, 'sess', (file) => {
        file.tasks[0]!.title = 'updated';
        return file;
      });
      expect(result.tasks[0]?.title).toBe('updated');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('mutateTasks rejects omission of unfinished task coverage', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'coverage.tasks.json');
    try {
      await saveTasks(fp, {
        ...emptyTaskFile('sess'),
        tasks: [makeTask({ id: 'open-task', status: 'pending' })],
      });
      await expect(mutateTasks(fp, 'sess', (file) => ({ ...file, tasks: [] }))).rejects.toThrow(
        'unfinished tasks cannot be omitted',
      );
      expect((await loadTasks(fp))?.tasks.map((task) => task.id)).toEqual(['open-task']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('mutateTasks rejects active task status while a dependency is unfinished', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'dependencies.tasks.json');
    try {
      await saveTasks(fp, {
        ...emptyTaskFile('sess'),
        tasks: [
          makeTask({ id: 'dependency', status: 'pending' }),
          makeTask({ id: 'dependent', status: 'pending', dependsOn: ['dependency'] }),
        ],
      });
      await expect(
        mutateTasks(fp, 'sess', (file) => {
          file.tasks[1]!.status = 'in_progress';
          return file;
        }),
      ).rejects.toThrow('before dependencies complete');
      expect((await loadTasks(fp))?.tasks[1]?.status).toBe('pending');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  // ── storage.* event tests ─────────────────────────────────────────────────

  it('emits storage.read with outcome success when loadTasks finds a valid file', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'sess.tasks.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await fsp.writeFile(
        fp,
        JSON.stringify({
          version: 1,
          sessionId: 'sess',
          updatedAt: new Date().toISOString(),
          tasks: [makeTask()],
        }),
        'utf8',
      );
      await loadTasks(fp, events);
      expect(events.emit).toHaveBeenCalledWith(
        'storage.read',
        expect.objectContaining({
          store: 'tasks',
          operation: 'load',
          outcome: 'success',
          sessionId: '~boot~',
        }),
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.read with outcome failure when loadTasks finds invalid schema', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'bad.tasks.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await fsp.writeFile(
        fp,
        JSON.stringify({
          version: 999,
          sessionId: 'sess',
          updatedAt: new Date().toISOString(),
          tasks: [],
        }),
        'utf8',
      );
      await loadTasks(fp, events);
      expect(events.emit).toHaveBeenCalledWith(
        'storage.read',
        expect.objectContaining({
          store: 'tasks',
          operation: 'load',
          outcome: 'failure',
          error: 'invalid_schema',
        }),
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.read with outcome failure when loadTasks finds malformed JSON', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'bad.tasks.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await fsp.writeFile(fp, 'not-json{', 'utf8');
      await loadTasks(fp, events);
      expect(events.emit).toHaveBeenCalledWith(
        'storage.read',
        expect.objectContaining({
          store: 'tasks',
          operation: 'load',
          outcome: 'failure',
          error: 'parse_failed',
        }),
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.error when loadTasks encounters a disk I/O error', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'io-error.tasks.json');
    const events: EventBus = { emit: vi.fn() } as never;
    // First ensure the file exists (so the error is a read error, not ENOENT)
    await fsp.writeFile(
      fp,
      JSON.stringify({
        version: 1,
        sessionId: 'sess',
        updatedAt: new Date().toISOString(),
        tasks: [],
      }),
      'utf8',
    );
    try {
      vi.mocked(fsp.readFile).mockRejectedValueOnce(
        Object.assign(new Error('EACCES permission denied'), { code: 'EACCES' }),
      );
      const result = await loadTasks(fp, events);
      expect(result).toBeNull();
      expect(events.emit).toHaveBeenCalledWith(
        'storage.error',
        expect.objectContaining({
          store: 'tasks',
          operation: 'load',
          outcome: 'failure',
          error: expect.stringContaining('EACCES'),
        }),
      );
    } finally {
      vi.mocked(fsp.readFile).mockReset();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.write with outcome success when saveTasks succeeds', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'sess.tasks.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await saveTasks(fp, { ...emptyTaskFile('sess'), tasks: [makeTask()] }, events);
      expect(events.emit).toHaveBeenCalledWith(
        'storage.write',
        expect.objectContaining({
          store: 'tasks',
          operation: 'save',
          outcome: 'success',
          sessionId: '~boot~',
        }),
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.error when saveTasks encounters a write failure', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'io-error.tasks.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      vi.mocked(fsp.writeFile).mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }),
      );
      await saveTasks(fp, { ...emptyTaskFile('sess'), tasks: [makeTask()] }, events);
      expect(events.emit).toHaveBeenCalledWith(
        'storage.error',
        expect.objectContaining({
          store: 'tasks',
          operation: 'save',
          outcome: 'failure',
          error: expect.stringContaining('ENOSPC'),
        }),
      );
    } finally {
      vi.mocked(fsp.writeFile).mockReset();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits both storage.read and storage.write when mutateTasks succeeds', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-'));
    const fp = path.join(dir, 'sess.tasks.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await saveTasks(
        fp,
        { ...emptyTaskFile('sess'), tasks: [makeTask({ id: 't1', title: 'before' })] },
        events,
      );
      events.emit = vi.fn(); // reset after save's emissions
      await mutateTasks(
        fp,
        'sess',
        (file) => {
          file.tasks[0]!.title = 'after';
          return file;
        },
        events,
      );
      const reads = (events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === 'storage.read',
      );
      const writes = (events.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === 'storage.write',
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]![1]).toMatchObject({ store: 'tasks', operation: 'load', outcome: 'success' });
      expect(writes).toHaveLength(1);
      expect(writes[0]![1]).toMatchObject({
        store: 'tasks',
        operation: 'save',
        outcome: 'success',
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('mutateTasks throws a structured SessionError when persistence fails', async () => {
    // Same "directory-at-target" trick as plan-store.test.ts: create a
    // directory at the file path saveTasks would write to, so atomicWrite
    // fails and saveTasks returns false. mutateTasks must surface the
    // structured SessionError, not a bare Error.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-tasks-bad-'));
    const fileAsDir = path.join(dir, 'tasks.json');
    await fsp.mkdir(fileAsDir, { recursive: true });
    try {
      let caught: unknown;
      try {
        await mutateTasks(fileAsDir, 'session-x', (f) => {
          f.tasks.push({ id: 'x', content: 'should not save', status: 'pending' });
          return f;
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isSessionError(caught)).toBe(true);
      const se = caught as ReturnType<typeof isSessionError> & {
        code: string;
        context?: Record<string, unknown>;
        sessionId?: string;
      };
      expect(se.code).toBe('SESSION_WRITE_FAILED');
      expect(se.context?.operation).toBe('mutateTasks');
      expect(se.sessionId).toBe('session-x');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
