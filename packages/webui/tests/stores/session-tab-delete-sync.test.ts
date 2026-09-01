import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWSClient } from '../../src/lib/ws-client';
import { DEFAULT_LANE_ID, ensureLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useFleetStore } from '../../src/stores/fleet-store';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import {
  ensureSessionLane,
  SESSION_DEFAULT_LANE_ID,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import {
  readStoredTabs,
  TAB_STORAGE_KEY,
  useSessionTabStore,
  writeStoredTabs,
} from '../../src/stores/session-tab-store';
import { useUIStore } from '../../src/stores/ui-store';

vi.mock('../../src/lib/ws-client', () => ({ getWSClient: vi.fn() }));

const subscribeSessions = vi.fn();
const deleteSession = vi.fn();

/**
 * The two directions of the tab ↔ session-record contract:
 *
 *   1. Removing sessions (delete button, clear-empty) closes their tabs first
 *      and never lets the strip drop to zero.
 *   2. Closing a tab is not history deletion. It only closes that local
 *      session slot and re-declares the remaining displayed sessions.
 */
function openTabs(ids: string[]): void {
  for (const id of ids) {
    ensureLane(id);
    ensureSessionLane(id);
  }
  useSessionTabStore.setState({ openTabIds: ids, lastSeenCounts: {}, attention: {} });
}

beforeEach(() => {
  localStorage.clear();
  subscribeSessions.mockClear();
  deleteSession.mockClear();
  vi.mocked(getWSClient).mockReturnValue({ subscribeSessions, deleteSession } as never);
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useFleetStore.setState({ agents: new Map() } as never);
  useLocalPrefs.setState({ bySession: {}, activeSessionId: null });
  useUIStore.setState({
    subagentChatFocusId: null,
    subagentChatFocusSessionId: null,
    queuePanelOpen: false,
    processMonitorOpen: false,
    cronJobsOpen: false,
  });
});

describe('tab slot storage', () => {
  it('restores validated tab slots from localStorage', () => {
    localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(['old-a', 'old-b']));

    expect(readStoredTabs()).toEqual(['old-a', 'old-b']);
  });

  it('ignores malformed stored tab slots', () => {
    localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify({ not: 'an array' }));

    expect(readStoredTabs()).toEqual([]);
  });

  it('persists open tab slots for the next WebUI boot', () => {
    writeStoredTabs(['tab-a', 'tab-b']);

    // The strip must survive a reload: the boot-time lane/slot reconciler
    // (useF5Resilience) disposes every lane without a slot, so an unpersisted
    // strip makes a refresh destroy all but the foreground session's lane —
    // the "four tabs collapsed to one" regression.
    expect(readStoredTabs()).toEqual(['tab-a', 'tab-b']);
    expect(localStorage.getItem(TAB_STORAGE_KEY)).not.toBeNull();
  });

  it('persists at most MAX_OPEN_TABS slots', () => {
    writeStoredTabs(['a', 'b', 'c', 'd', 'e', 'f']);

    expect(readStoredTabs()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('closeTab only closes the displayed slot', () => {
  it('re-declares the open set without deleting an empty record', () => {
    openTabs(['tab-a', 'tab-empty']);

    useSessionTabStore.getState().closeTab('tab-empty');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-a']);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(subscribeSessions).toHaveBeenCalledWith(['tab-a']);
  });

  it('does not delete a session that has content either', () => {
    openTabs(['tab-a', 'tab-used']);

    useSessionTabStore.getState().closeTab('tab-used');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-a']);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('still closes the tab when no client is connected', () => {
    vi.mocked(getWSClient).mockImplementation(() => {
      throw new Error('no socket');
    });
    openTabs(['tab-a', 'tab-empty']);

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
      agents: new Map([['agent-1', { sessionId: 'tab-running', status: 'running' } as never]]),
    } as never);

    const removable = useSessionTabStore.getState().closeTabsForSessions(['tab-a', 'tab-running']);

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

describe('openTab on the foreground session', () => {
  it('adds the missing foreground tab to the strip instead of no-oping', () => {
    // Strip out of sync with the lane pointer — the state a reload produced
    // while slot persistence was broken: pointer names the session, strip is
    // empty, and the replay announce calls openTab for exactly this session.
    ensureLane('tab-fg');
    ensureSessionLane('tab-fg');
    useChatLanes.setState({ activeSessionId: 'tab-fg' });
    useSessionLanes.setState({ activeSessionId: 'tab-fg' });
    useSessionTabStore.setState({ openTabIds: [] });

    const result = useSessionTabStore.getState().openTab('tab-fg');

    expect(result).toEqual({ success: true, reason: 'already_active' });
    // The strip must now contain the foreground session — previously the
    // guard ran against a locally mutated copy and the set was dead code.
    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-fg']);
  });

  it('releases a displaced slot when the strip is full without the foreground', () => {
    ensureLane('tab-fg');
    ensureSessionLane('tab-fg');
    for (const id of ['tab-a', 'tab-b']) {
      ensureLane(id);
      ensureSessionLane(id);
    }
    useChatLanes.setState({ activeSessionId: 'tab-fg' });
    useSessionLanes.setState({ activeSessionId: 'tab-fg' });
    useSessionTabStore.setState({ openTabIds: ['tab-a', 'tab-b'] });

    const result = useSessionTabStore.getState().openTab('tab-fg');

    expect(result).toEqual({ success: true, reason: 'already_active' });
    expect(useSessionTabStore.getState().openTabIds).toEqual(['tab-a', 'tab-b', 'tab-fg']);
    // The foreground kept its slot; nothing was dropped, so nothing re-pointed.
    expect(useSessionTabStore.getState().openTabIds).not.toContain('');
  });
});
