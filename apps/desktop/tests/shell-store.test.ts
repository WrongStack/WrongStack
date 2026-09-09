/**
 * The shell store: what the React sidebar subscribes to.
 *
 * The old renderer kept its state in module-level `let`s and answered every
 * change by rebuilding the whole DOM, so none of this was testable. These
 * cover the parts a UI test would not reach anyway: that snapshots change
 * identity when they change (or React skips the update), that a project's
 * session list is fetched once rather than on every render, and that a failing
 * bridge call surfaces instead of vanishing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopStateSnapshot, WrongStackDesktopApi } from '../src/shared/types.js';

interface Bridge {
  api: WrongStackDesktopApi;
  emitState: (snapshot: DesktopStateSnapshot) => void;
  calls: { listProjectSessions: string[] };
}

function snapshot(over: Partial<DesktopStateSnapshot> = {}): DesktopStateSnapshot {
  return {
    activeRuntimeId: null,
    runtimes: [],
    recentProjects: [],
    registeredProjects: [],
    restoring: false,
    ...over,
  };
}

/** A bridge stub with only what the store touches. */
function installBridge(over: Partial<WrongStackDesktopApi> = {}): Bridge {
  const stateListeners: Array<(s: DesktopStateSnapshot) => void> = [];
  const calls = { listProjectSessions: [] as string[] };
  const api = {
    getState: vi.fn(async () => snapshot()),
    getWebuiStatus: vi.fn(async () => ({ runtimeId: null, status: 'idle' as const })),
    listProjectSessions: vi.fn(async (root: string) => {
      calls.listProjectSessions.push(root);
      return [
        {
          id: '2026-09-09/sess_1',
          title: 'first',
          startedAt: '2026-09-09T10:00:00.000Z',
          lastActivityAt: '2026-09-09T10:00:00.000Z',
        },
      ];
    }),
    activateRuntime: vi.fn(async (id: string) => snapshot({ activeRuntimeId: id })),
    onStateChanged: (cb: (s: DesktopStateSnapshot) => void) => {
      stateListeners.push(cb);
      return () => {};
    },
    onWebuiStatusChanged: () => () => {},
    onShellSidebarCollapsedChanged: () => () => {},
    ...over,
  } as unknown as WrongStackDesktopApi;
  (globalThis as { window?: unknown }).window = { wrongstackDesktop: api };
  return {
    api,
    calls,
    emitState: (s) => {
      for (const cb of stateListeners) cb(s);
    },
  };
}

async function loadStore() {
  vi.resetModules();
  return import('../src/renderer/src/store.js');
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe('shell store', () => {
  let store: Awaited<ReturnType<typeof loadStore>>;

  beforeEach(async () => {
    installBridge();
    store = await loadStore();
  });

  it('replaces the snapshot object on every change', async () => {
    // useSyncExternalStore compares by identity. Mutating in place would make
    // React skip the render entirely — the failure mode is a frozen sidebar.
    const before = store.getSnapshot();
    store.setFilter('alpha');
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.filter).toBe('alpha');
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    store.setFilter('a');
    store.setFilter('b');
    expect(count).toBe(2);
    off();
    store.setFilter('c');
    expect(count).toBe(2);
  });

  it('loads a project session list when the row is expanded', async () => {
    store.toggleExpanded('/repos/alpha');
    expect(store.getSnapshot().expanded.has('/repos/alpha')).toBe(true);
    await vi.waitFor(() => {
      expect(store.getSnapshot().sessions.get('/repos/alpha')?.status).toBe('ready');
    });
    expect(store.getSnapshot().sessions.get('/repos/alpha')?.entries).toHaveLength(1);
  });

  it('does not refetch a session list that is already loaded', async () => {
    const bridge = installBridge();
    store = await loadStore();
    await store.loadSessions('/repos/alpha');
    await store.loadSessions('/repos/alpha');
    await store.loadSessions('/repos/alpha');
    expect(bridge.calls.listProjectSessions).toEqual(['/repos/alpha']);

    await store.loadSessions('/repos/alpha', true);
    expect(bridge.calls.listProjectSessions).toHaveLength(2);
  });

  it('keeps the row usable when the session list cannot be read', async () => {
    installBridge({
      listProjectSessions: vi.fn(async () => {
        throw new Error('store unreadable');
      }) as unknown as WrongStackDesktopApi['listProjectSessions'],
    });
    store = await loadStore();
    await store.loadSessions('/repos/alpha');
    expect(store.getSnapshot().sessions.get('/repos/alpha')).toEqual({
      status: 'error',
      entries: [],
    });
    // A failed session list is not a shell error — the project row still works.
    expect(store.getSnapshot().error).toBeNull();
  });

  it('collapsing a row keeps the list it already loaded', async () => {
    await store.loadSessions('/repos/alpha');
    store.toggleExpanded('/repos/alpha');
    store.toggleExpanded('/repos/alpha');
    expect(store.getSnapshot().expanded.has('/repos/alpha')).toBe(false);
    expect(store.getSnapshot().sessions.get('/repos/alpha')?.entries).toHaveLength(1);
  });

  it('surfaces a failed action instead of swallowing it', async () => {
    installBridge({
      activateRuntime: vi.fn(async () => {
        throw new Error('runtime is gone');
      }) as unknown as WrongStackDesktopApi['activateRuntime'],
    });
    store = await loadStore();
    await store.actions.activate('rt-1');
    expect(store.getSnapshot().error).toBe('runtime is gone');
    expect(store.getSnapshot().busy).toBe(false);
  });

  it('clears a previous error when the next action starts', async () => {
    store.setError('stale');
    await store.actions.activate('rt-1');
    expect(store.getSnapshot().error).toBeNull();
  });

  it('applies a pushed snapshot from the main process', async () => {
    const bridge = installBridge();
    store = await loadStore();
    store.connect();
    bridge.emitState(snapshot({ activeRuntimeId: 'rt-9' }));
    expect(store.getSnapshot().desktop.activeRuntimeId).toBe('rt-9');
  });
});
