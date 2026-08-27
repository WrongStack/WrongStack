import { beforeEach, describe, expect, it } from 'vitest';
import { chatLane, ensureLane, readLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import {
  ensureSessionLane,
  readSessionLane,
  SESSION_DEFAULT_LANE_ID,
  sessionLane,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import { useSessionTabStore } from '../../src/stores/session-tab-store';
import { useUIStore } from '../../src/stores/ui-store';

/**
 * Four tabs, four sessions: nothing about one tab is visible to another.
 *
 * This is the contract the user stated — chat history, queue (steer/btw),
 * todos, autonomy/yolo/mode/context strategy, subagent focus. A write into
 * tab A must leave tab B's lane, prefs and overlays untouched, and switching
 * the pointer must not copy, merge or crash.
 */

const TABS = ['sess-a', 'sess-b', 'sess-c', 'sess-d'] as const;

function openFour(): void {
  for (const id of TABS) {
    ensureLane(id);
    ensureSessionLane(id);
  }
  useSessionTabStore.setState({
    openTabIds: [...TABS],
    lastSeenCounts: {},
    attention: {},
  });
}

beforeEach(() => {
  localStorage.clear();
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useLocalPrefs.setState({
    autonomy: 'off',
    yolo: false,
    contextStrategy: 'hybrid',
    contextMode: 'balanced',
    bySession: {},
    sessionDefaults: {},
    activeSessionId: null,
  } as never);
  useUIStore.setState({
    subagentChatFocusId: null,
    subagentChatFocusSessionId: null,
    subagentChatFocusBySession: {},
    queuePanelOpen: false,
    processMonitorOpen: false,
    cronJobsOpen: false,
  });
  openFour();
});

describe('four open tabs never share session-owned state', () => {
  it('keeps chat history and the btw/steer queue in their own lanes', () => {
    chatLane('sess-a').addMessage({ role: 'user', content: 'hello from A' });
    chatLane('sess-b').enqueue('steer B', 'steer');
    chatLane('sess-c').enqueue('btw C', 'btw');
    chatLane('sess-d').addMessage({ role: 'assistant', content: 'reply D' });

    expect(readLane('sess-a').messages.map((m) => m.content)).toEqual(['hello from A']);
    expect(readLane('sess-a').queue).toEqual([]);
    expect(readLane('sess-b').messages).toEqual([]);
    expect(readLane('sess-b').queue.map((q) => q.text)).toEqual(['steer B']);
    expect(readLane('sess-c').queue.map((q) => [q.text, q.mode])).toEqual([['btw C', 'btw']]);
    expect(readLane('sess-d').messages.map((m) => m.content)).toEqual(['reply D']);
  });

  it('keeps todos, mode and context-mode on the session that set them', () => {
    sessionLane('sess-a').setTodos([{ id: 't-a', content: 'A todo', status: 'pending' }]);
    sessionLane('sess-b').setEnvRates({ mode: 'review', contextMode: 'frugal' });
    sessionLane('sess-c').setTodos([{ id: 't-c', content: 'C todo', status: 'in_progress' }]);

    expect(readSessionLane('sess-a').todos).toEqual([
      { id: 't-a', content: 'A todo', status: 'pending' },
    ]);
    expect(readSessionLane('sess-b').todos).toEqual([]);
    expect(readSessionLane('sess-b').mode).toBe('review');
    expect(readSessionLane('sess-b').contextMode).toBe('frugal');
    expect(readSessionLane('sess-a').mode).toBe('default');
    expect(readSessionLane('sess-c').todos[0]?.content).toBe('C todo');
    expect(readSessionLane('sess-d').todos).toEqual([]);
  });

  it('keeps yolo, autonomy and context strategy as per-tab overrides', () => {
    useLocalPrefs.getState().bindSession('sess-a');
    useLocalPrefs.getState().set({ yolo: true, autonomy: 'eternal', contextStrategy: 'selective' });

    useLocalPrefs.getState().bindSession('sess-b');
    useLocalPrefs.getState().set({ yolo: false, autonomy: 'suggest', contextStrategy: 'hybrid' });

    useLocalPrefs.getState().bindSession('sess-a');
    expect(useLocalPrefs.getState().yolo).toBe(true);
    expect(useLocalPrefs.getState().autonomy).toBe('eternal');
    expect(useLocalPrefs.getState().contextStrategy).toBe('selective');

    useLocalPrefs.getState().bindSession('sess-b');
    expect(useLocalPrefs.getState().yolo).toBe(false);
    expect(useLocalPrefs.getState().autonomy).toBe('suggest');
    expect(useLocalPrefs.getState().contextStrategy).toBe('hybrid');

    useLocalPrefs.getState().bindSession('sess-c');
    // A brand-new tab inherits the last chosen default, then diverges —
    // it must not stay glued to sess-b after we change it.
    expect(useLocalPrefs.getState().autonomy).toBe('suggest');
    useLocalPrefs.getState().set({ autonomy: 'auto' });
    useLocalPrefs.getState().bindSession('sess-b');
    expect(useLocalPrefs.getState().autonomy).toBe('suggest');
  });

  it('switching the foreground pointer rebinds the visible pickers', () => {
    useLocalPrefs.getState().bindSession('sess-a');
    useLocalPrefs.getState().set({ yolo: true, autonomy: 'eternal' });
    useLocalPrefs.getState().bindSession('sess-b');
    useLocalPrefs.getState().set({ yolo: false, autonomy: 'off' });

    useSessionTabStore.getState().openTab('sess-a');
    expect(useLocalPrefs.getState().activeSessionId).toBe('sess-a');
    expect(useLocalPrefs.getState().yolo).toBe(true);
    expect(useLocalPrefs.getState().autonomy).toBe('eternal');

    useSessionTabStore.getState().openTab('sess-b');
    expect(useLocalPrefs.getState().yolo).toBe(false);
    expect(useLocalPrefs.getState().autonomy).toBe('off');
  });

  it('restores each tab’s subagent focus and never leaves a neighbour’s agent selected', () => {
    useUIStore.getState().setSubagentChatFocus('agent-a', 'sess-a');
    useUIStore.getState().setSubagentChatFocus('agent-b', 'sess-b');

    useSessionTabStore.getState().openTab('sess-a');
    expect(useUIStore.getState().subagentChatFocusId).toBe('agent-a');
    expect(useUIStore.getState().subagentChatFocusSessionId).toBe('sess-a');

    useSessionTabStore.getState().openTab('sess-b');
    expect(useUIStore.getState().subagentChatFocusId).toBe('agent-b');
    expect(useUIStore.getState().subagentChatFocusBySession['sess-a']).toBe('agent-a');
  });

  it('closes slash overlays when the foreground tab changes', () => {
    useUIStore.setState({ queuePanelOpen: true, processMonitorOpen: true, cronJobsOpen: true });
    useSessionTabStore.getState().openTab('sess-a');
    useUIStore.setState({ queuePanelOpen: true, processMonitorOpen: true, cronJobsOpen: true });

    useSessionTabStore.getState().openTab('sess-c');

    expect(useUIStore.getState().queuePanelOpen).toBe(false);
    expect(useUIStore.getState().processMonitorOpen).toBe(false);
    expect(useUIStore.getState().cronJobsOpen).toBe(false);
  });

  it('a background tab’s loading flag does not freeze the tab in front', () => {
    useSessionTabStore.getState().openTab('sess-a');
    chatLane('sess-b').setLoading(true);

    expect(readLane('sess-a').isLoading).toBe(false);
    expect(readLane('sess-b').isLoading).toBe(true);

    useSessionTabStore.getState().openTab('sess-b');
    expect(readLane('sess-b').isLoading).toBe(true);
    expect(readLane('sess-a').isLoading).toBe(false);
  });
});
