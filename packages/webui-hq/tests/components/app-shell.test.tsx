/**
 * Shell contract.
 *
 * Mounts the real shell once, so an unstable zustand selector cannot regress
 * into a getSnapshot / update-depth crash unnoticed, and pins the operator
 * navigation model: twelve surfaces, unique ids, non-conflicting shortcuts,
 * and badges that surface work without the operator opening each view.
 *
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shell fetches auth status and the update check on mount; neither should
// reach the network in a unit test.
vi.mock('../../src/data/api.js', () => ({
  fetchJson: vi.fn(() => Promise.reject(new Error('offline'))),
  authorizedFetch: vi.fn(() => Promise.resolve(new Response('{}'))),
  postCommand: vi.fn(),
  postMailboxSend: vi.fn(),
}));

const { AppShell } = await import('../../src/components/hq/app-shell.js');
const { getHqView, HQ_VIEWS, searchHqViews } = await import('../../src/components/hq/views.js');
const { useHqStore } = await import('../../src/data/store/index.js');
const { snapshot } = await import('../fixtures/hq.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  act(() => created.render(<AppShell />));
  return container;
}

beforeEach(() => {
  useHqStore.setState({
    snapshot: null,
    alerts: [],
    events: [],
    commandStatuses: [],
    activeView: 'cockpit',
    connected: false,
    authRequired: false,
    peerEnvelope: null,
  });
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.documentElement.classList.remove('dark');
  vi.clearAllMocks();
});

describe('view registry', () => {
  it('defines twelve surfaces with unique ids', () => {
    expect(HQ_VIEWS).toHaveLength(12);
    expect(new Set(HQ_VIEWS.map((view) => view.id)).size).toBe(12);
  });

  it('assigns ten non-conflicting numeric shortcuts', () => {
    const shortcuts = HQ_VIEWS.flatMap((view) =>
      view.shortcut === undefined ? [] : [view.shortcut],
    );
    expect(shortcuts).toHaveLength(10);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('places every surface in one of the three groups', () => {
    for (const view of HQ_VIEWS) {
      expect(['Operations', 'Intelligence', 'System']).toContain(view.group);
    }
  });

  it('falls back to the cockpit for an unknown id', () => {
    expect(getHqView('nope' as never).id).toBe('cockpit');
  });

  it('searches labels, eyebrows, descriptions and groups', () => {
    expect(searchHqViews('').length).toBe(HQ_VIEWS.length);
    expect(searchHqViews('topology').map((view) => view.id)).toEqual(['fleet']);
    expect(searchHqViews('  TOPOLOGY ').map((view) => view.id)).toEqual(['fleet']);
    expect(searchHqViews('zzz-no-match')).toHaveLength(0);
  });
});

describe('AppShell', () => {
  it('mounts and renders one nav item per surface', () => {
    const mounted = mount();
    expect(mounted.querySelector('[data-testid="hq-workbench"]')).not.toBeNull();
    expect(mounted.querySelectorAll('[data-testid="nav-item"]')).toHaveLength(12);
  });

  it('marks the active surface as the current page', () => {
    const mounted = mount();
    const current = mounted.querySelector('[data-testid="nav-item"][aria-current="page"]');
    expect(current?.getAttribute('data-view')).toBe('cockpit');
  });

  it('navigates when a nav item is clicked', () => {
    const mounted = mount();
    const alerts = mounted.querySelector<HTMLButtonElement>(
      '[data-testid="nav-item"][data-view="alerts"]',
    );
    act(() => alerts?.click());
    expect(useHqStore.getState().activeView).toBe('alerts');
  });

  it('badges unread mail and attention, and nothing else', () => {
    const withUnread = snapshot();
    withUnread.totals.unreadMailboxMessages = 3;
    act(() => {
      useHqStore.setState({ snapshot: withUnread, alerts: [] });
    });
    const mounted = mount();

    const badged = [...mounted.querySelectorAll('[data-testid="nav-item"]')].filter(
      (item) => item.querySelector('[data-testid="nav-badge"]') !== null,
    );
    expect(badged).toHaveLength(1);
    expect(badged[0]?.getAttribute('data-view')).toBe('mailbox');
    expect(badged[0]?.querySelector('[data-testid="nav-badge"]')?.textContent).toBe('3');
  });

  it('shows a disconnected banner only while the transport is down', () => {
    const mounted = mount();
    expect(mounted.querySelector('[data-testid="connection-banner"]')).not.toBeNull();

    act(() => useHqStore.getState().setConnected(true));
    expect(mounted.querySelector('[data-testid="connection-banner"]')).toBeNull();
    expect(
      mounted.querySelector('[data-testid="connection-chip"]')?.getAttribute('data-connected'),
    ).toBe('true');
  });

  it('replaces the whole surface with the gate when auth is required', () => {
    act(() => useHqStore.getState().markAuthRequired());
    const mounted = mount();
    expect(mounted.querySelector('[data-testid="hq-workbench"]')).toBeNull();
    expect(mounted.textContent).toContain('WrongStack HQ');
  });

  it('applies the dark class to <html>, not a bespoke attribute', () => {
    // The token stylesheet keys on `.dark`; anything else silently theme-less.
    mount();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('opens the command palette on Ctrl+K and jumps on selection', () => {
    const mounted = mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });

    const input = document.querySelector('[data-testid="command-palette-input"]');
    expect(input).not.toBeNull();

    const items = document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="command-palette-item"]',
    );
    expect(items.length).toBe(12);
    act(() => items[2]?.click());
    expect(useHqStore.getState().activeView).toBe(HQ_VIEWS[2]!.id);
    expect(mounted.isConnected).toBe(true);
  });

  it('jumps to a surface on its Alt+digit shortcut', () => {
    mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', altKey: true }));
    });
    expect(useHqStore.getState().activeView).toBe('alerts');
  });

  it('toggles the nav rail on Ctrl+B', () => {
    const mounted = mount();
    const rail = (): string | null =>
      mounted.querySelector('[data-testid="nav-sidebar"]')?.getAttribute('data-open') ?? null;
    const before = rail();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    });
    expect(rail()).not.toBe(before);
  });
});
