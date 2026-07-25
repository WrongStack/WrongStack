import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────
// handleRunResult touches several side-effecty modules on a `done` run
// (favicon, chime, notify, ws-client). We stub them so the test can focus on
// the DOM-event side effect: expanding the collapsed input via the
// `chat:session-end` event before the next-step countdown fires.
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

describe('handleRunResult → input-expand on completion', () => {
  let sessionEndSpy: EventListener & ReturnType<typeof vi.fn>;
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

    sessionEndSpy = vi.fn() as EventListener & ReturnType<typeof vi.fn>;
    countdownSpy = vi.fn() as EventListener & ReturnType<typeof vi.fn>;
    document.addEventListener('chat:session-end', sessionEndSpy);
    document.addEventListener('chat:next-step-countdown', countdownSpy);
  });

  afterEach(() => {
    document.removeEventListener('chat:session-end', sessionEndSpy);
    document.removeEventListener('chat:next-step-countdown', countdownSpy);
    vi.restoreAllMocks();
  });

  it('dispatches chat:session-end (expand input) on a done run with an empty queue', () => {
    handleRunResult(runResult('done'));

    expect(sessionEndSpy).toHaveBeenCalledTimes(1);
    // The countdown must also fire so the suggestion lands in the now-visible input.
    expect(countdownSpy).toHaveBeenCalledTimes(1);
  });

  it('skips chat:session-end when a follow-up message is queued (run continues)', () => {
    useChatStore.getState().enqueue('a queued follow-up');

    handleRunResult(runResult('done'));

    expect(sessionEndSpy).not.toHaveBeenCalled();
    // Countdown is likewise suppressed mid-flow — the run isn't settling yet.
    expect(countdownSpy).not.toHaveBeenCalled();
  });

  it('does not dispatch chat:session-end on a non-done (error) run', () => {
    handleRunResult(runResult('error'));

    expect(sessionEndSpy).not.toHaveBeenCalled();
    expect(countdownSpy).not.toHaveBeenCalled();
  });
});
