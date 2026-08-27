import { beforeEach, describe, expect, it } from 'vitest';
import { handleSessionRunState } from '../../src/hooks/ws-handlers/chat-handlers';
import { chatFor } from '../../src/lib/ws-client-utils';
import {
  chatLane,
  DEFAULT_LANE_ID,
  ensureLane,
  hasLane,
  laneIds,
  readLane,
  useChatLanes,
} from '../../src/stores/chat-lanes';
import {
  ensureSessionLane,
  SESSION_DEFAULT_LANE_ID,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import { useSessionTabStore } from '../../src/stores/session-tab-store';
import type { WSServerMessage } from '../../src/types';

/**
 * Two ways a tab goes quiet without anything looking broken.
 *
 * The four-lane ceiling is deliberately hard — an event for a fifth session is
 * dropped rather than delivered to the wrong tab. That makes ORPHAN lanes
 * expensive: a lane whose slot is gone still occupies the ceiling, so the tab
 * the user just opened is the one whose events disappear.
 *
 * And a lane's spinner is stopped by `run.result`, which is broadcast once. A
 * tab whose run ended while the socket was down never hears it.
 */

const msg = (type: string, payload: Record<string, unknown>): WSServerMessage =>
  ({ type, payload }) as unknown as WSServerMessage;

function withTabs(ids: string[]): void {
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
});

describe('a lane with no tab does not keep a real tab out', () => {
  it('reclaims the slot-less lane so the new session gets one', () => {
    withTabs(['tab-a', 'tab-b', 'tab-c']);
    // A tab that was closed while its run was still emitting: the lane came
    // back on the next event, with no slot to call its own.
    ensureLane('ghost');
    expect(laneIds()).toHaveLength(4);

    const lane = chatFor(msg('provider.text_delta', { sessionId: 'tab-d', text: 'hi' }));

    expect(lane).not.toBeNull();
    expect(hasLane('ghost')).toBe(false);
    expect(hasLane('tab-d')).toBe(true);
  });

  it('still refuses a fifth session when all four lanes have tabs', () => {
    withTabs(['tab-a', 'tab-b', 'tab-c', 'tab-d']);

    const lane = chatFor(msg('provider.text_delta', { sessionId: 'tab-e', text: 'hi' }));

    // Dropping is the right answer here: delivering it would put one tab's
    // tokens in another tab's transcript.
    expect(lane).toBeNull();
    expect(hasLane('tab-e')).toBe(false);
  });

  it('never reclaims a lane that is still streaming', () => {
    withTabs(['tab-a', 'tab-b', 'tab-c']);
    ensureLane('ghost');
    chatLane('ghost').setLoading(true);

    const lane = chatFor(msg('provider.text_delta', { sessionId: 'tab-d', text: 'hi' }));

    expect(lane).toBeNull();
    expect(hasLane('ghost')).toBe(true);
  });
});

describe('session.run_state reconciles a tab’s spinner', () => {
  it('stops a spinner whose run ended while the socket was down', () => {
    withTabs(['tab-a', 'tab-b']);
    chatLane('tab-b').setLoading(true);

    handleSessionRunState(msg('session.run_state', { sessionId: 'tab-b', isRunning: false }));

    expect(readLane('tab-b').isLoading).toBe(false);
    // …and only that tab.
    expect(readLane('tab-a').isLoading).toBe(false);
  });

  it('marks a background tab that is still running', () => {
    withTabs(['tab-a', 'tab-b']);

    handleSessionRunState(msg('session.run_state', { sessionId: 'tab-b', isRunning: true }));

    expect(readLane('tab-b').isLoading).toBe(true);
    expect(readLane('tab-a').isLoading).toBe(false);
  });

  it('is dropped for a session no tab is showing', () => {
    withTabs(['tab-a', 'tab-b', 'tab-c', 'tab-d']);
    useChatLanes.setState({ activeSessionId: 'tab-a' });
    chatLane('tab-a').setLoading(true);

    handleSessionRunState(msg('session.run_state', { sessionId: 'tab-z', isRunning: false }));

    // Positive routing: an answer with nowhere to land is dropped, never
    // applied to whichever tab happens to be in front.
    expect(readLane('tab-a').isLoading).toBe(true);
  });
});
