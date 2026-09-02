/**
 * Integration proof for the tab-close confirmation flow: SessionTabBar wired
 * to the REAL ConfirmModalHost (no mock) — the dialog actually opens with the
 * requested wording, and its buttons drive close / abort / cancel.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmModalHost } from '../../src/components/ConfirmModal';
import { SessionTabBar } from '../../src/components/SessionTabBar';
import {
  useFleetStore,
  useHistoryStore,
  useSessionStore,
  useSessionTabStore,
} from '../../src/stores';
import { useChatLanes } from '../../src/stores/chat-lanes';
import { SESSION_DEFAULT_LANE_ID, useSessionLanes } from '../../src/stores/session-lanes';
import type { SubagentView } from '../../src/stores/types';

const mockResumeSession = vi.fn();
const mockListSessions = vi.fn();
const mockSendAbort = vi.fn();

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
  return { useAppTranslation: () => ({ t }), i18n: { t } };
});

vi.mock('../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ resumeSession: mockResumeSession, listSessions: mockListSessions }),
}));

vi.mock('../../src/lib/ws-client', () => ({
  getWSClient: () => ({ sendAbort: mockSendAbort }),
}));

function busyAgent(sessionId: string): SubagentView {
  return {
    id: 'worker-1',
    sessionId,
    name: 'worker-1',
    status: 'running',
    description: 'the busy task',
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

function seedTwoTabs(): void {
  useSessionTabStore.setState({
    openTabIds: ['sess-12345678', 'sess-87654321'],
    lastSeenCounts: {},
    attention: {},
  });
  useSessionStore.setState({
    session: {
      id: 'sess-12345678',
      title: 'Initial Session',
      startedAt: Date.now(),
      provider: 'test',
      model: 'test-model',
    },
  });
  useHistoryStore.setState({ entries: [] });
}

describe('tab close × real ConfirmModalHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useChatLanes.setState({ lanes: {}, activeSessionId: 'default' });
    useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
    useFleetStore.setState({ agents: new Map() } as never);
  });

  it('busy tab: opens the ongoing-operation dialog, switches to it, aborts on confirm', async () => {
    seedTwoTabs();
    useFleetStore.setState({
      agents: new Map([['worker-1', busyAgent('sess-87654321')]]),
    } as never);

    render(
      <>
        <SessionTabBar />
        <ConfirmModalHost />
      </>,
    );

    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    // The on-screen warning names the ongoing operation...
    expect(await screen.findByText('There is an ongoing operation in this session')).toBeDefined();
    expect(screen.getByText('Are you sure you want to close this tab?')).toBeDefined();
    expect(screen.getByText('worker-1 — running: the busy task')).toBeDefined();
    // ...and the foreground moved to the tab being closed.
    expect(useSessionLanes.getState().activeSessionId).toBe('sess-87654321');

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt and Close' }));

    await waitFor(() =>
      expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678']),
    );
    expect(mockSendAbort).toHaveBeenCalledWith('sess-87654321');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('history-only tab: asks with the agent-history wording, closes without abort', async () => {
    seedTwoTabs();
    useFleetStore.setState({
      agents: new Map([
        ['done-1', { ...busyAgent('sess-87654321'), id: 'done-1', status: 'completed' }],
      ]),
    } as never);

    render(
      <>
        <SessionTabBar />
        <ConfirmModalHost />
      </>,
    );

    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    expect(await screen.findByText('Close this tab?')).toBeDefined();
    expect(
      screen.getByText('This tab contains agent history. Are you sure you want to close it?'),
    ).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Close Tab' }));

    await waitFor(() =>
      expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678']),
    );
    expect(mockSendAbort).not.toHaveBeenCalled();
  });

  it('cancel keeps the tab and the run alive', async () => {
    seedTwoTabs();
    useFleetStore.setState({
      agents: new Map([['worker-1', busyAgent('sess-87654321')]]),
    } as never);

    render(
      <>
        <SessionTabBar />
        <ConfirmModalHost />
      </>,
    );

    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);
    await screen.findByText('There is an ongoing operation in this session');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678', 'sess-87654321']);
    expect(mockSendAbort).not.toHaveBeenCalled();
  });

  it('empty tab closes instantly — no dialog is ever raised', async () => {
    seedTwoTabs();

    render(
      <>
        <SessionTabBar />
        <ConfirmModalHost />
      </>,
    );

    fireEvent.click(screen.getAllByTitle('Close tab')[1]!);

    await waitFor(() =>
      expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-12345678']),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockSendAbort).not.toHaveBeenCalled();
  });
});
