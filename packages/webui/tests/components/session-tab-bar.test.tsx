import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTabBar } from '../../src/components/SessionTabBar';
import {
  useFleetStore,
  useHistoryStore,
  useSessionStore,
  useSessionTabStore,
} from '../../src/stores';
import { chatLane, DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
import { SESSION_DEFAULT_LANE_ID, useSessionLanes } from '../../src/stores/session-lanes';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store';
import type { SubagentView } from '../../src/stores/types';

const mockResumeSession = vi.fn();
const mockNewSession = vi.fn();
const mockListSessions = vi.fn();
const mockSendAbort = vi.fn();
const mockConfirmModal = vi.fn();

vi.mock('../../src/i18n', () => {
  const t = (k: string, d?: string | ({ defaultValue?: string } & Record<string, unknown>)) => {
    if (typeof d === 'string') return d;
    let out = d?.defaultValue ?? k;
    for (const [key, value] of Object.entries(d ?? {})) {
      if (key === 'defaultValue') continue;
      out = out.replaceAll(`{{${key}}}`, String(value));
    }
    return out;
  };
  return {
    useAppTranslation: () => ({ t }),
    // session-tab-store builds its busy-tab warning lines through the global
    // `i18n` instance (stores cannot use the hook); mirror the fallback.
    i18n: { t },
  };
});

vi.mock('../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    resumeSession: mockResumeSession,
    newSession: mockNewSession,
    listSessions: mockListSessions,
  }),
}));

vi.mock('../../src/lib/ws-client', () => ({
  getWSClient: () => ({ sendAbort: mockSendAbort }),
}));

vi.mock('../../src/components/ConfirmModal', () => ({
  confirmModal: (...args: unknown[]) => mockConfirmModal(...args),
}));

function agent(id: string, sessionId: string, description: string): SubagentView {
  return {
    id,
    sessionId,
    name: id,
    status: 'running',
    description,
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: Date.now(),
    toolLog: [],
    sparklineBins: [],
  };
}

describe('SessionTabBar component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
    useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
    useSessionTabStore.setState({
      openTabIds: ['sess-12345678'],
      lastSeenCounts: {},
      attention: {},
    });
    useFleetStore.setState({ agents: new Map() } as never);
    useSessionStore.setState({
      session: {
        id: 'sess-12345678',
        title: 'Initial Session',
        startedAt: Date.now(),
        provider: 'test',
        model: 'test-model',
      },
    });
    useHistoryStore.setState({
      entries: [
        {
          id: 'sess-12345678',
          name: 'Initial Session',
          title: 'Initial Session',
          startedAt: new Date().toISOString(),
          model: 'test-model',
          provider: 'test',
          tokenTotal: 0,
          isCurrent: true,
        },
        {
          id: 'sess-87654321',
          name: 'Secondary Session',
          title: 'Secondary Session',
          startedAt: new Date().toISOString(),
          model: 'test-model',
          provider: 'test',
          tokenTotal: 0,
          isCurrent: false,
        },
      ],
    });
    useSystemPromptStore.setState({ pickerOpen: false, pickerStartsSession: false });
    mockConfirmModal.mockResolvedValue(true);
  });

  it('renders active session tab', () => {
    render(<SessionTabBar />);

    expect(screen.getByText('Initial Session')).toBeDefined();
  });

  it('triggers new session creation when + button is clicked', () => {
    render(<SessionTabBar />);

    const newBtn = screen.getByTitle('New Session');
    fireEvent.click(newBtn);

    expect(useSystemPromptStore.getState().pickerOpen).toBe(true);
    expect(useSystemPromptStore.getState().pickerStartsSession).toBe(true);
  });

  it('does not drop open tabs when the history list is incomplete', () => {
    useSessionTabStore.setState({
      openTabIds: ['sess-12345678', 'sess-87654321', 'sess-not-in-history'],
      lastSeenCounts: {},
      attention: {},
    });
    useHistoryStore.setState({
      entries: [
        {
          id: 'sess-12345678',
          name: 'Initial Session',
          title: 'Initial Session',
          startedAt: new Date().toISOString(),
          model: 'test-model',
          provider: 'test',
          tokenTotal: 0,
          isCurrent: true,
        },
      ],
    });

    render(<SessionTabBar />);

    expect(useSessionTabStore.getState().openTabIds).toEqual([
      'sess-12345678',
      'sess-87654321',
      'sess-not-in-history',
    ]);
  });

  it('does not close or interrupt a running tab when the confirmation is cancelled', async () => {
    mockConfirmModal.mockResolvedValue(false);
    useSessionTabStore.setState({
      openTabIds: ['sess-12345678', 'sess-87654321'],
      lastSeenCounts: {},
      attention: {},
    });
    useFleetStore.setState({
      agents: new Map([['agent-1', { sessionId: 'sess-87654321', status: 'running' } as never]]),
    } as never);

    render(<SessionTabBar />);
    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    await waitFor(() => expect(mockConfirmModal).toHaveBeenCalled());
    // The switch still happened: the user faces the tab they nearly closed.
    expect(useSessionLanes.getState().activeSessionId).toBe('sess-87654321');
    expect(mockSendAbort).not.toHaveBeenCalled();
    expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678', 'sess-87654321']);
  });

  it('interrupts the owning session before closing a running tab', async () => {
    // Hold the dialog open, or the instant-resolving mock lets the handler
    // finish (and repoint the foreground) before the assertion below runs.
    let resolveConfirm!: (value: boolean) => void;
    mockConfirmModal.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    useSessionTabStore.setState({
      openTabIds: ['sess-12345678', 'sess-87654321'],
      lastSeenCounts: {},
      attention: {},
    });
    useFleetStore.setState({
      agents: new Map([['agent-1', { sessionId: 'sess-87654321', status: 'running' } as never]]),
    } as never);

    render(<SessionTabBar />);
    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    await waitFor(() => expect(mockConfirmModal).toHaveBeenCalled());
    // The doomed tab is brought to the front BEFORE the question is asked —
    // confirming blind is how the wrong session gets interrupted.
    expect(useSessionLanes.getState().activeSessionId).toBe('sess-87654321');
    resolveConfirm(true);
    await waitFor(() =>
      expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678']),
    );
    expect(mockConfirmModal).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: 'Interrupt and Close',
        danger: true,
      }),
    );
    expect(mockSendAbort).toHaveBeenCalledWith('sess-87654321');
  });

  it('shows a complete session-scoped interruption inventory before closing', async () => {
    useSessionTabStore.setState({
      openTabIds: ['sess-12345678', 'sess-87654321'],
      lastSeenCounts: {},
      attention: {},
    });
    useChatLanes.setState({ activeSessionId: 'sess-87654321' });
    chatLane('sess-87654321').setLoading(true);
    chatLane('sess-87654321').enqueue('queued in closing tab');
    chatLane('sess-12345678').enqueue('queued in other tab');
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['closing-worker', agent('closing-worker', 'sess-87654321', 'closing task brief')],
        ['other-worker', agent('other-worker', 'sess-12345678', 'other task brief')],
      ]),
    } as never);

    render(<SessionTabBar />);
    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    await waitFor(() => expect(mockConfirmModal).toHaveBeenCalled());
    const [dialog] = mockConfirmModal.mock.calls.at(-1)!;
    const details = (dialog as { details?: string[] }).details ?? [];
    const detailText = details.join('\n');

    expect(detailText).toContain('Leader run in progress');
    expect(detailText).toContain('closing-worker');
    expect(detailText).toContain('closing task brief');
    expect(detailText).toContain('1 queued message');
    expect(detailText).not.toContain('other-worker');
    expect(detailText).not.toContain('other task brief');
    expect(detailText).not.toContain('queued in other tab');
    expect(mockSendAbort).toHaveBeenCalledWith('sess-87654321');
  });

  it('closes a completely empty tab instantly without confirmation', async () => {
    useSessionTabStore.setState({
      openTabIds: ['sess-12345678', 'sess-87654321'],
      lastSeenCounts: {},
      attention: {},
    });

    render(<SessionTabBar />);
    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    await waitFor(() =>
      expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678']),
    );
    expect(mockConfirmModal).not.toHaveBeenCalled();
    expect(mockSendAbort).not.toHaveBeenCalled();
  });

  it('switches to a tab with history and asks before discarding it', async () => {
    // Hold the dialog open so the foreground assertion below cannot race the
    // (immediate) confirmation.
    let resolveConfirm!: (value: boolean) => void;
    mockConfirmModal.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    useSessionTabStore.setState({
      openTabIds: ['sess-12345678', 'sess-87654321'],
      lastSeenCounts: {},
      attention: {},
    });
    // A finished agent on record: history worth a warning, but nothing running.
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['done-1', { ...agent('done-1', 'sess-87654321', 'finished task'), status: 'completed' }],
      ]),
    } as never);

    render(<SessionTabBar />);
    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    await waitFor(() => expect(mockConfirmModal).toHaveBeenCalled());
    // Switch first: the user faces the tab they are about to discard.
    expect(useSessionLanes.getState().activeSessionId).toBe('sess-87654321');
    const [dialog] = mockConfirmModal.mock.calls.at(-1)!;
    expect((dialog as { title?: string }).title).toBe('Close this tab?');
    expect((dialog as { message?: string }).message).toContain('agent history');
    expect((dialog as { confirmLabel?: string }).confirmLabel).toBe('Close Tab');

    // Confirming closes without an abort — nothing is running.
    resolveConfirm(true);
    await waitFor(() =>
      expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678']),
    );
    expect(mockSendAbort).not.toHaveBeenCalled();
    expect(mockResumeSession).toHaveBeenCalledWith('sess-87654321');
  });
});
