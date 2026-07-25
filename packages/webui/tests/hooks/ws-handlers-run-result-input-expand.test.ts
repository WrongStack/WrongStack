import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────
// handleRunResult touches several side-effecty modules on a `done` run
// (favicon, chime, notify, ws-client). We stub them so the test can focus on
// the DOM-event side effect: starting the next-step countdown.
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

// ── SUT (imported after mocks) ────────────────────────────────────────────
import { handleRunResult } from '../../src/hooks/ws-handlers/chat-handlers';
import { useChatStore } from '../../src/stores/chat-store';
import type { WSServerMessage } from '../../src/types';

/** Build a `run.result` message for the active (unbound) session. Matches the
 *  shape the existing streaming tests use so it passes isActiveSessionMessage. */
function runResult(status: 'done' | 'error'): WSServerMessage {
  return {
    type: 'run.result',
    payload: { status, iterations: 1, finalText: 'ok' },
  } as unknown as WSServerMessage;
}

describe('handleRunResult → next-step countdown on completion', () => {
  let countdownSpy: EventListener & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Fresh store: no queued follow-ups, a run in progress with one message.
    useChatStore.setState({
      queue: [],
      messages: [],
      currentAssistantMessageId: null,
      runStart: { at: Date.now() - 1000, cost: 0 },
    });
    useChatStore.getState().setLoading(true);

    countdownSpy = vi.fn() as EventListener & ReturnType<typeof vi.fn>;
    document.addEventListener('chat:next-step-countdown', countdownSpy);
  });

  afterEach(() => {
    document.removeEventListener('chat:next-step-countdown', countdownSpy);
    vi.restoreAllMocks();
  });

  it('dispatches chat:next-step-countdown on a done run with an empty queue', () => {
    handleRunResult(runResult('done'));

    expect(countdownSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches chat:next-step-countdown before a queued follow-up continues', () => {
    useChatStore.getState().enqueue('a queued follow-up');

    handleRunResult(runResult('done'));

    expect(countdownSpy).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch chat:next-step-countdown on a non-done (error) run', () => {
    handleRunResult(runResult('error'));

    expect(countdownSpy).not.toHaveBeenCalled();
  });
});
