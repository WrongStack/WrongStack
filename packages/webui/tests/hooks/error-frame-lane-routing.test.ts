import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two error frames, two fates.
 *
 * 1. A context-op refusal ("Session X is not live in this runtime") carries
 *    `sessionId` of the ASKING tab and must land in THAT tab's lane — bubble
 *    plus `setLoading(false)` — even when the asking tab is in the background.
 * 2. A session-swap guard rejection carries `requestedSessionId` and is
 *    routing noise: it must vanish without touching any lane.
 *
 * The server keeps the two shapes distinct by NOT stamping
 * `requestedSessionId` on context-op refusals (see sendContextUnavailable in
 * webui-server session-handlers.ts). If these two tests ever disagree, that
 * payload contract drifted.
 */

const send = vi.fn();
const wsClient = { send, requestedSwitch: null as string | null };
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('@/components/Toaster', () => ({ toast }));

vi.mock('@/lib/view-navigation', () => ({
  navigateToView: vi.fn(),
  showPanel: vi.fn(),
  isRoutePinnedView: () => false,
  resetUiNavigationToHome: vi.fn(),
}));
vi.mock('@/lib/desktop-shell', () => ({ isDesktopShell: () => false }));

const { useChatStore } = await import('../../src/stores');
const { handleSessionStart, handleError } = await import(
  '../../src/hooks/ws-handlers/session-handlers'
);
const { handleIterationStarted } = await import('../../src/hooks/ws-handlers/chat-handlers');
const { readLane, useChatLanes } = await import('../../src/stores/chat-lanes');
const { streamCoalescer } = await import('../../src/lib/stream-coalescer');

/** The user asked for this session: it takes the foreground. */
function start(sessionId: string) {
  wsClient.requestedSwitch = sessionId;
  handleSessionStart({
    type: 'session.start',
    payload: { sessionId, model: 'm', provider: 'p', reset: true },
  } as never);
}

/** A run is live on the session, so its lane's loading flag is observable. */
function runStarted(sessionId: string) {
  handleIterationStarted({
    type: 'iteration.started',
    payload: { sessionId, index: 1, maxIterations: 10 },
  } as never);
}

describe('a context-op refusal reaches the tab that asked', () => {
  beforeEach(() => {
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })) as never;
    }
    streamCoalescer.flushAll();
    useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
    // tab A is the background requester; tab B is on screen.
    start('sess_front');
    start('sess_bg');
  });

  it('routes the refusal to the requesting background lane and unblocks it', () => {
    runStarted('sess_bg');
    expect(readLane('sess_bg').isLoading).toBe(true);

    handleError({
      type: 'error',
      payload: {
        sessionId: 'sess_bg',
        phase: 'context.compact',
        message:
          'Session sess_bg is not live in this runtime. Reopen or resume the tab, then refresh.',
      },
    } as never);

    // The refusal bubbles in the REQUESTING tab's own lane and clears its
    // run flag — the overlay must not hang on "Loading context snapshot…".
    const lane = readLane('sess_bg');
    expect(lane.isLoading).toBe(false);
    expect(lane.messages.at(-1)?.content).toContain('not live');
    expect(lane.messages.at(-1)?.isError).toBe(true);
    // The tab in front neither shows the error nor changes state.
    expect(useChatStore.getState().messages).toHaveLength(0);
    expect(readLane('sess_front').messages).toHaveLength(0);
  });

  it('keeps swallowing swap-guard rejections so the two shapes stay distinct', () => {
    runStarted('sess_bg');
    expect(readLane('sess_bg').isLoading).toBe(true);

    handleError({
      type: 'error',
      payload: {
        sessionId: 'sess_bg',
        phase: 'session.resume',
        message:
          'Request targeted session 2026-08-26/sess_old, but this WebUI runtime is currently on 2026-08-26/sess_bg.',
        requestedSessionId: '2026-08-26/sess_old',
      },
    } as never);

    // Routing noise: no bubble anywhere, the live run is left as it was.
    expect(readLane('sess_bg').messages).toHaveLength(0);
    expect(readLane('sess_bg').isLoading).toBe(true);
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});
