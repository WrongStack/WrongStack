import { beforeEach, describe, expect, it } from 'vitest';
import { handleSessionsList } from '../../src/hooks/ws-handlers/session-execution-handlers';
import { DEFAULT_LANE_ID, ensureLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useHistoryStore } from '../../src/stores/history-store';
import {
  ensureSessionLane,
  SESSION_DEFAULT_LANE_ID,
  setActiveSessionLane,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import { useSessionTabStore } from '../../src/stores/session-tab-store';
import type { SessionHistoryEntry } from '../../src/stores/types';

/**
 * The session catalogue is shared; its "current" marker is not.
 *
 * `isCurrent` disables the resume button on that row, is the whole of the
 * `active` filter, and spares a row from the empty-session sweep. One frame
 * can only carry one answer to it, and `session.new` BROADCASTS a catalogue
 * to every socket — which told three other tabs that the session just opened
 * in a fourth was theirs. So the flag is settled in the browser, where the
 * foreground session is actually known.
 */

function entry(id: string, isCurrent: boolean): SessionHistoryEntry {
  return {
    id,
    title: id,
    startedAt: '2026-08-28T00:00:00.000Z',
    model: 'm',
    provider: 'p',
    tokenTotal: 0,
    isCurrent,
  };
}

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
  useHistoryStore.setState({ entries: [], loading: false, error: null });
});

describe('the catalogue marks the tab in front', () => {
  it('re-points a frame that named a different tab', () => {
    openTabs(['tab-1', 'tab-2']);
    setActiveSessionLane('tab-2');

    // A frame answered about (or broadcast for) tab-1.
    handleSessionsList({
      type: 'sessions.list',
      payload: { sessions: [entry('tab-1', true), entry('tab-2', false)] },
    } as never);

    const entries = useHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === 'tab-2')?.isCurrent).toBe(true);
    expect(entries.find((e) => e.id === 'tab-1')?.isCurrent).toBe(false);
  });

  it('keeps the server’s answer while no tab is bound', () => {
    // Before the first `session.start` there is no foreground to compare to;
    // overwriting the flag with "nothing is current" would blank the list's
    // active row on a cold load.
    handleSessionsList({
      type: 'sessions.list',
      payload: { sessions: [entry('tab-1', true)] },
    } as never);

    expect(useHistoryStore.getState().entries[0]?.isCurrent).toBe(true);
  });

  it('follows the tab strip when the user switches tabs', () => {
    openTabs(['tab-1', 'tab-2']);
    setActiveSessionLane('tab-1');
    handleSessionsList({
      type: 'sessions.list',
      payload: { sessions: [entry('tab-1', true), entry('tab-2', false)] },
    } as never);

    // `openTab` on an already-open session is the switch path.
    useSessionTabStore.getState().openTab('tab-2');

    const entries = useHistoryStore.getState().entries;
    expect(entries.find((e) => e.id === 'tab-2')?.isCurrent).toBe(true);
    expect(entries.find((e) => e.id === 'tab-1')?.isCurrent).toBe(false);
  });
});
