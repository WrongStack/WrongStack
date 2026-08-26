import { beforeEach, describe, expect, it } from 'vitest';

/**
 * "Which tab is in front" has exactly one answer: the lane pointer.
 *
 * Two weaker stand-ins used to be read on the SEND path, and both mis-addressed
 * runs in a four-tab window:
 *
 *   - the foreground lane's `SessionInfo` record, which is null between opening
 *     a tab and its `session.start` landing;
 *   - the WS client's own `sessionId`, which is whichever session announced
 *     LAST on the socket — routinely a background tab.
 *
 * A message typed in tab 2 while either stood in was stamped with tab 1's
 * session: the run started there, tab 2's `isLoading` never cleared (no
 * `run.result` for a session it never ran, so the idle tab reported itself
 * busy), and when tab 1 was mid-run the server answered "Agent.run() is already
 * in progress on this instance".
 */

const { foregroundSessionId } = await import('../../src/lib/ws-client-utils');
const { ensureSessionLane, sessionLane, setActiveSessionLane, useSessionLanes } = await import(
  '../../src/stores/session-lanes'
);
const { useChatLanes } = await import('../../src/stores/chat-lanes');

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
});

describe('foregroundSessionId', () => {
  it('is null before any session is bound', () => {
    expect(foregroundSessionId()).toBeNull();
  });

  it('follows the lane pointer', () => {
    setActiveSessionLane('sess_a');
    expect(foregroundSessionId()).toBe('sess_a');

    setActiveSessionLane('sess_b');
    expect(foregroundSessionId()).toBe('sess_b');
  });

  it('names the tab in front even before its session.start has landed', () => {
    // A tab the user just clicked: the lane exists and is in front, but nothing
    // has filled in its SessionInfo yet.
    setActiveSessionLane('sess_fresh');
    expect(useSessionLanes.getState().lanes['sess_fresh']?.session).toBeNull();

    expect(foregroundSessionId()).toBe('sess_fresh');
  });

  it('never names a background tab that happens to hold a SessionInfo', () => {
    ensureSessionLane('sess_background');
    sessionLane('sess_background').setSession({
      id: 'sess_background',
      startedAt: 0,
      model: 'm',
      provider: 'p',
    });
    // `setSession` through the LANE must not move the pointer.
    setActiveSessionLane('sess_front');

    expect(foregroundSessionId()).toBe('sess_front');
  });
});

describe('lane pointers move as a pair', () => {
  it('re-points the chat surface with the accounting surface', () => {
    setActiveSessionLane('sess_a');
    expect(useChatLanes.getState().activeSessionId).toBe('sess_a');

    setActiveSessionLane('sess_b');
    expect(useChatLanes.getState().activeSessionId).toBe('sess_b');
  });
});
