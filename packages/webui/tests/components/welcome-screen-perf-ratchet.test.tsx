import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (message: { payload: Record<string, unknown> }) => void>();
const send = vi.fn();
const sendMessage = vi.fn(() => 'msg_perf_run');
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

const START = /setup:welcome\.perfStart/;

beforeEach(() => {
  handlers.clear();
  send.mockClear();
  sendMessage.mockClear();
  client.on.mockClear();
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
    tree: [{ name: 'sage', path: 'packages/sage', type: 'directory', children: [] }],
  });
});

describe('WelcomeScreen performance ratchet shortcut', () => {
  it('forces a solo session before the ratchet round and sends the round message', () => {
    render(<WelcomeScreen />);

    fireEvent.click(screen.getByRole('button', { name: START }));

    // The ratchet attributes one measured delta to one change; subagents would
    // make that attribution impossible to defend, so the flip comes first.
    expect(useLocalPrefs.getState().subagentsAllowed).toBe(false);
    expect(send).not.toHaveBeenCalledWith({
      type: 'prompts.content',
      payload: { slug: 'elite-performance-ratchet' },
    });

    act(() => {
      handlers.get('prefs.updated')?.({ payload: { subagentsAllowed: false } });
    });
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.content',
      payload: { slug: 'elite-performance-ratchet' },
    });

    act(() => {
      handlers.get('prompts.content')?.({
        payload: {
          slug: 'elite-performance-ratchet',
          found: true,
          content: 'Measure, change one thing, re-measure.',
        },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Measure, change one thing, re-measure.'),
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('PERF_LOG.md'));
    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'msg_perf_run',
        role: 'user',
        content: expect.stringContaining(
          '<!-- wrongstack-perf-run scope="" mode="ratchet" metric="" -->',
        ),
        perfRun: { scope: '', mode: 'ratchet', metric: '' },
      }),
    ]);
    expect(useChatStore.getState().isLoading).toBe(true);
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.used',
      payload: { slug: 'elite-performance-ratchet' },
    });
  });

  it('does not force solo mode for a read-only mode', () => {
    render(<WelcomeScreen />);

    fireEvent.change(screen.getByLabelText('setup:welcome.perfMode'), {
      target: { value: 'audit' },
    });
    fireEvent.click(screen.getByRole('button', { name: START }));

    // An audit changes nothing, so it has no attribution to protect and must
    // not silently disable the user's subagents.
    expect(useLocalPrefs.getState().subagentsAllowed).toBe(true);
    expect(send).toHaveBeenCalledWith({
      type: 'prompts.content',
      payload: { slug: 'performance-baseline-audit' },
    });
  });

  it('carries the selected scope and metric into the prompt and the transcript card', () => {
    render(<WelcomeScreen />);

    fireEvent.change(screen.getByLabelText('setup:welcome.perfScope'), {
      target: { value: 'packages/sage' },
    });
    fireEvent.change(screen.getByLabelText('setup:welcome.perfMode'), {
      target: { value: 'cpu' },
    });
    fireEvent.change(screen.getByLabelText('setup:welcome.perfMetric'), {
      target: { value: 'p99-latency-ms' },
    });
    fireEvent.click(screen.getByRole('button', { name: START }));

    act(() => {
      handlers.get('prefs.updated')?.({ payload: { subagentsAllowed: false } });
      handlers.get('prompts.content')?.({
        payload: { slug: 'performance-cpu-hot-path', found: true, content: 'Base prompt.' },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('packages/sage and all of its descendants'),
    );
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('p99 latency'));
    expect(useChatStore.getState().messages.at(-1)).toEqual(
      expect.objectContaining({
        perfRun: { scope: 'packages/sage', mode: 'cpu', metric: 'p99-latency-ms' },
      }),
    );
  });

  it('asks the agent to pick the metric when none is selected', () => {
    render(<WelcomeScreen />);
    fireEvent.change(screen.getByLabelText('setup:welcome.perfMode'), {
      target: { value: 'triage' },
    });
    fireEvent.click(screen.getByRole('button', { name: START }));

    act(() => {
      handlers.get('prompts.content')?.({
        payload: { slug: 'performance-quick-triage', found: true, content: 'Base prompt.' },
      });
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Pick the metric the user actually feels'),
    );
  });

  it('ignores another card fetching its own prompt on the shared channel', () => {
    render(<WelcomeScreen />);
    fireEvent.change(screen.getByLabelText('setup:welcome.perfMode'), {
      target: { value: 'audit' },
    });
    fireEvent.click(screen.getByRole('button', { name: START }));

    act(() => {
      handlers.get('prompts.content')?.({
        payload: { slug: 'proof-driven-bug-hunter', found: true, content: 'Not mine.' },
      });
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error and sends nothing when the builtin prompt is missing', () => {
    render(<WelcomeScreen />);
    fireEvent.change(screen.getByLabelText('setup:welcome.perfMode'), {
      target: { value: 'memory' },
    });
    fireEvent.click(screen.getByRole('button', { name: START }));

    act(() => {
      handlers.get('prompts.content')?.({
        payload: { slug: 'performance-memory-hunt', found: false, content: '' },
      });
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('setup:welcome.perfError');
  });
});
