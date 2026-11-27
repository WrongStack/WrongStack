/**
 * Keyboard dismissal for the hand-built Plugin UI overlays. They declare
 * role="dialog" themselves, so nothing supplies the Escape behavior a native
 * dialog would give; this suite pins that contract without a backend.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (msg: { payload: Record<string, unknown> }) => void>(),
  send: vi.fn(() => true),
}));
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    on: (type: string, fn: (msg: { payload: Record<string, unknown> }) => void) => {
      mock.handlers.set(type, fn);
      return () => mock.handlers.delete(type);
    },
    send: mock.send,
  }),
}));
vi.mock('@/stores', () => ({
  useConfigStore: (sel: (s: { wsStatus: { state: string } }) => unknown) =>
    sel({ wsStatus: { state: 'closed' } }),
}));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/portable-command-rpc', () => ({
  invokePortableCommand: vi.fn(async () => ({
    message: JSON.stringify({ panels: [], statusChips: [] }),
  })),
}));
vi.mock('@/components/Toaster', () => ({
  toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@wrongstack/project-surfaces/plugin-ui', () => ({
  PluginStatusChipsBar: () => null,
  PluginViewNodeRenderer: () => null,
}));

import { openPluginUiModal, PluginUiBarAndModal } from '../../src/components/PluginUiModal';

async function open() {
  render(<PluginUiBarAndModal />);
  await act(async () => {
    expect(openPluginUiModal()).toBe(true);
  });
  await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
}

beforeEach(() => {
  mock.handlers.clear();
  mock.send.mockClear();
});

describe('PluginUiModal keyboard dismissal', () => {
  it('opens a named custom dialog from the imperative opener', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'Plugin Panels' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'common:pluginPanels.close' })).toBeTruthy();
  });

  it('Escape dismisses the open dialog', async () => {
    await open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape cancels a stacked prompt and answers the plugin', () => {
    render(<PluginUiBarAndModal />);
    act(() =>
      mock.handlers.get('plugin.ui.prompt')?.({
        payload: { requestId: 'p1', owner: 'demo', kind: 'confirm', title: 'Question' },
      }),
    );
    expect(screen.getByRole('dialog', { name: 'Question' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mock.send).toHaveBeenCalledWith({
      type: 'plugin.ui.prompt_response',
      payload: { requestId: 'p1', value: null },
    });
  });
});
