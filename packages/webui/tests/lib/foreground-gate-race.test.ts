import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The foreground-only gate during the FRESH-TAB window.
 *
 * `isActiveSessionMessage` used to read `useSessionStore().session?.id` — the
 * foreground lane's SessionInfo record, which is null from the moment a tab
 * is activated until its `session.start` lands. The `!activeId` allowance
 * then failed OPEN, and a tagged event for ANOTHER tab sailed through into
 * foreground-only surfaces (brain status, memory diagnostics) exactly in
 * that window.
 *
 * The gate now reads the lane pointer, which answers from the instant the
 * tab changes. These tests pin the race itself: pointer moved, record not
 * yet arrived, foreign event rejected.
 */

const { isActiveSessionMessage } = await import('../../src/lib/ws-client-utils');
const { setActiveSessionLane, useSessionLanes } = await import(
  '../../src/stores/session-lanes'
);
const { useChatLanes } = await import('../../src/stores/chat-lanes');
const { useSessionStore } = await import('../../src/stores/session-store');

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useSessionStore.setState({ session: null });
});

describe('foreground gate in the fresh-tab window', () => {
  it('rejects another tab’s tagged event before session.start lands', () => {
    // The race, exactly: the pointer already names tab B, tab B's SessionInfo
    // record has not arrived, so session?.id is still null.
    setActiveSessionLane('sess_b');
    expect(useSessionStore.getState().session?.id ?? null).toBeNull();

    expect(isActiveSessionMessage({ payload: { sessionId: 'sess_a' } } as never)).toBe(
      false,
    );
    expect(isActiveSessionMessage({ payload: { sessionId: 'sess_b' } } as never)).toBe(
      true,
    );
  });

  it('keeps the pre-session allowance: untagged passes, empty-string never widens', () => {
    // No session bound at all — boot/setup. Untagged project-wide broadcasts
    // must still pass; the empty-string stamp must never widen to "everyone".
    expect(isActiveSessionMessage({ payload: {} } as never)).toBe(true);
    expect(isActiveSessionMessage({ payload: { sessionId: '' } } as never)).toBe(false);
  });

  // Deliberately NOT tested: "pointer wins when the record disagrees". The
  // session-store facade re-points the lane when the record is written, so a
  // disagreeing record is an unreachable synthetic state here — the real race
  // is record-null-while-pointer-bound (pinned by the first test above).
});
