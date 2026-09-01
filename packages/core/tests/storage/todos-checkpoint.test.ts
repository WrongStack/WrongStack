import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Context } from '../../src/core/context.js';
import type { EventBus } from '../../src/kernel/events.js';
import type { SessionWriter } from '../../src/types/session.js';
import {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
} from '../../src/storage/todos-checkpoint.js';

// vi.mock is hoisted above imports.  We use vi.importActual inside the factory
// to lazily get the real module, avoiding TDZ issues.  The returned plain object
// replaces 'node:fs/promises' before the second import runs.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  // In-memory store so writes and reads share state within a test.
  const store: Record<string, string> = {};

  const mockFs = {
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
      try { await real.writeFile(filepath, data, 'utf8'); } catch { /* best-effort */ }
    }),
    rename: real.rename,
    access: vi.fn(async (filepath: string) => {
      if (store[filepath] !== undefined) return;
      try { await real.access(filepath); } catch { /* fall through */ }
      if (store[filepath] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    unlink: vi.fn(async (filepath: string) => {
      delete store[filepath];
      try { await real.unlink(filepath); } catch { /* best-effort */ }
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
      try { await real.rm(filepath, opts); } catch { /* best-effort */ }
    }),
    chmod: real.chmod,
  };
  return mockFs;
});

import * as fs from 'node:fs/promises';

function makeContext(): Context {
  return new Context({
    systemPrompt: [],
    provider: {} as never,
    session: {
      id: 'sess',
      pendingToolUses: [],
      append: async () => {},
      appendBatch: async () => {},
      flush: async () => {},
      close: async () => {},
      recordFileChange: () => {},
      writeCheckpoint: async () => {},
      writeFileSnapshot: async () => {},
      truncateToCheckpoint: async () => 0,
      clearSession: async () => {},
      writeInFlightMarker: async () => {},
      clearInFlightMarker: async () => {},
    } as never as SessionWriter,
    signal: new AbortController().signal,
    tokenCounter: { total: () => ({ input: 0, output: 0 }), record: () => {} } as never,
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    model: 'test',
  });
}

async function waitForTodosCheckpoint(file: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loaded = await loadTodosCheckpoint(file);
    if (loaded) return loaded;
    await new Promise((r) => setTimeout(r, 25));
  }
  return loadTodosCheckpoint(file);
}

describe('todos-checkpoint', () => {
  it('round-trips todos through save and load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    try {
      await saveTodosCheckpoint(file, 'sess', [
        { id: 't1', content: 'first', status: 'pending' },
        { id: 't2', content: 'second', status: 'in_progress' },
      ]);
      const loaded = await loadTodosCheckpoint(file);
      expect(loaded).toEqual([
        { id: 't1', content: 'first', status: 'pending' },
        { id: 't2', content: 'second', status: 'in_progress' },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when file is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    try {
      const loaded = await loadTodosCheckpoint(path.join(dir, 'missing.json'));
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when version is wrong', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'bad.json');
    try {
      await fs.writeFile(file, JSON.stringify({ version: 999, todos: [] }));
      expect(await loadTodosCheckpoint(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('attachTodosCheckpoint persists state mutations to disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    try {
      const ctx = makeContext();
      const detach = attachTodosCheckpoint(ctx.state, file, 'sess');
      ctx.state.replaceTodos([
        { id: 'a', content: 'alpha', status: 'pending' },
      ]);
      // The save is debounced 150ms — wait then verify.
      const loaded = await waitForTodosCheckpoint(file);
      expect(loaded).toEqual([{ id: 'a', content: 'alpha', status: 'pending' }]);
      await detach();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('detach flushes pending write before unsubscribe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    try {
      const ctx = makeContext();
      const detach = attachTodosCheckpoint(ctx.state, file, 'sess');
      ctx.state.replaceTodos([
        { id: 'b', content: 'beta', status: 'completed' },
        { id: 'c', content: 'gamma', status: 'pending' },
      ]);
      // Detach immediately — the debounced write should still land.
      await detach();
      const loaded = await loadTodosCheckpoint(file);
      expect(loaded).toEqual([
        { id: 'b', content: 'beta', status: 'completed' },
        { id: 'c', content: 'gamma', status: 'pending' },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ── storage.* event tests ─────────────────────────────────────────────────

  it('detach is idempotent and preserves the final pending checkpoint', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    try {
      const ctx = makeContext();
      const detach = attachTodosCheckpoint(ctx.state, file, 'sess');
      ctx.state.replaceTodos([{ id: 'final', content: 'persist once', status: 'pending' }]);

      await Promise.all([detach(), detach()]);

      expect(await loadTodosCheckpoint(file)).toEqual([
        { id: 'final', content: 'persist once', status: 'pending' },
      ]);
      await expect(detach()).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.read with outcome success when loadTodosCheckpoint finds a valid file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await fs.writeFile(file, JSON.stringify({
        version: 1,
        sessionId: 'sess',
        updatedAt: new Date().toISOString(),
        todos: [{ id: 't1', content: 'first', status: 'pending' }],
      }));
      await loadTodosCheckpoint(file, events);
      expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'todos',
        operation: 'load',
        outcome: 'success',
        sessionId: 'sess',
      }));

      await loadTodosCheckpoint(file, events, 'trace-load', 'sess-explicit');
      expect(events.emit).toHaveBeenLastCalledWith('storage.read', expect.objectContaining({
        store: 'todos',
        operation: 'load',
        outcome: 'success',
        sessionId: 'sess-explicit',
        traceId: 'trace-load',
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.read with outcome failure when loadTodosCheckpoint finds invalid schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'bad.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      // version 999 is not valid — filter rejects it
      await fs.writeFile(file, JSON.stringify({
        version: 999,
        sessionId: 'sess',
        updatedAt: new Date().toISOString(),
        todos: [],
      }));
      await loadTodosCheckpoint(file, events);
      expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'todos',
        operation: 'load',
        outcome: 'failure',
        error: 'invalid_schema',
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not raise storage.error when the checkpoint was never written', async () => {
    // ENOENT is the normal state of a session that never used the todo list.
    // `storage.error` is the alert channel for disk-full/permission faults and
    // is always logged at warning level, so sending ENOENT there produced a
    // WARN on every boot and resume.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const events: EventBus = { emit: vi.fn() } as never;
    const file = path.join(dir, 'never-written.todos.json');

    const result = await loadTodosCheckpoint(file, events, 'trace-enoent', 'sess-enoent');

    expect(result).toBeNull();
    expect(events.emit).not.toHaveBeenCalledWith('storage.error', expect.anything());
    expect(events.emit).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        sessionId: 'sess-enoent',
        traceId: 'trace-enoent',
        store: 'todos',
        operation: 'load',
        outcome: 'success',
      }),
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('emits storage.error when loadTodosCheckpoint encounters a disk I/O error', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'io-error.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    // Create the file so it exists, then make readFile fail
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      sessionId: 'sess',
      updatedAt: new Date().toISOString(),
      todos: [],
    }));
    try {
      vi.mocked(fs.readFile).mockRejectedValueOnce(
        Object.assign(new Error('EACCES permission denied'), { code: 'EACCES' }),
      );
      const result = await loadTodosCheckpoint(file, events, 'trace-load', 'sess-load');
      expect(result).toBeNull();
      expect(events.emit).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        sessionId: 'sess-load',
        traceId: 'trace-load',
        store: 'todos',
        operation: 'load',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      vi.mocked(fs.readFile).mockReset();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.write with outcome success when saveTodosCheckpoint succeeds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await saveTodosCheckpoint(
        file,
        'sess',
        [{ id: 't1', content: 'first', status: 'pending' }],
        events,
      );
      expect(events.emit).toHaveBeenCalledWith('storage.write', expect.objectContaining({
        store: 'todos',
        operation: 'save',
        outcome: 'success',
        sessionId: 'sess',
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.error when saveTodosCheckpoint encounters a write failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'io-error.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      vi.mocked(fs.writeFile).mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }),
      );
      await saveTodosCheckpoint(
        file,
        'sess',
        [{ id: 't1', content: 'first', status: 'pending' }],
        events,
        'trace-save',
      );
      expect(events.emit).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        sessionId: 'sess',
        traceId: 'trace-save',
        store: 'todos',
        operation: 'save',
        outcome: 'failure',
        error: expect.stringContaining('ENOSPC'),
      }));
    } finally {
      vi.mocked(fs.writeFile).mockReset();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
