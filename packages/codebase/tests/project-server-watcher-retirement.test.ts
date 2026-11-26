import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ClientState } from '../src/project-server-types.js';
import { ProjectServerWatcherManager } from '../src/project-server-watcher.js';

type Listener = (eventType: string, filename: string) => void;
const { watches } = vi.hoisted(() => ({
  watches: [] as Array<{ handle: EventEmitter; emitFile: Listener }>,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watch: (_root: string, _options: unknown, emitFile: Listener) => {
    const handle = new EventEmitter();
    watches.push({ handle, emitFile });
    return Object.assign(handle, { close: () => handle.emit('close') });
  },
}));

it.each(['close', 'error'] as const)(
  'reopens a retired project watcher after %s',
  async (reason) => {
    vi.useFakeTimers();
    const root = resolve('watch-retirement-fixture', reason);
    const onFilesChanged = vi.fn();
    const manager = new ProjectServerWatcherManager({ projectRoot: root, onFilesChanged });
    const owners = [{ watchExternal: true, debounceMs: 1, coalesceWindowMs: 1 }] as ClientState[];
    const initialCount = watches.length;
    try {
      manager.reconcile(owners);
      const retired = watches[initialCount]!;
      retired.handle.emit(reason, new Error('watcher retired'));
      expect(manager.isWatching).toBe(false);

      manager.reconcile(owners);
      expect(watches).toHaveLength(initialCount + 2);
      watches[initialCount + 1]!.emitFile('change', 'fresh.ts');
      await vi.runAllTimersAsync();

      expect(onFilesChanged.mock.calls).toEqual([[[resolve(root, 'fresh.ts')]]]);
    } finally {
      manager.stop();
      vi.useRealTimers();
    }
  },
);
