import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleProviderFallback,
  handleProviderFallbackPending,
} from '../../src/hooks/ws-handlers/session-execution-handlers';
import {
  DEFAULT_LANE_ID,
  ensureLane,
  readLane,
  resolvePendingFallback,
  setActiveLane,
  useChatLanes,
} from '../../src/stores/chat-lanes';
import { useFallbackStore } from '../../src/stores/fallback-store';
import {
  ensureSessionLane,
  SESSION_DEFAULT_LANE_ID,
  useSessionLanes,
} from '../../src/stores/session-lanes';
import { useSessionTabStore } from '../../src/stores/session-tab-store';
import type { WSServerMessage } from '../../src/types';

/**
 * The provider-fallback dialog is one global surface serving four tabs.
 *
 * It asks a blocking question — "this model returned 429, switch to what?" —
 * and the run that raised it is stopped until someone answers. The browser used
 * to drop the event outright unless it came from the tab in front, which meant
 * a background tab's run sat behind a question that was never rendered until
 * the server's own countdown expired and switched the model for it. The user
 * never saw the failure, never chose the route, and found the conversation
 * running on a different model.
 *
 * So the prompt is parked on the lane that hit the failure, exactly like the
 * tool-approval prompt: the tab flags for attention, activating it raises the
 * dialog, and answering it — or the switch settling on its own — retires the
 * parked copy wherever that tab is.
 */

const msg = (type: string, payload: Record<string, unknown>): WSServerMessage =>
  ({ type, payload }) as unknown as WSServerMessage;

const pendingPayload = (sessionId: string, requestId: string) => ({
  sessionId,
  requestId,
  from: { providerId: 'openai', model: 'gpt-x' },
  status: 429,
  candidates: [{ providerId: 'anthropic', model: 'claude-x' }],
  autoSwitchSeconds: 20,
});

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
  useFallbackStore.setState({ pending: null, selected: 0 });
});

describe('a fallback question belongs to the tab that raised it', () => {
  it('parks a background tab’s prompt and flags the tab instead of dropping it', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleProviderFallbackPending(msg('provider.fallback_pending', pendingPayload('tab-b', 'r1')));

    // Nothing on screen — tab A is in front and this is not its question.
    expect(useFallbackStore.getState().pending).toBeNull();
    // …but it is not lost, and the strip says so.
    expect(readLane('tab-b').pendingFallback?.requestId).toBe('r1');
    expect(useSessionTabStore.getState().attention['tab-b']).toBe(true);
  });

  it('shows the prompt immediately when it belongs to the tab in front', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');

    handleProviderFallbackPending(msg('provider.fallback_pending', pendingPayload('tab-a', 'r1')));

    expect(useFallbackStore.getState().pending?.requestId).toBe('r1');
    // Parked as well, so switching away and back does not lose the question.
    expect(readLane('tab-a').pendingFallback?.requestId).toBe('r1');
    expect(useSessionTabStore.getState().attention['tab-a']).toBeFalsy();
  });

  it('raises the parked prompt when its tab comes to the front, and only then', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');
    handleProviderFallbackPending(msg('provider.fallback_pending', pendingPayload('tab-b', 'r1')));

    useSessionTabStore.getState().openTab('tab-b');
    expect(useFallbackStore.getState().pending?.requestId).toBe('r1');

    // Switching away takes the dialog down with the tab: a modal that outlives
    // its conversation answers for the wrong one.
    useSessionTabStore.getState().openTab('tab-a');
    expect(useFallbackStore.getState().pending).toBeNull();
    expect(readLane('tab-b').pendingFallback?.requestId).toBe('r1');
  });

  it('retires the parked copy when the user answers', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');
    handleProviderFallbackPending(msg('provider.fallback_pending', pendingPayload('tab-b', 'r1')));

    // What the modal does on send.
    resolvePendingFallback('r1');

    expect(readLane('tab-b').pendingFallback).toBeNull();
  });

  it('retires a background tab’s parked prompt when the switch settles by itself', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');
    handleProviderFallbackPending(msg('provider.fallback_pending', pendingPayload('tab-b', 'r1')));

    handleProviderFallback(
      msg('provider.fallback', {
        sessionId: 'tab-b',
        requestId: 'r1',
        from: { providerId: 'openai', model: 'gpt-x' },
        to: { providerId: 'anthropic', model: 'claude-x' },
        status: 429,
        providerSwitched: true,
      }),
    );

    expect(readLane('tab-b').pendingFallback).toBeNull();
    // Activating it later must not resurrect a dialog for a decided question.
    useSessionTabStore.getState().openTab('tab-b');
    expect(useFallbackStore.getState().pending).toBeNull();
  });

  it('leaves another tab’s visible dialog standing when a different tab falls back', () => {
    withTabs(['tab-a', 'tab-b']);
    setActiveLane('tab-a');
    handleProviderFallbackPending(msg('provider.fallback_pending', pendingPayload('tab-a', 'r-a')));

    handleProviderFallback(
      msg('provider.fallback', {
        sessionId: 'tab-b',
        requestId: 'r-b',
        from: { providerId: 'openai', model: 'gpt-x' },
        to: { providerId: 'anthropic', model: 'claude-x' },
        status: 429,
        providerSwitched: true,
      }),
    );

    // Tab A is still waiting on its own answer.
    expect(useFallbackStore.getState().pending?.requestId).toBe('r-a');
  });

  it('takes the dialog down when the last tab holding it closes', () => {
    withTabs(['tab-a']);
    setActiveLane('tab-a');
    handleProviderFallbackPending(msg('provider.fallback_pending', pendingPayload('tab-a', 'r1')));
    expect(useFallbackStore.getState().pending?.requestId).toBe('r1');

    useSessionTabStore.getState().closeTab('tab-a');

    // With nothing in front there is no activation to clear it, and answering
    // it would send a model choice for a conversation that no longer exists.
    expect(useFallbackStore.getState().pending).toBeNull();
  });

  it('drops a fallback prompt for a session no tab owns', () => {
    withTabs(['tab-a', 'tab-b', 'tab-c', 'tab-d']);
    setActiveLane('tab-a');

    handleProviderFallbackPending(
      msg('provider.fallback_pending', pendingPayload('stranger', 'r')),
    );

    // Better unanswered than answered on someone else's behalf.
    expect(useFallbackStore.getState().pending).toBeNull();
  });
});
