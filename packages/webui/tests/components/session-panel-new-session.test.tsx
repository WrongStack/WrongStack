import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const newSession = vi.hoisted(() => vi.fn());
const updatePrefs = vi.hoisted(() => vi.fn());
const switchAutonomy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    client: { newSession },
    updatePrefs,
    switchAutonomy,
  }),
}));

vi.mock('@/components/CommandPalette', () => ({
  downloadChatAsMarkdown: vi.fn(),
}));

import { ConfirmModalHost, useConfirmModalStore } from '../../src/components/ConfirmModal.js';
import { SessionPanel } from '../../src/components/SidePanel/SessionPanel.js';
import {
  useChatStore,
  useConfigStore,
  useFleetStore,
  useSessionStore,
  useUIStore,
} from '../../src/stores/index.js';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store.js';

/** The panel now hands off to the system-prompt picker, which owns the actual
 *  `session.new` send once the user confirms a variant. These tests therefore
 *  assert the hand-off, and `SystemPromptDialog`'s own tests cover the send. */
const pickerState = () => useSystemPromptStore.getState();

function renderPanel() {
  return render(
    <>
      <SessionPanel />
      <ConfirmModalHost />
    </>,
  );
}

describe('SessionPanel — New session confirmation', () => {
  beforeEach(() => {
    newSession.mockClear();
    updatePrefs.mockClear();
    switchAutonomy.mockClear();

    act(() => {
      useConfirmModalStore.setState({ request: null });
      useChatStore.setState({ isLoading: false, messages: [] });
      useConfigStore.setState({
        wsConnected: true,
        wsUrl: 'ws://127.0.0.1:3457',
        provider: 'openai',
        model: 'gpt-5',
      });
      useFleetStore.setState({ agents: new Map() });
      useSessionStore.setState({
        session: null,
        totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        iteration: null,
        todos: [],
        lastInputTokens: 0,
        maxContext: 0,
      });
      useUIStore.setState({ currentView: 'settings', sidebarOpen: false });
      useSystemPromptStore.setState({ pickerOpen: false, pickerStartsSession: false });
    });
  });

  afterEach(() => cleanup());

  it('opens the system-prompt picker immediately while idle', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New session' }));

    expect(pickerState().pickerOpen).toBe(true);
    // `startsSession` is what makes the picker's confirm button start the
    // session rather than only applying the variant.
    expect(pickerState().pickerStartsSession).toBe(true);
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('keeps the running job when the user cancels', async () => {
    useChatStore.setState({ isLoading: true });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New session' }));

    const dialog = await screen.findByRole('dialog', { name: 'Are you sure?' });
    expect(
      within(dialog).getByText('A job is still in progress. Start a new session anyway?'),
    ).toBeDefined();
    expect(newSession).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(newSession).not.toHaveBeenCalled();
    expect(pickerState().pickerOpen).toBe(false);
    expect(useUIStore.getState().currentView).toBe('settings');
  });

  it('keeps the running job when the user dismisses with Escape', async () => {
    useChatStore.setState({ isLoading: true });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const dialog = await screen.findByRole('dialog', { name: 'Are you sure?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(newSession).not.toHaveBeenCalled();
    expect(pickerState().pickerOpen).toBe(false);
    expect(useUIStore.getState().currentView).toBe('settings');
  });

  it('focuses the New session confirmation action when the dialog opens', async () => {
    useChatStore.setState({ isLoading: true });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const dialog = await screen.findByRole('dialog', { name: 'Are you sure?' });
    const confirmButton = within(dialog).getByRole('button', { name: 'New session' });

    await waitFor(() => expect(document.activeElement).toBe(confirmButton));
    expect(newSession).not.toHaveBeenCalled();
  });

  it('opens the system-prompt picker when the user confirms', async () => {
    useChatStore.setState({ isLoading: true });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const dialog = await screen.findByRole('dialog', { name: 'Are you sure?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'New session' }));

    await waitFor(() => expect(pickerState().pickerOpen).toBe(true));
    expect(pickerState().pickerStartsSession).toBe(true);
    expect(useUIStore.getState().currentView).toBe('chat');
  });
});
