import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `swapTabSession` — the client half of `session.new { replaceSessionId }`.
 *
 * The contract under test: the retired session's TAB survives, its SLOT
 * index does not move, everything the retired session owned is released, and
 * the strip length never changes — so a full four-tab strip can be cleared
 * without tripping the ceiling an `openTab` would hit.
 */

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    send: vi.fn(),
    focusSessionById: vi.fn(),
    subscribeSessions: vi.fn(),
  }),
}));

import {
  chatLane,
  disposeLane,
  hasLane,
  readLane,
  setActiveLane,
} from '../../src/stores/chat-lanes.js';
import { activeSessionLaneId, setActiveSessionLane } from '../../src/stores/session-lanes.js';
import { readStoredTabs, useSessionTabStore } from '../../src/stores/session-tab-store.js';

beforeEach(() => {
  localStorage.clear();
  for (const id of ['sess-a', 'sess-b', 'sess-c', 'sess-d', 'sess-fresh']) {
    disposeLane(id);
  }
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  // Foreground = BOTH lane pointers (chat-lanes + session-lanes), exactly
  // what activate() sets — a test that moves only one is testing nothing.
  setActiveLane(null);
  setActiveSessionLane('__unbound__');
});

describe('swapTabSession', () => {
  it("hands the retired FOREGROUND session's slot to the replacement in place", () => {
    useSessionTabStore.setState({ openTabIds: ['sess-a', 'sess-b'] });
    chatLane('sess-a').addMessage({ role: 'user', content: 'old run' });
    chatLane('sess-b').addMessage({ role: 'user', content: 'other tab' });
    setActiveLane('sess-a');
    setActiveSessionLane('sess-a');
    useSessionTabStore.getState().setAttention('sess-a', true);

    useSessionTabStore.getState().swapTabSession('sess-a', 'sess-fresh');

    // Same slot order, same length: the strip never gained a tab.
    expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-fresh', 'sess-b']);
    // The foreground followed the slot.
    expect(activeSessionLaneId()).toBe('sess-fresh');
    // The retired session's lane and per-tab records are gone...
    expect(hasLane('sess-a')).toBe(false);
    expect(useSessionTabStore.getState().attention['sess-a']).toBeUndefined();
    // ...while the untouched tab keeps everything.
    expect(readLane('sess-b').messages.map((m) => m.content)).toEqual(['other tab']);
    expect(activeSessionLaneId()).not.toBe('sess-b');
  });

  it('does not move the pointer when a BACKGROUND slot is swapped', () => {
    useSessionTabStore.setState({ openTabIds: ['sess-a', 'sess-b', 'sess-c', 'sess-d'] });
    chatLane('sess-a').addMessage({ role: 'user', content: 'front' });
    chatLane('sess-c').addMessage({ role: 'user', content: 'background' });
    setActiveLane('sess-a');
    setActiveSessionLane('sess-a');

    // Another surface retired a session this page holds in a background tab.
    useSessionTabStore.getState().swapTabSession('sess-c', 'sess-fresh');

    expect(useSessionTabStore.getState().openTabIds).toEqual([
      'sess-a',
      'sess-b',
      'sess-fresh',
      'sess-d',
    ]);
    expect(activeSessionLaneId()).toBe('sess-a');
    expect(hasLane('sess-c')).toBe(false);
  });

  it('keeps a full strip at exactly four slots — no ceiling hit', () => {
    useSessionTabStore.setState({
      openTabIds: ['sess-a', 'sess-b', 'sess-c', 'sess-d'],
    });
    setActiveLane('sess-d');
    setActiveSessionLane('sess-d');

    useSessionTabStore.getState().swapTabSession('sess-d', 'sess-fresh');

    const tabs = useSessionTabStore.getState().openTabIds;
    expect(tabs).toHaveLength(4);
    expect(tabs[3]).toBe('sess-fresh');
  });

  it('is a no-op when the retired session never had a tab here', () => {
    useSessionTabStore.setState({ openTabIds: ['sess-a'] });

    useSessionTabStore.getState().swapTabSession('sess-never-opened', 'sess-fresh');

    expect(useSessionTabStore.getState().openTabIds).toEqual(['sess-a']);
    expect(hasLane('sess-fresh')).toBe(false);
  });

  it('persists the swapped strip', () => {
    useSessionTabStore.setState({ openTabIds: ['sess-a', 'sess-b'] });

    useSessionTabStore.getState().swapTabSession('sess-a', 'sess-fresh');

    expect(readStoredTabs()).toEqual(['sess-fresh', 'sess-b']);
  });
});
