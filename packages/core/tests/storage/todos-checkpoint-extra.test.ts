import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
} from '../../src/storage/todos-checkpoint.js';
import type { TodoItem } from '../../src/types/todos.js';

// Covers loadTodosCheckpoint's parse-failure branch (valid read, invalid JSON).

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-cp-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('todos-checkpoint — extra coverage', () => {
  it('emits storage.read parse_failed and returns null on invalid JSON', async () => {
    const events = { emit: vi.fn() };
    const fp = path.join(dir, 'todos.json');
    await fs.writeFile(fp, '{ not valid json', 'utf8');
    expect(await loadTodosCheckpoint(fp, events as never, 'tr-1')).toBeNull();
    const read = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.read' && (c[1] as { error?: string }).error === 'parse_failed',
    );
    expect(read).toBeDefined();
    expect((read![1] as { traceId?: string }).traceId).toBe('tr-1');
  });

  it('saveTodosCheckpoint emits storage.write success', async () => {
    const events = { emit: vi.fn() };
    const fp = path.join(dir, 'save.json');
    const todos: TodoItem[] = [{ id: '1', content: 'do', status: 'pending' }];
    await saveTodosCheckpoint(fp, 'sess', todos, events as never, 'tr-2');
    expect(
      events.emit.mock.calls.some(
        (c) => c[0] === 'storage.write' && (c[1] as { outcome?: string }).outcome === 'success',
      ),
    ).toBe(true);
    expect(await loadTodosCheckpoint(fp)).toEqual(todos);
  });

  it('attachTodosCheckpoint debounces todos_replaced changes to disk and flushes on detach', async () => {
    const events = { emit: vi.fn() };
    const fp = path.join(dir, 'attach.json');
    let cb: ((change: { kind: string; todos?: TodoItem[] }) => void) | undefined;
    const state = {
      onChange: (fn: typeof cb) => {
        cb = fn;
        return () => {
          cb = undefined;
        };
      },
    };
    const detach = attachTodosCheckpoint(state as never, fp, 'sess', events as never);

    // Non-todos_replaced change → ignored (early return).
    cb?.({ kind: 'message_added' });
    // Two rapid todos_replaced changes: the second clears the first's pending
    // timer (debounce coalescing) before it fires.
    cb?.({ kind: 'todos_replaced', todos: [{ id: '0', content: 'first', status: 'pending' }] });
    cb?.({ kind: 'todos_replaced', todos: [{ id: '1', content: 'a', status: 'pending' }] });
    // Wait for the 150ms debounce timer to fire on its own.
    await vi.waitFor(
      async () => {
        expect(await loadTodosCheckpoint(fp)).toHaveLength(1);
      },
      { timeout: 2000 },
    );

    // A second change then immediate detach exercises the detach flush path.
    cb?.({
      kind: 'todos_replaced',
      todos: [
        { id: '1', content: 'a', status: 'pending' },
        { id: '2', content: 'b', status: 'pending' },
      ],
    });
    await detach();
    expect(await loadTodosCheckpoint(fp)).toHaveLength(2);
  });
});
