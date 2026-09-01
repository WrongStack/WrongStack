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
import {
  resetBootRestoreLatchForTests,
  restoreOpenTabsOnBoot,
  restoreTabsAfterBoot,
  useSessionTabStore,
  writeStoredTabs,
} from '../../src/stores/session-tab-store';
import { useRestoreTabsStore } from '../../src/stores/restore-tabs-store';
import { useUIStore } from '../../src/stores/ui-store';

/**
 * `restoreOpenTabsOnBoot` — the boot-time promoter that takes the
 * persisted `wrongstack.open_session_tabs` slot list and turns it into
 * active, foregrounded tabs at page load.
 *
 * Symmetric opposite of `releaseTab` (which retires a tab): every
 * persisted id gets its lane pair ensured, its per-session preferences
 * bound, its subagent focus rebinded, and the most-recently-visited id
 * (or the first stored id on a tie) is activated exactly as if the user
 * had clicked it. Finally the open set is declared to the WS client so
 * the server resumes broadcasts to every lane on the first paint.
 *
 * What this file covers, in order:
 *   1. Empty slot list — no-op, no WS call, foreground stays unbound.
 *   2. Single id — that id is foreground, WS gets one subscription.
 *   3. Four ids — every lane exists, all four are subscribed, the
 *      foreground is the most-recent `lastVisitedAt`.
 *   4. Ties broken by persisted `openTabIds` order so user intent wins.
 *   5. Per-tab rebind side-effects land exactly once per id (so a
 *      later `releaseTab` finds a clean `forgetSession` target).
 *   6. URL `?session=…` is rewritten to the foreground id.
 */

vi.mock('../../src/lib/ws-client', () => ({ getWSClient: vi.fn() }));

const subscribeSessions = vi.fn();
const wsMock = { subscribeSessions } as never;

const TAB_IDS = ['sess-a', 'sess-b', 'sess-c', 'sess-d'] as const;

function seedLanesWithVisitedAt(): void {
  // Seed each tab with a distinct `lastVisitedAt` so the picker can be
  // asserted deterministically. Order in `TAB_IDS` is the persisted
  // `openTabIds` order; ties are broken by that order.
  const visited: Record<string, number> = {
    'sess-a': 100,
    'sess-b': 400, // most recent
    'sess-c': 200,
    'sess-d': 300,
  };
  for (const id of TAB_IDS) {
    ensureLane(id);
    ensureSessionLane(id);
    useSessionLanes.setState((s) => ({
      lanes: {
        ...s.lanes,
        [id]: {
          ...(s.lanes[id] ?? {}),
          session: {
            id,
            startedAt: 1_700_000_000_000,
            provider: 'anthropic',
            model: 'anthropic-test-model',
            title: `tab ${id}`,
          },
          mode: 'review',
          contextMode: 'frugal',
          lastInputTokens: 0,
          lastVisitedAt: visited[id] ?? 0,
        },
      },
    }));
  }
}

function setWindowUrl(sessionId: string | null): void {
  const url = new URL(window.location.href);
  if (sessionId === null) url.searchParams.delete('session');
  else url.searchParams.set('session', sessionId);
  window.history.replaceState({}, '', url.toString());
}

beforeEach(() => {
  localStorage.clear();
  subscribeSessions.mockClear();
  vi.mocked(getWSClient).mockReturnValue(wsMock);
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useFleetStore.setState({ agents: new Map() } as never);
  useLocalPrefs.setState({ bySession: {}, activeSessionId: null });
  useHistoryStore.setState({ entries: [] } as never);
  useUIStore.setState({
    subagentChatFocusId: null,
    subagentChatFocusSessionId: null,
    queuePanelOpen: false,
    processMonitorOpen: false,
    cronJobsOpen: false,
  });
  setWindowUrl(null);
});

describe('restoreOpenTabsOnBoot', () => {
  it('is a no-op when no tabs were persisted', () => {
    // A truly fresh boot has no `wrongstack.open_session_tabs` entry; the
    // promoter must not invent one or wake the WS client.
    expect(restoreOpenTabsOnBoot({ now: 1_000 })).toEqual([]);
    expect(subscribeSessions).not.toHaveBeenCalled();
    expect(useChatLanes.getState().activeSessionId).toBe(DEFAULT_LANE_ID);
    expect(useSessionLanes.getState().activeSessionId).toBe(SESSION_DEFAULT_LANE_ID);
  });

  it('restores a single tab as the foreground and subscribes once', () => {
    seedLanesWithVisitedAt();
    writeStoredTabs(['sess-b']);
    // Replace the store state with what `useSessionTabStore` would have
    // picked up at module init from the persisted key.
    useSessionTabStore.setState({ openTabIds: ['sess-b'] });

    expect(restoreOpenTabsOnBoot({ now: 1_000 })).toEqual(['sess-b']);

    expect(useSessionLanes.getState().activeSessionId).toBe('sess-b');
    expect(useChatLanes.getState().activeSessionId).toBe('sess-b');
    // The single tab is also the foreground so the subscription list
    // contains it exactly once.
    expect(subscribeSessions).toHaveBeenCalledTimes(1);
    expect(subscribeSessions.mock.calls[0]?.[0]).toEqual(['sess-b']);
  });

  it('restores every tab with its lane and declares the full set to the WS', () => {
    seedLanesWithVisitedAt();
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });

    expect(restoreOpenTabsOnBoot({ now: 1_000 })).toEqual([...TAB_IDS]);

    // Every persisted id has a chat lane AND a session lane.
    const lanes = useChatLanes.getState().lanes;
    const sessionLanes = useSessionLanes.getState().lanes;
    for (const id of TAB_IDS) {
      expect(id in lanes).toBe(true);
      expect(id in sessionLanes).toBe(true);
    }

    // The full set was declared to the WS client so broadcasts resume
    // for every lane on the first paint.
    expect(subscribeSessions).toHaveBeenCalledTimes(1);
    expect(subscribeSessions.mock.calls[0]?.[0]).toEqual([...TAB_IDS]);
  });

  it('picks the most-recent `lastVisitedAt` as the foreground', () => {
    seedLanesWithVisitedAt();
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });

    restoreOpenTabsOnBoot({ now: 1_000 });

    // `sess-b` has the largest `lastVisitedAt` (400) — it must become the
    // foreground in BOTH lane registries and the URL.
    expect(useSessionLanes.getState().activeSessionId).toBe('sess-b');
    expect(useChatLanes.getState().activeSessionId).toBe('sess-b');
    expect(window.location.search).toContain('session=sess-b');
  });

  it('breaks ties on `lastVisitedAt` by the persisted `openTabIds` order', () => {
    seedLanesWithVisitedAt();
    // Force every tab to share the same `lastVisitedAt` so the picker
    // falls back to the persisted order.
    useSessionLanes.setState((s) => {
      const next = { ...s.lanes };
      for (const id of TAB_IDS) next[id] = { ...next[id]!, lastVisitedAt: 999 };
      return { lanes: next };
    });
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });

    restoreOpenTabsOnBoot({ now: 1_000 });

    // First in the persisted order wins on a tie.
    expect(useSessionLanes.getState().activeSessionId).toBe('sess-a');
    expect(useChatLanes.getState().activeSessionId).toBe('sess-a');
  });

  it('binds per-session preferences for every tab', () => {
    // Every id must show up in `useLocalPrefs.bySession` after the restore
    // so a later `bindSession(id)` returns ITS overrides, not defaults
    // leaked from another tab. The foreground is bound twice in total —
    // once by the per-tab loop and once by the `activate()` call that
    // points the foreground — but `bindSession` is idempotent (returns
    // an empty patch when the active id is unchanged), so the redundant
    // call is harmless and what we assert here is that EVERY id is bound
    // at least once, never zero times.
    seedLanesWithVisitedAt();
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });

    const bindSpy = vi.spyOn(useLocalPrefs.getState(), 'bindSession');

    restoreOpenTabsOnBoot({ now: 1_000 });

    const calledWith = new Set(bindSpy.mock.calls.map(([id]) => id));
    for (const id of TAB_IDS) {
      expect(calledWith.has(id)).toBe(true);
    }
    // At minimum, every id appears once. The redundant foreground bind
    // makes the upper bound `TAB_IDS.length + 1`; we don't pin that
    // because it would couple the test to the `activate()` call site.
    expect(bindSpy.mock.calls.length).toBeGreaterThanOrEqual(TAB_IDS.length);
    bindSpy.mockRestore();
  });

  it('leaves a restored strip intact when a fifth session arrives and every record has content', () => {
    // Restored slots carry REAL persisted history (boot-restore ensures
    // lanes without replaying transcripts, so their in-memory emptiness
    // lies) — the recycle predicate must consult the history record and
    // refuse, not silently replace a slot the user is still reading.
    seedLanesWithVisitedAt();
    writeStoredTabs([...TAB_IDS]);
    useHistoryStore.setState({
      entries: TAB_IDS.map((id) => ({
        id,
        title: id,
        startedAt: '2026-01-01T00:00:00Z',
        model: 'm',
        provider: 'p',
        tokenTotal: 1_000,
        messageCount: 4,
        isCurrent: false,
      })),
    });
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });

    restoreOpenTabsOnBoot({ now: 1_000 });

    const result = useSessionTabStore.getState().openTab('brand-new');

    expect(result).toEqual({ success: false, reason: 'tabs_full' });
    expect(useSessionTabStore.getState().openTabIds).toEqual([...TAB_IDS]);
  });
});

/**
 * `restoreTabsAfterBoot` — the server-driven wrapper.
 *
 * The tab strip lives in `localStorage`, so it outlives the process that made
 * it. Promoting it blindly is what made a fresh `wstack --webui` open wearing
 * the previous run's tabs, front a conversation from days ago, and sit through
 * a full journal resume — todo board and all — before the user typed anything.
 */
describe('restoreTabsAfterBoot', () => {
  beforeEach(() => {
    resetBootRestoreLatchForTests();
    useRestoreTabsStore.setState({ candidates: [] });
  });

  it('a restarted server keeps NO stale tab, so the strip opens empty', () => {
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    // The runtime holds only its own brand-new session; none of the persisted
    // ids are its.
    const kept = restoreTabsAfterBoot(['sess-fresh']);

    expect(kept).toEqual([]);
    expect(useSessionTabStore.getState().openTabIds).toEqual([]);
    expect(localStorage.getItem('wrongstack.open_session_tabs')).toBe('[]');
    // Nothing fronted, nothing subscribed — `handleSessionStart` then opens the
    // announced session as the single tab.
    expect(subscribeSessions).not.toHaveBeenCalled();
    // Offered, not resumed: the work is not lost, it is a question.
    expect(useRestoreTabsStore.getState().candidates).toEqual([...TAB_IDS]);
  });

  it('offers only the tabs the runtime dropped, never the ones it kept', () => {
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    restoreTabsAfterBoot(['sess-a', 'sess-c']);

    expect(useRestoreTabsStore.getState().candidates).toEqual(['sess-b', 'sess-d']);
  });

  it('asks nothing when every tab survived', () => {
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    restoreTabsAfterBoot([...TAB_IDS]);

    expect(useRestoreTabsStore.getState().candidates).toEqual([]);
  });

  it('asks nothing when the server could not answer', () => {
    // `undefined` restores unfiltered, so nothing was dropped and there is
    // nothing to offer.
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    restoreTabsAfterBoot(undefined);

    expect(useRestoreTabsStore.getState().candidates).toEqual([]);
  });

  it('keeps exactly the tabs the runtime still holds', () => {
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    const kept = restoreTabsAfterBoot(['sess-a', 'sess-c']);

    expect(kept).toEqual(['sess-a', 'sess-c']);
    expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-a', 'sess-c']);
    expect(subscribeSessions).toHaveBeenCalledWith(['sess-a', 'sess-c']);
  });

  it('an F5 against a live server restores every tab', () => {
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    const kept = restoreTabsAfterBoot([...TAB_IDS]);

    expect(kept).toEqual([...TAB_IDS]);
    expect(subscribeSessions).toHaveBeenCalledWith([...TAB_IDS]);
  });

  it('a server that cannot answer restores the strip unfiltered', () => {
    // `undefined` is "no answer", NOT "nothing is live" — collapsing the two
    // would wipe the user's tabs on every open against an older server.
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    const kept = restoreTabsAfterBoot(undefined);

    expect(kept).toEqual([...TAB_IDS]);
  });

  it('runs once per page load — a later frame cannot re-front the user', () => {
    writeStoredTabs([...TAB_IDS]);
    useSessionTabStore.setState({ openTabIds: [...TAB_IDS] });
    seedLanesWithVisitedAt();

    restoreTabsAfterBoot([...TAB_IDS]);
    subscribeSessions.mockClear();
    // A second boot frame (re-announce, model switch) must not re-run the
    // picker and yank the user off the tab they are reading.
    expect(restoreTabsAfterBoot(['sess-a'])).toEqual([]);
    expect(useSessionTabStore.getState().openTabIds).toEqual([...TAB_IDS]);
    expect(subscribeSessions).not.toHaveBeenCalled();
  });
});
