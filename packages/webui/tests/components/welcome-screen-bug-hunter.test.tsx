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
  useLocalPrefs.setState({ subagentsAllowed: true, subagentsPolicyLocked: false });
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
      expect.stringContaining('This run may complete up to 1 proven bug round.'),
    );
    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'msg_bug_hunt',
        role: 'user',
        content: expect.stringContaining('<!-- wrongstack-bug-hunt scope="" max-bugs="1" -->'),
        bugHunt: { scope: '', maxBugs: 1 },
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
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /setup:welcome\.bugHunterStart/ }));

    act(() => {
      handlers.get('prefs.updated')?.({ payload: { subagentsAllowed: false } });
      handlers.get('prompts.content')?.({
        payload: { slug: 'proof-driven-bug-hunter', found: true, content: 'Base prompt.' },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('up to 3 proven bug rounds'));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('packages/webui and all of its descendants'),
    );
    expect(useChatStore.getState().messages.at(-1)).toEqual(
      expect.objectContaining({ bugHunt: { scope: 'packages/webui', maxBugs: 3 } }),
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
