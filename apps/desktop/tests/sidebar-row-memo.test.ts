/**
 * One project changing must re-render one row, not the list.
 *
 * This exists because the claim was once made and was not true. The shell
 * commit's message said a runtime status change "re-renders one dot rather
 * than the whole list"; at that point the row took a `ProjectNode` prop, and
 * `buildProjectTree` builds fresh node objects on every snapshot, so the prop
 * changed identity for EVERY row on EVERY change and `React.memo` never held.
 * The fix spreads primitives. Nothing measured it, so nothing would have
 * caught it coming back.
 *
 * `React.memo`'s default bailout IS a shallow equality check over props, so
 * comparing two derived prop objects is the render-count assertion — no DOM,
 * no renderer, and it cannot drift from what React actually does.
 */
import { describe, expect, it } from 'vitest';
import type { DesktopRuntimeRecord, DesktopStateSnapshot } from '../src/shared/types.js';
import { buildProjectTree, projectRowProps } from '../src/renderer/src/project-tree.js';
import type { ShellState } from '../src/renderer/src/store.js';

/** React's own memo comparison: shallow equality over the props object. */
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
}

function runtime(id: string, root: string, status: string): DesktopRuntimeRecord {
  return {
    id,
    name: root.split('/').pop() ?? root,
    root,
    slug: id,
    kind: 'webui',
    status,
    httpPort: 3000,
    wsPort: 3001,
    url: `http://127.0.0.1:3000/?rt=${id}`,
    startedAt: '2026-09-09T12:00:00.000Z',
  } as unknown as DesktopRuntimeRecord;
}

function snapshot(statuses: string[]): DesktopStateSnapshot {
  return {
    activeRuntimeId: 'rt-0',
    runtimes: statuses.map((s, i) => runtime(`rt-${i}`, `/w/p${i}`, s)),
    recentProjects: [],
    registeredProjects: [],
    restoring: false,
  } as unknown as DesktopStateSnapshot;
}

function shell(desktop: DesktopStateSnapshot, over: Partial<ShellState> = {}): ShellState {
  return {
    desktop,
    webuiStatus: { runtimeId: null, status: 'idle' },
    expanded: new Set(),
    sessions: new Map(),
    sidebarCollapsed: false,
    filter: '',
    busy: false,
    error: null,
    launcher: null,
    ...over,
  } as ShellState;
}

/** Row props for every project, keyed by root, from one shell state. */
function rows(state: ShellState): Map<string, Record<string, unknown>> {
  return new Map(
    buildProjectTree(state.desktop).map((node) => [
      node.root,
      projectRowProps(node, state) as unknown as Record<string, unknown>,
    ]),
  );
}

describe('project row memo', () => {
  it('re-renders only the project whose status changed', () => {
    const before = shell(snapshot(['running', 'running', 'running', 'running', 'running']));
    // One project stops. Everything else is untouched.
    const after = shell(snapshot(['running', 'running', 'stopped', 'running', 'running']));

    const a = rows(before);
    const b = rows(after);
    expect(a.size).toBe(5);

    const changed = [...a.keys()].filter((root) => !shallowEqual(a.get(root)!, b.get(root)!));
    expect(changed, 'exactly one row should fail memo and re-render').toHaveLength(1);
    expect(changed[0]).toContain('p2');
  });

  it('carries no object that is rebuilt per snapshot', () => {
    // The regression was a `node` prop. Guard the shape directly: every value
    // must be a primitive, with `sessions` the one documented exception —
    // whose identity stability the next case covers.
    const state = shell(snapshot(['running']));
    const props = [...rows(state).values()][0]!;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'sessions') continue;
      expect(
        value === null || typeof value !== 'object',
        `prop "${key}" is an object, so memo cannot compare it by value`,
      ).toBe(true);
    }
  });

  it('does not re-render every expanded row when one project loads its sessions', () => {
    // `loadSessions` rebuilds the sessions Map. If it did so by rebuilding the
    // ENTRY objects too, every expanded row's `sessions` prop would change
    // identity and the whole list would re-render on each load — the same bug
    // in a different prop.
    const desktop = snapshot(['running', 'running']);
    const p0 = { status: 'ready' as const, entries: [] };
    const p1 = { status: 'ready' as const, entries: [] };
    const sessions = new Map([
      ['/w/p0', p0],
      ['/w/p1', p1],
    ]);
    const before = shell(desktop, { sessions, expanded: new Set(['/w/p0', '/w/p1']) });

    // A load lands for p0 only, the way the store performs it.
    const next = new Map(sessions);
    next.set('/w/p0', { status: 'ready', entries: [] });
    const after = shell(desktop, { sessions: next, expanded: new Set(['/w/p0', '/w/p1']) });

    const a = rows(before);
    const b = rows(after);
    const changed = [...a.keys()].filter((root) => !shallowEqual(a.get(root)!, b.get(root)!));
    expect(changed, "p1's row must not re-render for p0's session load").toEqual(['/w/p0']);
  });

  it('re-renders every row when the busy flag flips, and that is correct', () => {
    // Not a bug: `busy` disables every row's controls, so every row genuinely
    // has to update. Pinned so the count is a known quantity rather than a
    // surprise when someone measures renders later.
    const desktop = snapshot(['running', 'running', 'running']);
    const a = rows(shell(desktop));
    const b = rows(shell(desktop, { busy: true }));
    const changed = [...a.keys()].filter((root) => !shallowEqual(a.get(root)!, b.get(root)!));
    expect(changed).toHaveLength(3);
  });
});
