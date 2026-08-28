import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeStreakState } from '../../src/stores/auto-submit-streak';
import {
  chatLane,
  DEFAULT_LANE_ID,
  ensureLane,
  hasLane,
  useChatLanes,
} from '../../src/stores/chat-lanes';
import { useChimeraReportsStore } from '../../src/stores/chimera-reports-store';
import { useFleetStore } from '../../src/stores/fleet-store';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import {
  ensureSessionLane,
  hasSessionLane,
  SESSION_DEFAULT_LANE_ID,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import { describeSessionActivity, useSessionTabStore } from '../../src/stores/session-tab-store';
import { useToolStatsStore } from '../../src/stores/tool-stats-store';
import type { SubagentView } from '../../src/stores/types';
import { useUIStore } from '../../src/stores/ui-store';

// The streak/loop-guard state is module-private (a Map keyed by session), so
// the observable fact is that teardown asks for it to be dropped.
vi.mock('../../src/stores/auto-submit-streak', () => ({ disposeStreakState: vi.fn() }));

/**
 * A tab is retired through two doors, and both must free the same things.
 *
 * `closeTab` is the door the user opens. `setOpenTabIds` is the one the app
 * opens for them — the history purge dropping a session the server no longer
 * lists or a re-announce arriving for a session with no slot. The second door
 * used to free only the two lanes, so a tab retired that way left its
 * preference overrides and its auto-submit streak behind, and the NEXT session
 * handed that id silently inherited them.
 */

function openTabs(ids: string[]): void {
  for (const id of ids) {
    ensureLane(id);
    ensureSessionLane(id);
  }
  useSessionTabStore.setState({ openTabIds: ids, lastSeenCounts: {}, attention: {} });
}

function agent(id: string, sessionId: string, status: SubagentView['status']): SubagentView {
  return {
    id,
    sessionId,
    name: id,
    status,
    description: `Task for ${id}`,
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

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useFleetStore.setState({ agents: new Map(), leaderId: undefined } as never);
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

describe('running-tab warning inventory is session-scoped and complete', () => {
  it('names only the selected tab leader, running subagents, finished agents and queue', () => {
    openTabs(['tab-a', 'tab-b']);
    chatLane('tab-a').setLoading(true);
    chatLane('tab-a').enqueue('queued in a');
    chatLane('tab-b').setLoading(true);
    chatLane('tab-b').enqueue('queued in b');
    useFleetStore.setState({
      agents: new Map<string, SubagentView>([
        ['a-run', agent('a-run', 'tab-a', 'running')],
        ['a-done', agent('a-done', 'tab-a', 'completed')],
        ['b-run', agent('b-run', 'tab-b', 'running')],
      ]),
    } as never);

    const report = describeSessionActivity('tab-a');

    expect(report.isBusy).toBe(true);
    expect(report.leaderRunning).toBe(true);
    expect(report.runningAgents.map((a) => a.id)).toEqual(['a-run']);
    expect(report.finishedAgents).toBe(1);
    expect(report.queuedMessages).toBe(1);
    expect(report.lines.join('\n')).toContain('Leader run in progress');
    expect(report.lines.join('\n')).toContain('a-run');
    expect(report.lines.join('\n')).toContain('1 queued message');
    expect(report.lines.join('\n')).not.toContain('b-run');
    expect(report.lines.join('\n')).not.toContain('queued in b');
  });
});

describe('retiring a tab frees the same state through either door', () => {
  it('setOpenTabIds drops the lanes, the pref overrides and the streak', () => {
    openTabs(['tab-a', 'tab-b']);
    useLocalPrefs.getState().bindSession('tab-b');
    useLocalPrefs.getState().set({ yolo: true });
    useUIStore.getState().setSubagentChatFocus('agent-b', 'tab-b');
    useChimeraReportsStore.getState().recordReport({
      reportId: 'rep-b',
      sessionId: 'tab-b',
      message: 'Review for tab-b',
      findingCount: 1,
      fileCount: 1,
      hasActionableFindings: true,
      receivedAt: Date.now(),
      actionedAt: null,
      source: 'event',
    });
    useToolStatsStore.getState().recordToolStarted('tab-b', { name: 'read_file' });
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
    expect(useChimeraReportsStore.getState().bySession['tab-b']).toBeUndefined();
    expect(useToolStatsStore.getState().sessions['tab-b']).toBeUndefined();
  });

  it('closeTab leaves nothing behind either', () => {
    openTabs(['tab-a', 'tab-b']);
    useLocalPrefs.getState().bindSession('tab-b');
    useLocalPrefs.getState().set({ yolo: true });
    useChimeraReportsStore.getState().recordReport({
      reportId: 'rep-b-close',
      sessionId: 'tab-b',
      message: 'Review for tab-b',
      findingCount: 1,
      fileCount: 1,
      hasActionableFindings: true,
      receivedAt: Date.now(),
      actionedAt: null,
      source: 'event',
    });
    useToolStatsStore.getState().recordToolStarted('tab-b', { name: 'read_file' });

    useSessionTabStore.getState().closeTab('tab-b');

    expect(hasLane('tab-b')).toBe(false);
    expect(useLocalPrefs.getState().bySession['tab-b']).toBeUndefined();
    expect(useUIStore.getState().subagentChatFocusBySession['tab-b']).toBeUndefined();
    expect(useChimeraReportsStore.getState().bySession['tab-b']).toBeUndefined();
    expect(useToolStatsStore.getState().sessions['tab-b']).toBeUndefined();
  });

  it('a full strip resume refuses without retiring any non-empty tab owner', () => {
    openTabs(['tab-a', 'tab-b', 'tab-c', 'tab-used']);
    for (const id of ['tab-a', 'tab-b', 'tab-c']) {
      chatLane(id).addMessage({ role: 'user', content: `keep ${id}` });
    }
    chatLane('tab-used').addMessage({ role: 'user', content: 'keep this tab' });
    useLocalPrefs.getState().bindSession('tab-used');
    useLocalPrefs.getState().set({ yolo: true });
    const resumeSession = vi.fn();

    const outcome = useSessionTabStore.getState().openTab('tab-new', { resumeSession });

    expect(outcome).toEqual({ success: false, reason: 'tabs_full' });
    expect(useSessionTabStore.getState().openTabIds).toEqual([
      'tab-a',
      'tab-b',
      'tab-c',
      'tab-used',
    ]);
    expect(resumeSession).not.toHaveBeenCalled();
    expect(hasLane('tab-used')).toBe(true);
    expect(hasSessionLane('tab-used')).toBe(true);
    expect(useLocalPrefs.getState().bySession['tab-used']).toMatchObject({ yolo: true });
    expect(disposeStreakState).not.toHaveBeenCalledWith('tab-used');
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
