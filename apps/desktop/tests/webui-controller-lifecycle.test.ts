import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  let nextId = 1;
  return {
    WebContentsView: class {
      readonly setBounds = vi.fn();
      readonly webContents = {
        id: nextId++,
        setWindowOpenHandler: vi.fn(),
        on: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isLoading: vi.fn(() => false),
        close: vi.fn(),
        send: vi.fn(),
        focus: vi.fn(),
        loadURL: vi.fn(() => Promise.resolve()),
        executeJavaScript: vi.fn(() => Promise.resolve()),
      };
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

function createHarness() {
  const runtime = { id: 'runtime-1', status: 'running' };
  const manager = {
    snapshot: vi.fn(() => ({ runtimes: [runtime], activeRuntimeId: runtime.id })),
    getRuntimeUrlWithToken: vi.fn(() => 'http://127.0.0.1:3000/?token=test'),
  } as unknown as DesktopRuntimeManager;
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  const mainWindow = { contentView: { addChildView, removeChildView } } as unknown as BaseWindow;
  const shellView = {
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  } as unknown as WebContentsView;
  const controller = new DesktopWebuiController({
    manager,
    trustBoundary: {} as TrustBoundary,
    getMainWindow: () => mainWindow,
    getShellView: () => shellView,
    getLocale: () => 'en',
    layoutViews: vi.fn(),
  });
  return { addChildView, controller, removeChildView };
}

describe('DesktopWebuiController production lifecycle', () => {
  it('keeps the last four-slot declaration while a background view is recycled', () => {
    const harness = createHarness();
    const entry = harness.controller.ensure('runtime-1');
    if (!entry) throw new Error('Expected runtime view');
    harness.controller.setOpenSessions('runtime-1', [
      { id: 'sess-a', title: 'A', slot: 0, active: true, running: false },
    ]);

    harness.controller.dispose(entry);

    expect(harness.controller.openSessionSnapshots()).toEqual([
      {
        runtimeId: 'runtime-1',
        sessions: [{ id: 'sess-a', title: 'A', slot: 0, active: true, running: false }],
      },
    ]);
  });

  it('keeps view ownership isolated per application instance', () => {
    const first = createHarness();
    const second = createHarness();
    first.controller.ensure('runtime-1');
    expect(first.controller.views.size).toBe(1);
    expect(second.controller.views.size).toBe(0);
  });

  it('attaches and loads the active runtime through the production controller', () => {
    const harness = createHarness();
    harness.controller.syncActive();
    const entry = harness.controller.views.get('runtime-1');
    expect(entry).toBeDefined();
    expect(harness.addChildView).toHaveBeenCalledWith(entry?.view);
    expect(entry?.view.webContents.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/?token=test',
    );
  });

  it('settles command acknowledgements and disposes the owned view', async () => {
    const harness = createHarness();
    harness.controller.syncActive();
    const entry = harness.controller.views.get('runtime-1');
    if (!entry) throw new Error('Expected runtime view');
    entry.status = { runtimeId: entry.runtimeId, status: 'ready' };
    entry.bridgeReady = true;

    const result = harness.controller.dispatch({ view: 'settings' });
    const requestId = [...harness.controller.pendingAcks.keys()][0];
    if (!requestId) throw new Error('Expected pending acknowledgement');
    harness.controller.settleAck(requestId, true);

    await expect(result).resolves.toBe(true);
    expect(harness.controller.pendingAcks.size).toBe(0);
    harness.controller.dispose(entry);
    expect(harness.controller.views.size).toBe(0);
    expect(harness.removeChildView).toHaveBeenCalledWith(entry.view);
  });
});
