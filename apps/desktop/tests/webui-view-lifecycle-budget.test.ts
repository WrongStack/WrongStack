/**
 * At most one WebUI view exists at a time.
 *
 * `syncActive` used to release a view only when its runtime STOPPED. A view
 * for a running-but-background project stayed alive for the life of the app —
 * a full Chromium renderer process each — hidden only by setting its width to
 * zero in `layoutViews`. Ten open projects meant ten renderer processes to
 * display one, and the footprint grew with every project ever visited.
 *
 * These tests count live views directly, so they fail if the "park it at zero
 * width" behaviour ever comes back.
 */
import { describe, expect, it, vi } from 'vitest';

const created: Array<{ closed: boolean }> = [];

vi.mock('electron', () => {
  let nextId = 1;
  return {
    WebContentsView: class {
      readonly setBounds = vi.fn();
      readonly webContents: Record<string, unknown>;
      constructor() {
        const record = { closed: false };
        created.push(record);
        this.webContents = {
          id: nextId++,
          setWindowOpenHandler: vi.fn(),
          on: vi.fn(),
          isDestroyed: vi.fn(() => record.closed),
          isLoading: vi.fn(() => false),
          close: vi.fn(() => {
            record.closed = true;
          }),
          send: vi.fn(),
          focus: vi.fn(),
          loadURL: vi.fn(() => Promise.resolve()),
          executeJavaScript: vi.fn(() => Promise.resolve()),
        };
      }
    },
  };
});

vi.mock('../src/main/runtime-manager.js', () => ({
  webuiPreloadPath: vi.fn(() => '/mock/webui-preload.js'),
}));

vi.mock('../src/main/desktop-privileged-actions.js', () => ({
  authorizeDesktopAction: vi.fn(() => Promise.resolve({ allowed: true })),
}));

import type { TrustBoundary } from '@wrongstack/core/security';
import type { BaseWindow, WebContentsView } from 'electron';
import type { DesktopRuntimeManager } from '../src/main/runtime-manager.js';
import { DesktopWebuiController } from '../src/main/webui/controller.js';

interface Runtime {
  id: string;
  status: 'running' | 'starting' | 'stopped' | 'error';
}

function createHarness(runtimes: Runtime[], activeRuntimeId: string | null) {
  const state = { runtimes, activeRuntimeId };
  const manager = {
    snapshot: vi.fn(() => state),
    getRuntimeUrlWithToken: vi.fn((id: string) => `http://127.0.0.1:3000/?rt=${id}`),
  } as unknown as DesktopRuntimeManager;
  const removeChildView = vi.fn();
  const mainWindow = {
    contentView: { addChildView: vi.fn(), removeChildView },
  } as unknown as BaseWindow;
  const controller = new DesktopWebuiController({
    manager,
    trustBoundary: {} as TrustBoundary,
    getMainWindow: () => mainWindow,
    getShellView: () =>
      ({
        webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
      }) as unknown as WebContentsView,
    getLocale: () => 'en',
    layoutViews: vi.fn(),
  });
  return { controller, state, removeChildView };
}

/** Live views the controller is holding, read through its own accessor. */
function liveViewCount(controller: DesktopWebuiController): number {
  return (controller as unknown as { views: Map<string, unknown> }).views.size;
}

describe('WebUI view budget', () => {
  it('keeps one view no matter how many projects are running', () => {
    created.length = 0;
    const runtimes: Runtime[] = Array.from({ length: 10 }, (_, i) => ({
      id: `rt-${i}`,
      status: 'running',
    }));
    const { controller, state } = createHarness(runtimes, 'rt-0');

    // Visit every project in turn, as a user switching between them would.
    for (const runtime of runtimes) {
      state.activeRuntimeId = runtime.id;
      controller.syncActive();
      expect(liveViewCount(controller), `after activating ${runtime.id}`).toBe(1);
    }

    // Ten views were created over the run, but nine were released.
    expect(created).toHaveLength(10);
    expect(created.filter((view) => !view.closed)).toHaveLength(1);
  });

  it('releases the previous project view when the active one changes', () => {
    created.length = 0;
    const { controller, state } = createHarness(
      [
        { id: 'rt-a', status: 'running' },
        { id: 'rt-b', status: 'running' },
      ],
      'rt-a',
    );
    controller.syncActive();
    const first = created[0];
    expect(first?.closed).toBe(false);

    state.activeRuntimeId = 'rt-b';
    controller.syncActive();
    expect(first?.closed, 'the view for rt-a should have been closed, not hidden').toBe(true);
    expect(liveViewCount(controller)).toBe(1);
  });

  it('holds no view at all while the active runtime is still starting', () => {
    created.length = 0;
    const { controller, state } = createHarness(
      [
        { id: 'rt-a', status: 'running' },
        { id: 'rt-b', status: 'starting' },
      ],
      'rt-a',
    );
    controller.syncActive();
    expect(liveViewCount(controller)).toBe(1);

    state.activeRuntimeId = 'rt-b';
    controller.syncActive();
    // rt-b has no URL to load yet and rt-a is no longer active, so nothing is
    // held. The shell shows its own starting state over the empty stage.
    expect(liveViewCount(controller)).toBe(0);
  });

  it('detaches a released view from the window rather than leaving it parented', () => {
    created.length = 0;
    const { controller, state, removeChildView } = createHarness(
      [
        { id: 'rt-a', status: 'running' },
        { id: 'rt-b', status: 'running' },
      ],
      'rt-a',
    );
    controller.syncActive();
    state.activeRuntimeId = 'rt-b';
    controller.syncActive();
    expect(removeChildView).toHaveBeenCalledTimes(1);
  });
});
