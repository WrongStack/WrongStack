import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (message: { payload: Record<string, unknown> }) => void>();
const send = vi.fn();
const sendMessage = vi.fn(() => 'msg_bug_hunt');
const client = {
  isConnected: true,
  on: vi.fn((type: string, handler: (message: { payload: Record<string, unknown> }) => void) => {
    handlers.set(type, handler);
    return () => handlers.delete(type);
  }),
  send,
  sendMessage,
  listSavedProviders: vi.fn(),
};

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => client }));
vi.mock('@/lib/view-navigation', () => ({ openMainView: vi.fn() }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));

const { WelcomeScreen } = await import('../../src/components/WelcomeScreen');
const { useChatStore, useConfigStore } = await import('../../src/stores');
const { useFileStore } = await import('../../src/stores/file-store');
const { useLocalPrefs } = await import('../../src/stores/local-prefs');
const { useChatLanes } = await import('../../src/stores/chat-lanes');

beforeEach(() => {
  handlers.clear();
  send.mockClear();
  sendMessage.mockClear();
  client.on.mockClear();
  client.listSavedProviders.mockClear();
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useConfigStore.setState({
    wsConnected: true,
    wsStatus: { state: 'open' },
    wsUrl: 'ws://test',
    provider: 'test-provider',
    model: 'test-model',
  });
  // These tests drive the launcher forms directly; calm chrome folds them
  // (covered below), so pin full chrome where the forms are always open.
  useLocalPrefs.setState({
    subagentsAllowed: true,
    subagentsPolicyLocked: false,
    chromeLevel: 'full',
  });
  useFileStore.setState({
    tree: [{ name: 'webui', path: 'packages/webui', type: 'directory', children: [] }],
  });
});

describe('WelcomeScreen Proof-Driven Bug Hunter shortcut', () => {
  it('enables solo mode before loading and submitting the first chat turn', () => {
    render(<WelcomeScreen />);

    fireEvent.click(screen.getByRole('button', { name: /setup:welcome\.bugHunterStart/ }));
    expect(useLocalPrefs.getState().subagentsAllowed).toBe(false);
    expect(send).toHaveBeenCalledWith({
      type: 'prefs.update',
      payload: expect.objectContaining({ subagentsAllowed: false }),
    });
    expect(send).not.toHaveBeenCalledWith({
      type: 'prompts.content',
      payload: { slug: 'proof-driven-bug-hunter' },
    });

    act(() => {
      handlers.get('prefs.updated')?.({ payload: { subagentsAllowed: false } });
    });
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.content',
      payload: { slug: 'proof-driven-bug-hunter' },
    });

    act(() => {
      handlers.get('prompts.content')?.({
        payload: {
          slug: 'proof-driven-bug-hunter',
          found: true,
          content: 'Hunt exactly one proven bug.',
        },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        'This is round 1/1. Investigate at most one proven bug in this round',
      ),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('report no-proven-bug or blocked without changing production code'),
    );
    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'msg_bug_hunt',
        role: 'user',
        content: expect.stringContaining(
          '<!-- wrongstack-bug-hunt scope="" max-bugs="1" round="1" -->',
        ),
        bugHunt: { scope: '', maxBugs: 1, currentRound: 1 },
      }),
    ]);
    expect(useChatStore.getState().isLoading).toBe(true);
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.used',
      payload: { slug: 'proof-driven-bug-hunter' },
    });
  });

  it('sends the selected directory and maximum number of bug rounds', () => {
    render(<WelcomeScreen />);

    fireEvent.change(screen.getByLabelText('setup:welcome.bugHunterScope'), {
      target: { value: 'packages/webui' },
    });
    fireEvent.change(screen.getByLabelText('setup:welcome.bugHunterMaxBugs'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /setup:welcome\.bugHunterStart/ }));

    act(() => {
      handlers.get('prefs.updated')?.({ payload: { subagentsAllowed: false } });
      handlers.get('prompts.content')?.({
        payload: { slug: 'proof-driven-bug-hunter', found: true, content: 'Base prompt.' },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        'This is round 1/10. Investigate at most one proven bug in this round',
      ),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('packages/webui and all of its descendants'),
    );
    expect(useChatStore.getState().messages.at(-1)).toEqual(
      expect.objectContaining({
        bugHunt: { scope: 'packages/webui', maxBugs: 10, currentRound: 1 },
      }),
    );
  });

  it('shows an error and does not submit when the builtin prompt is missing', () => {
    render(<WelcomeScreen />);
    fireEvent.click(screen.getByRole('button', { name: /setup:welcome\.bugHunterStart/ }));

    act(() => {
      handlers.get('prefs.updated')?.({ payload: { subagentsAllowed: false } });
      handlers.get('prompts.content')?.({
        payload: { slug: 'proof-driven-bug-hunter', found: false, content: '' },
      });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('setup:welcome.bugHunterError');
  });

  it('launches a selected Proof-Driven Hunt mode (e.g. debloat) and records its mode in the transcript', () => {
    render(<WelcomeScreen />);

    fireEvent.change(screen.getByLabelText('setup:welcome.bugHunterMode'), {
      target: { value: 'debloat' },
    });
    fireEvent.change(screen.getByLabelText('setup:welcome.bugHunterScope'), {
      target: { value: 'packages/webui' },
    });
    fireEvent.change(screen.getByLabelText('setup:welcome.bugHunterMaxBugs'), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /setup:welcome\.bugHunterStart/ }));

    act(() => {
      handlers.get('prefs.updated')?.({ payload: { subagentsAllowed: false } });
    });
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.content',
      payload: { slug: 'proof-driven-dead-code-excisor' },
    });

    act(() => {
      handlers.get('prompts.content')?.({
        payload: {
          slug: 'proof-driven-dead-code-excisor',
          found: true,
          content: 'Excise one dead unit.',
        },
      });
    });

    expect(useChatStore.getState().messages.at(-1)).toEqual(
      expect.objectContaining({
        content: expect.stringContaining(
          '<!-- wrongstack-bug-hunt scope="packages%2Fwebui" max-bugs="3" round="1" mode="debloat" -->',
        ),
        bugHunt: { scope: 'packages/webui', maxBugs: 3, currentRound: 1, mode: 'debloat' },
      }),
    );
  });

  it('sets solo mode before the first chat turn', () => {
    render(<WelcomeScreen />);

    fireEvent.click(screen.getByRole('switch', { name: /setup:welcome\.soloSessionTitle/ }));

    expect(useLocalPrefs.getState().subagentsAllowed).toBe(false);
    expect(send).toHaveBeenCalledWith({
      type: 'prefs.update',
      payload: expect.objectContaining({ subagentsAllowed: false }),
    });
  });
});

describe('WelcomeScreen launchers under calm chrome', () => {
  it('folds both launcher forms until their header is clicked, one at a time', () => {
    useLocalPrefs.setState({ chromeLevel: 'calm' });
    render(<WelcomeScreen />);

    expect(screen.queryByRole('button', { name: /setup:welcome\.bugHunterStart/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /setup:welcome\.perfStart/ })).toBeNull();

    fireEvent.click(screen.getByTestId('welcome-launcher-bug'));
    expect(screen.getByRole('button', { name: /setup:welcome\.bugHunterStart/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /setup:welcome\.perfStart/ })).toBeNull();

    fireEvent.click(screen.getByTestId('welcome-launcher-perf'));
    expect(screen.queryByRole('button', { name: /setup:welcome\.bugHunterStart/ })).toBeNull();
    expect(screen.getByRole('button', { name: /setup:welcome\.perfStart/ })).toBeTruthy();
  });
});

describe('WelcomeScreen connection state', () => {
  it('does not claim the agent is connected while the backend is offline', () => {
    useConfigStore.setState({ wsConnected: false, wsStatus: { state: 'closed' } });
    render(<WelcomeScreen />);

    expect(screen.getByText('setup:welcome.heroSubtitleDisconnected')).toBeTruthy();
    expect(screen.queryByText('setup:welcome.heroSubtitle')).toBeNull();
  });
});
