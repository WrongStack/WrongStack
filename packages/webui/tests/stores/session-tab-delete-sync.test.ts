import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWSClient } from '../../src/lib/ws-client';
import { DEFAULT_LANE_ID, ensureLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useFleetStore } from '../../src/stores/fleet-store';
import { useHistoryStore } from '../../src/stores/history-store';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import {
  ensureSessionLane,
  SESSION_DEFAULT_LANE_ID,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import { isNeverStartedSession, useSessionTabStore } from '../../src/stores/session-tab-store';
import type { SessionHistoryEntry } from '../../src/stores/types.js';
import { useUIStore } from '../../src/stores/ui-store';

vi.mock('../../src/lib/ws-client', () => ({ getWSClient: vi.fn() }));

const subscribeSessions = vi.fn();
const deleteSession = vi.fn();

/**
 * The two directions of the tab ↔ session-record contract:
 *
 *   1. Removing sessions (delete button, clear-empty) closes their tabs first
 *      and never lets the strip drop to zero.
 *   2. Closing the tab of a never-started session deletes the record with the
 *      close — after re-declaring the open set, so the server does not refuse
 *      the delete as "still displayed".
 */
function historyEntry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    id: 'sess-1',
    title: 'Session',
    startedAt: '2026-01-01T00:00:00.000Z',
    model: 'test-model',
    provider: 'test-provider',
    tokenTotal: 0,
    messageCount: 0,
    isCurrent: false,
    ...overrides,
  } as SessionHistoryEntry;
}

function openTabs(ids: string[]): void {
  for (const id of ids) {
    ensureLane(id);
    ensureSessionLane(id);
  }
  useSessionTabStore.setState({ openTabIds: ids, lastSeenCounts: {}, attention: {} });
}

beforeEach(() => {
  subscribeSessions.mockClear();
  deleteSession.mockClear();
  vi.mocked(getWSClient).mockReturnValue({ subscribeSessions, deleteSession } as never);
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useHistoryStore.setState({ entries: [], loading: false, error: null });
  useFleetStore.setState({ agents: new Map() } as never);
  useLocalPrefs.setState({ bySession: {}, activeSessionId: null });
  useUIStore.setState({
    subagentChatFocusId: null,
    subagentChatFocusSessionId: null,
    subagentChatFocusBySession: {},
    queuePanelOpen: false,
    processMonitorOpen: false,
    cronJobsOpen: false,
  });
});

describe('isNeverStartedSession', () => {
  it('is true for an idle, empty lane with an empty record', () => {
    ensureLane('tab-a');
    useHistoryStore.setState({ entries: [historyEntry({ id: 'tab-a' })] });
    expect(isNeverStartedSession('tab-a')).toBe(true);
  });

  it('is false when the record has tokens', () => {
    ensureLane('tab-a');
    useHistoryStore.setState({
      entries: [historyEntry({ id: 'tab-a', tokenTotal: 42 })],
    });
    expect(isNeverStartedSession('tab-a')).toBe(false);
  });

  it('is false when the record has messages', () => {
    ensureLane('tab-a');
    useHistoryStore.setState({
      entries: [historyEntry({ id: 'tab-a', messageCount: 3 })],
    });
    expect(isNeverStartedSession('tab-a')).toBe(false);
  });

  it('is false when the lane holds a transcript (resume replay race)', () => {
    ensureLane('tab-a');
    useChatLanes.setState((s) => ({
      lanes: {
        ...s.lanes,
        'tab-a': {
          ...s.lanes['tab-a']!,
          messages: [{ id: 'm1', role: 'user', content: 'x', timestamp: 0 }],
        },
      },
    }));
    expect(isNeverStartedSession('tab-a')).toBe(false);
  });

  it('is false when the session is not in the history list', () => {
    ensureLane('tab-a');
    expect(isNeverStartedSession('tab-a')).toBe(false);
  });

  it('is false while the tab owns a running subagent', () => {
    ensureLane('tab-a');
    useHistoryStore.setState({ entries: [historyEntry({ id: 'tab-a' })] });
    useFleetStore.setState({
      agents: new Map([
        ['agent-1', { sessionId: 'tab-a', status: 'running' } as never],
      ]),
    } as never);
    expect(isNeverStartedSession('tab-a')).toBe(false);
  });
});

describe('closeTab deletes never-started records', () => {
  it('re-declares the open set and then deletes the empty record', () => {
    openTabs(['tab-a', 'tab-empty']);
    useHistoryStore.setState({
      entries: [historyEntry({ id: 'tab-empty' })],
    });

    useSessionTabStore.getState().closeTab('tab-empty');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-a']);
    expect(deleteSession).toHaveBeenCalledWith('tab-empty');
    // The subscription update must reach the socket first: the server refuses
    // to delete a session this connection still declares.
    expect(subscribeSessions.mock.invocationCallOrder[0]).toBeLessThan(
      deleteSession.mock.invocationCallOrder[0],
    );
    expect(subscribeSessions).toHaveBeenCalledWith(['tab-a']);
  });

  it('does not delete a session that has content', () => {
    openTabs(['tab-a', 'tab-used']);
    useHistoryStore.setState({
      entries: [historyEntry({ id: 'tab-used', tokenTotal: 10 })],
    });

    useSessionTabStore.getState().closeTab('tab-used');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-a']);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('still closes the tab when no client is connected', () => {
    vi.mocked(getWSClient).mockImplementation(() => {
      throw new Error('no socket');
    });
    openTabs(['tab-a', 'tab-empty']);
    useHistoryStore.setState({ entries: [historyEntry({ id: 'tab-empty' })] });

    useSessionTabStore.getState().closeTab('tab-empty');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-a']);
  });
});

describe('closeTabsForSessions', () => {
  it('closes the doomed tabs, declares the survivors and returns every id', () => {
    openTabs(['tab-keep', 'tab-doom-1', 'tab-doom-2']);

    const removable = useSessionTabStore
      .getState()
      .closeTabsForSessions(['tab-doom-1', 'tab-doom-2', 'sess-no-tab']);

    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-keep']);
    expect(removable).toEqual(['tab-doom-1', 'tab-doom-2', 'sess-no-tab']);
    expect(subscribeSessions).toHaveBeenCalledWith(['tab-keep']);
  });

  it('keeps exactly one tab when every slot is doomed, preferring the foreground', () => {
    openTabs(['tab-a', 'tab-b', 'tab-c']);
    useSessionLanes.setState({ activeSessionId: 'tab-b' });

    const removable = useSessionTabStore
      .getState()
      .closeTabsForSessions(['tab-a', 'tab-b', 'tab-c']);

    // The foreground tab survives; its session is NOT removable.
    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-b']);
    expect(removable).toEqual(['tab-a', 'tab-c']);
    expect(subscribeSessions).toHaveBeenCalledWith(['tab-b']);
  });

  it('never returns a session whose tab owns an active run', () => {
    openTabs(['tab-a', 'tab-running']);
    useFleetStore.setState({
      agents: new Map([
        ['agent-1', { sessionId: 'tab-running', status: 'running' } as never],
      ]),
    } as never);

    const removable = useSessionTabStore
      .getState()
      .closeTabsForSessions(['tab-a', 'tab-running']);

    // The busy tab stays open and its session is not deletable.
    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-running']);
    expect(removable).toEqual(['tab-a']);
  });

  it('returns non-busy ids untouched when no tabs are open', () => {
    const removable = useSessionTabStore.getState().closeTabsForSessions(['sess-x']);
    expect(removable).toEqual(['sess-x']);
    expect(subscribeSessions).not.toHaveBeenCalled();
  });
});
