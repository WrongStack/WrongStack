import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeStreakState } from '../../src/stores/auto-submit-streak';
import { DEFAULT_LANE_ID, ensureLane, hasLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import {
  ensureSessionLane,
  hasSessionLane,
  SESSION_DEFAULT_LANE_ID,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import { useSessionTabStore } from '../../src/stores/session-tab-store';
import type { ChatMessage } from '../../src/stores/types.js';
import { useUIStore } from '../../src/stores/ui-store';

/** A lane with content in it, so the tab is not disposable. */
function busyMessage(id: string): ChatMessage {
  return { id, role: 'user', content: 'x', timestamp: 0 };
}

// The streak/loop-guard state is module-private (a Map keyed by session), so
// the observable fact is that teardown asks for it to be dropped.
vi.mock('../../src/stores/auto-submit-streak', () => ({ disposeStreakState: vi.fn() }));

/**
 * A tab is retired through two doors, and both must free the same things.
 *
 * `closeTab` is the door the user opens. `setOpenTabIds` is the one the app
 * opens for them — the history purge dropping a session the server no longer
 * lists, a slot being recycled for a new session, a re-announce arriving for a
 * session with no slot. The second door used to free only the two lanes, so a
 * tab retired that way left its preference overrides and its auto-submit
 * streak behind, and the NEXT session handed that id silently inherited them.
 */

function openTabs(ids: string[]): void {
  for (const id of ids) {
    ensureLane(id);
    ensureSessionLane(id);
  }
  useSessionTabStore.setState({ openTabIds: ids, lastSeenCounts: {}, attention: {} });
}

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useLocalPrefs.setState({ bySession: {}, activeSessionId: null });
  useUIStore.setState({
    subagentChatFocusId: null,
    subagentChatFocusSessionId: null,
    subagentChatFocusBySession: {},
    queuePanelOpen: false,
    processMonitorOpen: false,
    cronJobsOpen: false,
  });
  vi.mocked(disposeStreakState).mockClear();
});

describe('retiring a tab frees the same state through either door', () => {
  it('setOpenTabIds drops the lanes, the pref overrides and the streak', () => {
    openTabs(['tab-a', 'tab-b']);
    useLocalPrefs.getState().bindSession('tab-b');
    useLocalPrefs.getState().set({ yolo: true });
    useUIStore.getState().setSubagentChatFocus('agent-b', 'tab-b');
    useSessionTabStore.setState({
      lastSeenCounts: { 'tab-b': 3 },
      attention: { 'tab-b': true },
      openTabIds: ['tab-a', 'tab-b'],
    });

    useSessionTabStore.getState().setOpenTabIds(['tab-a']);

    expect(hasLane('tab-b')).toBe(false);
    expect(hasSessionLane('tab-b')).toBe(false);
    // The three that used to survive this door.
    expect(useLocalPrefs.getState().bySession['tab-b']).toBeUndefined();
    expect(disposeStreakState).toHaveBeenCalledWith('tab-b');
    expect(useSessionTabStore.getState().lastSeenCounts['tab-b']).toBeUndefined();
    expect(useSessionTabStore.getState().attention['tab-b']).toBeUndefined();
    expect(useUIStore.getState().subagentChatFocusBySession['tab-b']).toBeUndefined();
  });

  it('closeTab leaves nothing behind either', () => {
    openTabs(['tab-a', 'tab-b']);
    useLocalPrefs.getState().bindSession('tab-b');
    useLocalPrefs.getState().set({ yolo: true });

    useSessionTabStore.getState().closeTab('tab-b');

    expect(hasLane('tab-b')).toBe(false);
    expect(useLocalPrefs.getState().bySession['tab-b']).toBeUndefined();
    expect(useUIStore.getState().subagentChatFocusBySession['tab-b']).toBeUndefined();
  });

  it('recycling a full strip slot (openTab replaced_empty_tab) frees the same state', () => {
    // Four busy tabs: none is disposable when they hold lanes with content,
    // so make three busy (messages) and one idle-empty so it is recyclable.
    openTabs(['tab-a', 'tab-b', 'tab-c', 'tab-recycled']);
    useChatLanes.setState((s) => ({
      lanes: {
        ...s.lanes,
        'tab-a': { ...s.lanes['tab-a']!, messages: [busyMessage('a')] },
        'tab-b': { ...s.lanes['tab-b']!, messages: [busyMessage('b')] },
        'tab-c': { ...s.lanes['tab-c']!, messages: [busyMessage('c')] },
      },
    }));
    useLocalPrefs.getState().bindSession('tab-recycled');
    useLocalPrefs.getState().set({ yolo: true });

    const outcome = useSessionTabStore.getState().openTab('tab-new');

    expect(outcome).toEqual({ success: true, reason: 'replaced_empty_tab' });
    expect(useSessionTabStore.getState().openTabIds).toContain('tab-new');
    expect(useSessionTabStore.getState().openTabIds).not.toContain('tab-recycled');
    // The recycled slot's OWNERS must not survive into the new occupant.
    expect(hasLane('tab-recycled')).toBe(false);
    expect(hasSessionLane('tab-recycled')).toBe(false);
    expect(useLocalPrefs.getState().bySession['tab-recycled']).toBeUndefined();
    expect(disposeStreakState).toHaveBeenCalledWith('tab-recycled');
    expect(useUIStore.getState().subagentChatFocusBySession['tab-recycled']).toBeUndefined();
  });
});

describe('the foreground pointer never names a freed lane', () => {
  it('falls back to a remaining tab when the one in front closes', () => {
    openTabs(['tab-a', 'tab-b']);
    useSessionLanes.setState({ activeSessionId: 'tab-b' });
    useChatLanes.setState({ activeSessionId: 'tab-b' });

    useSessionTabStore.getState().closeTab('tab-b');

    expect(useSessionLanes.getState().activeSessionId).toBe('tab-a');
  });

  it('goes back to unbound when the last tab closes', () => {
    openTabs(['tab-a']);
    useSessionLanes.setState({ activeSessionId: 'tab-a' });
    useChatLanes.setState({ activeSessionId: 'tab-a' });

    useSessionTabStore.getState().closeTab('tab-a');

    // Leaving the pointer on the freed lane is worse than having no pointer:
    // the registries recreate a lane on first write, so the next stray event
    // for the closed session resurrects it — invisible, unclosable, and
    // counting against the four-lane ceiling a real new tab needs.
    expect(useSessionLanes.getState().activeSessionId).toBe(SESSION_DEFAULT_LANE_ID);
    expect(useChatLanes.getState().activeSessionId).toBe(DEFAULT_LANE_ID);
  });

  it('repoints when a slot list drops the tab that was in front', () => {
    openTabs(['tab-a', 'tab-b']);
    useSessionLanes.setState({ activeSessionId: 'tab-b' });
    useChatLanes.setState({ activeSessionId: 'tab-b' });

    useSessionTabStore.getState().setOpenTabIds(['tab-a']);

    expect(useSessionLanes.getState().activeSessionId).toBe('tab-a');
  });
});
