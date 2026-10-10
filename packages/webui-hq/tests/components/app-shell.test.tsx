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
const { useToastStore } = await import('../../src/data/toast-store.js');
const { fetchJson } = await import('../../src/data/api.js');
const { snapshot } = await import('../fixtures/hq.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  // Await the lazy view's actual imports inside act. Counting timer ticks
  // does not ensure cold module loads have finished under Bun.
  await act(async () => {
    created.render(<AppShell />);
    // Cold dynamic imports do real fs work under vitest; a single tick is
    // not enough, so yield several macrotasks before act exits.
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    await vi.dynamicImportSettled();
  });
  return container;
}

/** Run an interaction inside act; give lazy-view module loads a tick to settle. */
async function interact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    await vi.dynamicImportSettled();
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  useHqStore.setState({
    snapshot: null,
    alerts: [],
    events: [],
    commandStatuses: [],
    activeView: 'cockpit',
    connected: false,
    authRequired: false,
    peerEnvelope: null,
    selectedSessionId: null,
    selectedAgentId: null,
    selectedClientId: null,
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await vi.dynamicImportSettled();
  });
  container?.remove();
  root = null;
  container = null;
  document.documentElement.classList.remove('dark');
  vi.clearAllMocks();
});

describe('view registry', () => {
  it('defines fourteen surfaces with unique ids', () => {
    expect(HQ_VIEWS).toHaveLength(14);
    expect(new Set(HQ_VIEWS.map((view) => view.id)).size).toBe(14);
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
  it('mounts and renders one nav item per surface', async () => {
    const mounted = await mount();
    expect(mounted.querySelector('[data-testid="hq-workbench"]')).not.toBeNull();
    expect(mounted.querySelectorAll('[data-testid="nav-item"]')).toHaveLength(14);
  });

  it('marks the active surface as the current page', async () => {
    const mounted = await mount();
    const current = mounted.querySelector('[data-testid="nav-item"][aria-current="page"]');
    expect(current?.getAttribute('data-view')).toBe('cockpit');
  });

  it('navigates when a nav item is clicked', async () => {
    const mounted = await mount();
    const alerts = mounted.querySelector<HTMLButtonElement>(
      '[data-testid="nav-item"][data-view="alerts"]',
    );
    await interact(() => alerts?.click());
    expect(useHqStore.getState().activeView).toBe('alerts');
  });

  it('badges unread mail and attention, and nothing else', async () => {
    const withUnread = snapshot();
    withUnread.totals.unreadMailboxMessages = 3;
    act(() => {
      useHqStore.setState({ snapshot: withUnread, alerts: [] });
    });
    const mounted = await mount();

    const badged = [...mounted.querySelectorAll('[data-testid="nav-item"]')].filter(
      (item) => item.querySelector('[data-testid="nav-badge"]') !== null,
    );
    expect(badged).toHaveLength(1);
    expect(badged[0]?.getAttribute('data-view')).toBe('mailbox');
    expect(badged[0]?.querySelector('[data-testid="nav-badge"]')?.textContent).toBe('3');
  });

  it('shows a disconnected banner only while the transport is down', async () => {
    const mounted = await mount();
    expect(mounted.querySelector('[data-testid="connection-banner"]')).not.toBeNull();

    act(() => useHqStore.getState().setConnected(true));
    expect(mounted.querySelector('[data-testid="connection-banner"]')).toBeNull();
    expect(
      mounted.querySelector('[data-testid="connection-chip"]')?.getAttribute('data-connected'),
    ).toBe('true');
  });

  it('replaces the whole surface with the gate when auth is required', async () => {
    act(() => useHqStore.getState().markAuthRequired());
    const mounted = await mount();
    expect(mounted.querySelector('[data-testid="hq-workbench"]')).toBeNull();
    expect(mounted.textContent).toContain('WrongStack HQ');
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('applies the dark class to <html>, not a bespoke attribute', async () => {
    // The token stylesheet keys on `.dark`; anything else silently theme-less.
    await mount();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('opens the command palette on Ctrl+K and jumps on selection', async () => {
    const mounted = await mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });

    const input = document.querySelector('[data-testid="command-palette-input"]');
    expect(input).not.toBeNull();

    const items = document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="command-palette-item"]',
    );
    expect(items.length).toBe(14);
    await interact(() => items[2]?.click());
    expect(useHqStore.getState().activeView).toBe(HQ_VIEWS[2]!.id);
    expect(mounted.isConnected).toBe(true);
  });

  it('jumps to a surface on its Alt+digit shortcut', async () => {
    await mount();
    await interact(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', altKey: true }));
    });
    expect(useHqStore.getState().activeView).toBe('alerts');
  });

  it('toggles the nav rail on Ctrl+B', async () => {
    const mounted = await mount();
    const rail = (): string | null =>
      mounted.querySelector('[data-testid="nav-sidebar"]')?.getAttribute('data-open') ?? null;
    const before = rail();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    });
    expect(rail()).not.toBe(before);
  });

  it('opens a bookmarked view and writes route changes from any caller', async () => {
    window.history.replaceState(null, '', '/#/cost');
    await mount();
    expect(useHqStore.getState().activeView).toBe('cost');
    await interact(() => useHqStore.getState().setActiveView('control'));
    expect(window.location.hash).toBe('#/control');
    expect(document.title).toBe('Control · WrongStack HQ');
    await interact(() => {
      window.history.replaceState(null, '', '/#/cost');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(useHqStore.getState().activeView).toBe('cost');
  });

  it('keeps connection notifications silent until a real loss/reconnect', async () => {
    useToastStore.getState().clearToasts();
    await mount();
    act(() => useHqStore.getState().setConnected(true));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    act(() => useHqStore.getState().setConnected(false));
    expect(useToastStore.getState().toasts.map((toast) => toast.severity)).toEqual(['warning']);
    act(() => useHqStore.getState().setConnected(true));
    expect(useToastStore.getState().toasts.map((toast) => toast.severity)).toEqual([
      'warning',
      'success',
    ]);
  });

  it('leaves editor shortcuts and handled key events alone', async () => {
    const mounted = await mount();
    const editor = document.createElement('textarea');
    mounted.append(editor);
    const rail = mounted.querySelector('[data-testid="nav-sidebar"]');
    const before = rail?.getAttribute('data-open');
    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }),
      );
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: '5', altKey: true, bubbles: true }));
      const handled = new KeyboardEvent('keydown', { key: '5', altKey: true, cancelable: true });
      handled.preventDefault();
      window.dispatchEvent(handled);
    });
    expect(rail?.getAttribute('data-open')).toBe(before);
    expect(useHqStore.getState().activeView).toBe('cockpit');
  });

  it('keeps bootstrap fragments out of the view router', async () => {
    window.history.replaceState(null, '', '/#bootstrap=one-time-code');
    await mount();
    expect(window.location.hash).toBe('#bootstrap=one-time-code');
    expect(useHqStore.getState().activeView).toBe('cockpit');
  });
});
