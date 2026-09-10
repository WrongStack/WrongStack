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
import type {
  DesktopOpenSessionsSnapshot,
  DesktopStateSnapshot,
  WrongStackDesktopApi,
} from '../src/shared/types.js';

interface Bridge {
  api: WrongStackDesktopApi;
  emitState: (snapshot: DesktopStateSnapshot) => void;
  emitOpenSessions: (snapshot: DesktopOpenSessionsSnapshot) => void;
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
  const openSessionListeners: Array<(s: DesktopOpenSessionsSnapshot) => void> = [];
  const api = {
    getState: vi.fn(async () => snapshot()),
    getWebuiStatus: vi.fn(async () => ({ runtimeId: null, status: 'idle' as const })),
    getOpenSessions: vi.fn(async () => []),
    activateRuntime: vi.fn(async (id: string) => snapshot({ activeRuntimeId: id })),
    onStateChanged: (cb: (s: DesktopStateSnapshot) => void) => {
      stateListeners.push(cb);
      return () => {};
    },
    onWebuiStatusChanged: () => () => {},
    onOpenSessionsChanged: (cb: (s: DesktopOpenSessionsSnapshot) => void) => {
      openSessionListeners.push(cb);
      return () => {};
    },
    onShellSidebarCollapsedChanged: () => () => {},
    ...over,
  } as unknown as WrongStackDesktopApi;
  (globalThis as { window?: unknown }).window = { wrongstackDesktop: api };
  return {
    api,
    emitState: (s) => {
      for (const cb of stateListeners) cb(s);
    },
    emitOpenSessions: (s) => {
      for (const cb of openSessionListeners) cb(s);
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

  it('expands a project without reading archived session history', () => {
    store.toggleExpanded('/repos/alpha');
    expect(store.getSnapshot().expanded.has('/repos/alpha')).toBe(true);
    expect(store.getSnapshot().openSessions.size).toBe(0);
  });

  it('loads the current four-tab snapshots when connecting', async () => {
    installBridge({
      getOpenSessions: vi.fn(async () => [
        {
          runtimeId: 'rt-1',
          sessions: [{ id: 'sess-1', title: 'Live work', slot: 0, active: true, running: false }],
        },
      ]),
    });
    store = await loadStore();
    store.connect();
    await vi.waitFor(() => expect(store.getSnapshot().openSessions.get('rt-1')).toHaveLength(1));
  });

  it('applies live tab changes and removes an empty runtime declaration', async () => {
    const bridge = installBridge();
    store = await loadStore();
    store.connect();
    bridge.emitOpenSessions({
      runtimeId: 'rt-1',
      sessions: [{ id: 'sess-1', title: 'Live', slot: 0, active: true, running: true }],
    });
    expect(store.getSnapshot().openSessions.get('rt-1')?.[0]?.title).toBe('Live');
    bridge.emitOpenSessions({ runtimeId: 'rt-1', sessions: [] });
    expect(store.getSnapshot().openSessions.has('rt-1')).toBe(false);
  });

  it('does not let a stale initial snapshot overwrite a newer pushed tab list', async () => {
    let resolveInitial!: (value: DesktopOpenSessionsSnapshot[]) => void;
    const initial = new Promise<DesktopOpenSessionsSnapshot[]>((resolve) => {
      resolveInitial = resolve;
    });
    const bridge = installBridge({ getOpenSessions: vi.fn(() => initial) });
    store = await loadStore();
    store.connect();
    bridge.emitOpenSessions({
      runtimeId: 'rt-1',
      sessions: [{ id: 'new', title: 'New', slot: 0, active: true, running: false }],
    });
    resolveInitial([
      {
        runtimeId: 'rt-1',
        sessions: [{ id: 'old', title: 'Old', slot: 0, active: true, running: false }],
      },
    ]);

    await vi.waitFor(() =>
      expect(store.getSnapshot().openSessions.get('rt-1')?.[0]?.id).toBe('new'),
    );
  });

  it('collapsing a row keeps its live snapshot', () => {
    const bridge = installBridge();
    store.connect();
    bridge.emitOpenSessions({
      runtimeId: 'rt-1',
      sessions: [{ id: 'sess-1', title: 'Live', slot: 0, active: true, running: false }],
    });
    store.toggleExpanded('/repos/alpha');
    store.toggleExpanded('/repos/alpha');
    expect(store.getSnapshot().expanded.has('/repos/alpha')).toBe(false);
    expect(store.getSnapshot().openSessions.get('rt-1')).toHaveLength(1);
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
