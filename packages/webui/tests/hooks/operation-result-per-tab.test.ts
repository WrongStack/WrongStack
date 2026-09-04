import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleKeyOperationResult } from '../../src/hooks/ws-handlers/session-context-handlers';
import {
  DEFAULT_LANE_ID,
  ensureLane,
  setActiveLane,
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
 * `key.operation_result` is the server's general-purpose "did that work?"
 * channel — provider keys, prefs, session operations, MCP, git, shell, the
 * worklist. It is reached from ~90 call sites and, until B-05, carried no
 * session at all.
 *
 * One WebSocket connection serves up to four tabs, so an unaddressed result
 * meant a background tab's "Commit failed" popped a toast on whichever tab the
 * user happened to be reading — with nothing naming the tab it came from — and
 * the tab that actually failed showed no trace of it when switched to. Every
 * other surface in this app routes positively; this one did not.
 *
 * The server now stamps the asking tab at the dispatch boundary. These tests
 * pin the browser half of that contract.
 */

const toasts: Array<{ kind: 'success' | 'error'; message: string }> = [];
vi.mock('@/components/Toaster', () => ({
  toast: {
    success: (message: string) => toasts.push({ kind: 'success', message }),
    error: (message: string) => toasts.push({ kind: 'error', message }),
    info: () => {},
    warn: () => {},
  },
}));

const listSavedProviders = vi.fn();
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ listSavedProviders }),
}));

const result = (payload: Record<string, unknown>): WSServerMessage =>
  ({ type: 'key.operation_result', payload }) as unknown as WSServerMessage;

function withTabs(ids: string[]): void {
  for (const id of ids) {
    ensureLane(id);
    ensureSessionLane(id);
  }
  useSessionTabStore.setState({ openTabIds: ids, lastSeenCounts: {}, attention: {} });
}

beforeEach(() => {
  toasts.length = 0;
  listSavedProviders.mockClear();
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
});

describe('an operation result belongs to the tab that asked', () => {
  it('toasts a result for the tab in front', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleKeyOperationResult(
      result({ success: false, message: 'Commit failed', sessionId: 'tab-a' }),
    );

    expect(toasts).toEqual([{ kind: 'error', message: 'Commit failed' }]);
    expect(useSessionTabStore.getState().attention['tab-a']).toBeFalsy();
  });

  it('flags a background tab instead of toasting its failure over the tab in front', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleKeyOperationResult(
      result({ success: false, message: 'Commit failed', sessionId: 'tab-b' }),
    );

    // Nothing on screen — this is not tab A's answer.
    expect(toasts).toEqual([]);
    // …and it is not lost either: the strip says tab B needs a look.
    expect(useSessionTabStore.getState().attention['tab-b']).toBe(true);
  });

  /**
   * A background success is the one case worth staying quiet about entirely:
   * pulling the user to another tab to tell them something worked is noise,
   * and the tab already reflects the new state when they get there.
   */
  it('stays silent for a background success and does not flag the tab', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleKeyOperationResult(result({ success: true, message: 'Saved', sessionId: 'tab-b' }));

    expect(toasts).toEqual([]);
    expect(useSessionTabStore.getState().attention['tab-b']).toBeFalsy();
  });

  /**
   * A result raised outside a dispatch — a watcher, a timer — genuinely has no
   * asking tab. Those keep the old behaviour rather than being swallowed.
   */
  it('falls back to the tab in front when the result names no session', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleKeyOperationResult(result({ success: true, message: 'Watcher restarted' }));

    expect(toasts).toEqual([{ kind: 'success', message: 'Watcher restarted' }]);
  });

  // Pre-existing behaviour worth keeping pinned: tab swaps and resumes emit
  // results too, and they are routine navigation, not something to announce.
  it.each(['Resumed session abc', 'Session is already active', 'Swapped session to abc'])(
    'stays silent for the navigation result %s',
    (message) => {
      withTabs(['tab-a']);
      setActiveLane('tab-a');
      handleKeyOperationResult(result({ success: true, message, sessionId: 'tab-a' }));
      expect(toasts).toEqual([]);
    },
  );

  /**
   * The provider re-fetch this handler makes was unconditional, on every result
   * from every tab. It is still unconditional for the foreground (deciding
   * from the message PROSE which results touch providers would be a worse bug
   * than the extra round trip) but a background tab no longer triggers it.
   */
  it('does not re-fetch providers for a background tab’s result', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleKeyOperationResult(result({ success: false, message: 'nope', sessionId: 'tab-b' }));
    expect(listSavedProviders).not.toHaveBeenCalled();

    handleKeyOperationResult(result({ success: true, message: 'yes', sessionId: 'tab-a' }));
    expect(listSavedProviders).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed payload without throwing', () => {
    withTabs(['tab-a']);
    setActiveLane('tab-a');
    expect(() => handleKeyOperationResult(result({ success: true }))).not.toThrow();
    expect(toasts).toEqual([]);
  });
});
