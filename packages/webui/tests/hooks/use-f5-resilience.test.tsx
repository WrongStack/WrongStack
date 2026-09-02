import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const showPanel = vi.fn();
vi.mock('@/components/activity-bar/nav', () => ({ showPanel }));

const { useUIStore, useSessionStore, useChatStore, useConfigStore } = await import(
  '../../src/stores'
);
const { useF5Resilience } = await import('../../src/hooks/useF5Resilience');
const { DEFAULT_LANE_ID, ensureLane, laneIds, MAX_LANES, useChatLanes } = await import(
  '../../src/stores/chat-lanes'
);
const { ensureSessionLane, SESSION_DEFAULT_LANE_ID, sessionLaneIds, useSessionLanes } =
  await import('../../src/stores/session-lanes');
const { useLocalPrefs } = await import('../../src/stores/local-prefs');
const { useSessionTabStore } = await import('../../src/stores/session-tab-store');

/** Point window.location.pathname at `path` for one test. */
function setPath(path: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname: path },
    writable: true,
    configurable: true,
  });
}

type PersistApi = { flush?: () => void };

const PERSISTED_STORES = [useSessionStore, useChatStore, useUIStore, useConfigStore];

/** Attach a fake `flush()` to each persist API and return the spies. */
function withFlush(impl: () => void = () => undefined) {
  return PERSISTED_STORES.map((s) => {
    const spy = vi.fn(impl);
    (s.persist as unknown as PersistApi).flush = spy;
    return spy;
  });
}

function removeFlush() {
  for (const s of PERSISTED_STORES) {
    delete (s.persist as unknown as PersistApi).flush;
  }
}

describe('useF5Resilience — persist flush', () => {
  beforeEach(() => {
    showPanel.mockReset();
    setPath('/');
    useUIStore.setState({ currentView: 'chat' } as never);
    removeFlush();
  });

  afterEach(() => {
    removeFlush();
    vi.restoreAllMocks();
  });

  it('skips stores whose persist API has no flush() — the zustand 5 shape', () => {
    // zustand 5's persist API exposes setOptions/clearStorage/rehydrate/
    // hasHydrated/getOptions but NOT flush, so with the shipped middleware
    // this loop is a no-op. The `typeof === 'function'` guard is what keeps
    // that from throwing on every page teardown.
    expect((useUIStore.persist as unknown as PersistApi).flush).toBeUndefined();
    renderHook(() => useF5Resilience());
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
  });

  it('flushes every persisted store on pagehide when flush() is available', () => {
    const spies = withFlush();
    renderHook(() => useF5Resilience());
    window.dispatchEvent(new Event('pagehide'));
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('flushes on beforeunload as well', () => {
    const spies = withFlush();
    renderHook(() => useF5Resilience());
    window.dispatchEvent(new Event('beforeunload'));
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing flush — teardown is best-effort', () => {
    withFlush(() => {
      throw new Error('storage full');
    });
    renderHook(() => useF5Resilience());
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
  });

  it('stops at the first throwing store — the try/catch wraps the whole loop', () => {
    const spies = withFlush();
    spies[0].mockImplementation(() => {
      throw new Error('storage full');
    });
    renderHook(() => useF5Resilience());
    window.dispatchEvent(new Event('pagehide'));
    expect(spies[0]).toHaveBeenCalled();
    expect(spies[3]).not.toHaveBeenCalled();
  });

  it('detaches both listeners on unmount', () => {
    const spies = withFlush();
    const { unmount } = renderHook(() => useF5Resilience());
    unmount();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('useF5Resilience — view fallback', () => {
  beforeEach(() => {
    showPanel.mockReset();
    setPath('/');
  });

  it.each(['debug', 'analytics', 'design-gallery', 'setup'])(
    'redirects the exotic persisted view %s to chat',
    (view) => {
      useUIStore.setState({ currentView: view } as never);
      renderHook(() => useF5Resilience());
      expect(showPanel).toHaveBeenCalledWith('chat');
    },
  );

  it.each(['chat', 'kanban', 'files', 'terminal'])('leaves the ordinary view %s alone', (view) => {
    useUIStore.setState({ currentView: view } as never);
    renderHook(() => useF5Resilience());
    expect(showPanel).not.toHaveBeenCalled();
  });

  it.each(['/debug', '/analytics', '/refresh-debug'])(
    'does not redirect when the user navigated to %s directly',
    (path) => {
      setPath(path);
      useUIStore.setState({ currentView: 'debug' } as never);
      renderHook(() => useF5Resilience());
      expect(showPanel).not.toHaveBeenCalled();
    },
  );

  it('still redirects from an unrelated path', () => {
    setPath('/some/other/route');
    useUIStore.setState({ currentView: 'analytics' } as never);
    renderHook(() => useF5Resilience());
    expect(showPanel).toHaveBeenCalledWith('chat');
  });

  it('only evaluates the fallback once per mount', () => {
    useUIStore.setState({ currentView: 'debug' } as never);
    const { rerender } = renderHook(() => useF5Resilience());
    rerender();
    rerender();
    expect(showPanel).toHaveBeenCalledTimes(1);
  });
});

describe('useF5Resilience — lane/slot reconciliation', () => {
  beforeEach(() => {
    showPanel.mockReset();
    setPath('/');
    localStorage.clear();
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
    useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
    useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
    useLocalPrefs.setState({ bySession: {}, activeSessionId: null });
    useUIStore.setState({
      subagentChatFocusId: null,
      subagentChatFocusSessionId: null,
    } as never);
  });

  it('sweeps a session lane whose chat lane is gone — it jams the accounting ceiling', () => {
    // A session lane restored without its chat-lane twin (partial write or an
    // older build) is invisible to the chat-registry sweep yet still counts
    // against the four-lane ceiling in `sessionFor`.
    ensureSessionLane('sess-orphan');

    renderHook(() => useF5Resilience());

    expect(sessionLaneIds()).not.toContain('sess-orphan');
  });

  it('keeps slotted lanes, the session pointer, and live chat-lane pairs', () => {
    ensureLane('tab-live');
    ensureSessionLane('tab-live');
    ensureSessionLane('sess-ptr');
    useSessionTabStore.setState({ openTabIds: ['tab-live'] });
    useSessionLanes.setState({ activeSessionId: 'sess-ptr' });

    renderHook(() => useF5Resilience());

    expect(laneIds()).toContain('tab-live');
    expect(sessionLaneIds()).toEqual(expect.arrayContaining(['tab-live', 'sess-ptr']));
  });

  it('releases persisted per-session chrome of a lane dropped at boot', () => {
    // The reconcile retires through releaseTab, so the preference overrides
    // and subagent focus of a boot-dropped lane do not survive for a reused
    // session id to inherit.
    ensureLane('tab-orphan');
    ensureSessionLane('tab-orphan');
    useLocalPrefs.setState({ bySession: { 'tab-orphan': { provider: 'p' } } } as never);
    useUIStore.setState({
      subagentChatFocusId: 'agent-1',
      subagentChatFocusSessionId: 'tab-orphan',
    } as never);

    renderHook(() => useF5Resilience());

    expect(laneIds()).not.toContain('tab-orphan');
    expect(sessionLaneIds()).not.toContain('tab-orphan');
    expect('tab-orphan' in useLocalPrefs.getState().bySession).toBe(false);
    expect(useUIStore.getState().subagentChatFocusId).toBeNull();
    expect(useUIStore.getState().subagentChatFocusSessionId).toBeNull();
  });

  it('recovers accounting headroom after a partial write orphans session lanes', () => {
    // Partial-write shape: chat-lanes (the heavy key — it carries transcripts)
    // persisted only sess-a, while session-lanes (the light key) kept all
    // four. Before the session sweep, the three chat-lane-less orphans
    // counted against the four-lane ceiling inside `sessionFor`, so a NEW
    // session's tokens and cost were silently dropped.
    ensureLane('sess-a');
    ensureSessionLane('sess-a');
    ensureSessionLane('sess-b');
    ensureSessionLane('sess-c');
    ensureSessionLane('sess-d');
    useSessionTabStore.setState({ openTabIds: ['sess-a'] });
    useSessionLanes.setState({ activeSessionId: 'sess-a' });

    renderHook(() => useF5Resilience());

    // The live pair survives; the three orphans are gone…
    expect(sessionLaneIds()).toEqual(['sess-a']);
    // …and the exact gate `sessionFor` checks before creating a new lane has
    // headroom again — no accounting-ceiling jam.
    expect(sessionLaneIds().length).toBeLessThan(MAX_LANES);
  });
});
