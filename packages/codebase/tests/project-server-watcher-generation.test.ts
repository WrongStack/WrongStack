import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ClientState } from '../src/project-server-types.js';
import { ProjectServerWatcherManager } from '../src/project-server-watcher.js';

type Listener = (event: { eventType: 'rename' | 'change'; filename: string }) => void;
const { listeners, stat } = vi.hoisted(() => ({
  listeners: [] as Listener[],
  stat: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ stat }));
vi.mock('@wrongstack/core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/core/utils')>()),
  watchProjectTree: (_root: string, listener: Listener) => {
    listeners.push(listener);
    return { close() {} };
  },
}));

it('discards a directory probe that finishes after its watcher is replaced', async () => {
  vi.useFakeTimers();
  const projectRoot = resolve('fixture-project');
  const onFilesChanged = vi.fn();
  const manager = new ProjectServerWatcherManager({ projectRoot, onFilesChanged });
  const owners = [{ watchExternal: true, debounceMs: 1, coalesceWindowMs: 1 }] as ClientState[];
  const probe = Promise.withResolvers<{ isDirectory(): boolean }>();
  stat.mockReturnValueOnce(probe.promise);
  try {
    manager.reconcile(owners);
    listeners[0]!({ eventType: 'rename', filename: 'old-dir' });
    expect(stat).toHaveBeenCalledOnce();
    manager.stop();
    manager.reconcile(owners);
    probe.resolve({ isDirectory: () => true });
    listeners[1]!({ eventType: 'change', filename: 'current.ts' });
    await vi.runAllTimersAsync();

    expect(onFilesChanged.mock.calls).toEqual([[[resolve(projectRoot, 'current.ts')]]]);
  } finally {
    manager.stop();
    vi.useRealTimers();
  }
});
