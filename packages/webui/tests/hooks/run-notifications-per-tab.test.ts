import { beforeEach, describe, expect, it, vi } from 'vitest';

// The completion path touches favicon, audio, notifications and the ws client.
// Only the notification and toast side effects are under test here.
vi.mock('@/lib/favicon', () => ({ setFaviconStatus: vi.fn() }));
vi.mock('@/lib/chime', () => ({
  playCompletionChime: vi.fn(),
  playPermissionChime: vi.fn(),
}));
vi.mock('@/lib/notify', () => ({
  ensureNotificationPermission: vi.fn(),
  notifyIfHidden: vi.fn(),
}));
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: vi.fn(), sendMessage: vi.fn() }),
}));
vi.mock('@/components/Toaster', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { toast } from '@/components/Toaster';
import { notifyIfHidden } from '@/lib/notify';
import { handleRunResult } from '../../src/hooks/ws-handlers/chat-handlers';
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
import { useUIStore } from '../../src/stores/ui-store';
import type { WSServerMessage } from '../../src/types';

/**
 * A run ends in one tab, so it must be announced as one tab's.
 *
 * Toasts and desktop notifications are page-wide surfaces. A background tab's
 * "Run ended: …" toast lands on top of whatever conversation the user is
 * actually reading, with nothing in the text to say it belongs to another one —
 * the user reads it as this tab's failure. And every run notification shared a
 * single tag, so the browser collapsed four tabs' completions into whichever
 * arrived last: three finished runs the user was never told about.
 */

const runResult = (sessionId: string, status: 'done' | 'error'): WSServerMessage =>
  ({
    type: 'run.result',
    payload: {
      sessionId,
      status,
      iterations: 2,
      ...(status === 'error' ? { error: { message: 'boom' } } : { finalText: 'ok' }),
    },
  }) as unknown as WSServerMessage;

function withTabs(ids: string[]): void {
  for (const id of ids) {
    ensureLane(id);
    ensureSessionLane(id);
  }
  useSessionTabStore.setState({ openTabIds: ids, lastSeenCounts: {}, attention: {} });
}

/** The page is in the background — the only state in which runs notify. */
function hidePage(): void {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
}

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useUIStore.setState({ sessionNicknames: {} });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(notifyIfHidden).mockClear();
  hidePage();
});

describe('a finished run is announced as its own tab’s', () => {
  it('does not toast a background tab’s failure over the tab in front', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleRunResult(runResult('tab-b', 'error'));

    expect(toast.error).not.toHaveBeenCalled();
    // The strip carries it instead, so the failure is not lost.
    expect(useSessionTabStore.getState().attention['tab-b']).toBe(true);
  });

  it('still toasts a failure in the tab the user is reading', () => {
    withTabs(['tab-a']);
    setActiveLane('tab-a');

    handleRunResult(runResult('tab-a', 'error'));

    expect(toast.error).toHaveBeenCalled();
  });

  it('names the tab in a background failure notification', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');
    useUIStore.setState({ sessionNicknames: { 'tab-b': 'refactor' } });

    handleRunResult(runResult('tab-b', 'error'));

    const [title, , tag] = vi.mocked(notifyIfHidden).mock.calls[0] ?? [];
    expect(title).toContain('refactor');
    // Per-session tag: the browser collapses same-tag notifications, and four
    // tabs sharing one tag means three completions are silently swallowed.
    expect(tag).toBe('wrongstack-run:tab-b');
  });

  it('does not toast a background tab’s completion either', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleRunResult(runResult('tab-b', 'done'));

    expect(toast.success).not.toHaveBeenCalled();
    expect(useSessionTabStore.getState().attention['tab-b']).toBe(true);
    const [, , tag] = vi.mocked(notifyIfHidden).mock.calls[0] ?? [];
    expect(tag).toBe('wrongstack-run:tab-b');
  });

  it('toasts a completion that belongs to the tab in front', () => {
    withTabs(['tab-a']);
    setActiveLane('tab-a');

    handleRunResult(runResult('tab-a', 'done'));

    expect(toast.success).toHaveBeenCalled();
    expect(useSessionTabStore.getState().attention['tab-a']).toBeFalsy();
  });
});
