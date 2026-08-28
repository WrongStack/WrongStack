import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Four sessions, four parallel runs, one page — the end-to-end leak sweep.
 *
 * Boots four tabs (requestedSwitch grants + session.start), drives four
 * runs INTERLEAVED so frames from different sessions share the same drain
 * windows, switches the foreground mid-stream, raises a tool confirm for a
 * BACKGROUND tab, and then asserts nothing crossed lanes:
 *
 *   - transcripts hold only their own session's markers;
 *   - session-lane token totals keep their per-session fingerprints;
 *   - fleet rosters stay session-scoped (agentBelongsToSession);
 *   - a background tab's approval parks on ITS lane (pendingConfirm +
 *     attention) and re-opens when that tab comes back to the front.
 */

const send = vi.fn();
const wsClient = {
  send,
  listSavedProviders: vi.fn(),
  requestedSwitch: null as string | null,
  consumeRequestedSwitch(sessionId: string): boolean {
    if (!sessionId || wsClient.requestedSwitch !== sessionId) return false;
    wsClient.requestedSwitch = null;
    return true;
  },
};
vi.mock('../../src/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const toast = { success: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock('../../src/components/Toaster', () => ({ toast }));

vi.mock('../../src/lib/view-navigation', () => ({
  navigateToView: vi.fn(),
  showPanel: vi.fn(),
  isRoutePinnedView: () => false,
  resetUiNavigationToHome: vi.fn(),
}));
vi.mock('../../src/lib/desktop-shell', () => ({ isDesktopShell: () => false }));

const { useFleetStore, useSessionTabStore } = await import('../../src/stores');
const { readLane, useChatLanes } = await import('../../src/stores/chat-lanes');
const {
  readSessionLane,
  sessionLane,
  useSessionLanes,
} = await import('../../src/stores/session-lanes');
const { handleSessionStart } = await import('../../src/hooks/ws-handlers/session-handlers');
const {
  handleIterationStarted,
  handleTextDelta,
  handleToolConfirmNeeded,
} = await import('../../src/hooks/ws-handlers/chat-handlers');
const { handleSubagentEvent } = await import('../../src/hooks/ws-handlers/fleet-handlers');
const { agentBelongsToSession } = await import('../../src/lib/agent-session');
const { streamCoalescer } = await import('../../src/lib/stream-coalescer');

const IDS = ['s1', 's2', 's3', 's4'] as const;

function start(sessionId: string): void {
  wsClient.requestedSwitch = sessionId;
  handleSessionStart({
    type: 'session.start',
    payload: { sessionId, model: 'm', provider: 'p', reset: true },
  } as never);
}

function mark(text: string, sessionId: string): void {
  handleTextDelta({
    type: 'provider.text_delta',
    payload: { sessionId, text, messageId: `msg-${sessionId}` },
  } as never);
}

async function drain(): Promise<void> {
  streamCoalescer.flushAll();
  await Promise.resolve();
  await Promise.resolve();
}

function seedRunningAgent(sessionId: string): void {
  handleSubagentEvent({
    type: 'subagent.event',
    payload: { kind: 'spawned', subagentId: `agent-${sessionId}`, sessionId, name: `W-${sessionId}` },
  } as never);
  handleSubagentEvent({
    type: 'subagent.event',
    payload: {
      kind: 'task_started',
      subagentId: `agent-${sessionId}`,
      sessionId,
      currentTool: 'read',
    },
  } as never);
}

describe('four sessions, four parallel runs — end-to-end leak sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsClient.requestedSwitch = null;
    useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
    useFleetStore.setState({ agents: new Map(), leaderId: undefined });
    useSessionLanes.setState({ activeSessionId: null });
  });

  it('keeps transcripts, tokens, fleet rosters and parked approvals session-scoped', async () => {
    // ── Boot: four tabs, each foregrounded in turn, each registered ──
    for (const id of IDS) {
      start(id);
      useSessionTabStore.getState().openTab(id);
    }
    expect(useSessionLanes.getState().activeSessionId).toBe('s4');

    // ── Fleet: one running subagent per session ──
    for (const id of IDS) seedRunningAgent(id);

    // ── Tokens: a distinct usage fingerprint per session lane ──
    IDS.forEach((id, i) => {
      sessionLane(id).patch({
        totalTokens: { input: 100 * (i + 1), output: 10 * (i + 1), cacheRead: 0, cacheWrite: 0 },
      });
    });

    // ── Three interleaved streaming rounds — the foreground is never the
    // last writer (reverse order) ──
    for (let round = 1; round <= 3; round += 1) {
      for (const id of [...IDS].reverse()) {
        handleIterationStarted({
          type: 'iteration.started',
          payload: { sessionId: id, index: round, maxIterations: 10 },
        } as never);
        mark(`MARKER-${id}-r${round} `, id);
      }
      await drain();
    }
    await drain();

    // ── Mid-stream foreground switch back to s1 while s2..s4 stream ──
    start('s1');
    expect(useSessionLanes.getState().activeSessionId).toBe('s1');

    // Background sessions keep streaming — frames must still reach THEIR
    // lanes, not the one in front.
    mark('LATE-s2 ', 's2');
    mark('LATE-s3 ', 's3');
    await drain();

    // ── A tool confirm raised by the BACKGROUND s2 parks on ITS lane ──
    handleToolConfirmNeeded({
      type: 'tool.confirm_needed',
      payload: {
        id: 'confirm-s2',
        toolName: 'bash',
        input: { cmd: 'rm -rf /tmp/x' },
        sessionId: 's2',
        suggestedPattern: '',
        boundaryReason: 'policy',
      },
    } as never);
    await drain();

    // ── Transcript isolation ──
    for (const id of IDS) {
      const content = readLane(id)
        .messages.map((m) => m.content)
        .join('\n');
      for (const other of IDS) {
        if (other === id) continue;
        expect(content).not.toContain(`MARKER-${other}`);
        expect(content).not.toContain(`LATE-${other}`);
      }
      expect(content).toContain(`MARKER-${id}`);
    }
    expect(readLane('s2').messages.map((m) => m.content).join('\n')).toContain('LATE-s2');
    expect(readLane('s1').messages.map((m) => m.content).join('\n')).not.toContain('LATE-s2');

    // ── Token isolation ──
    IDS.forEach((id, i) => {
      const meta = readSessionLane(id);
      expect(meta.totalTokens.input).toBe(100 * (i + 1));
      expect(meta.totalTokens.output).toBe(10 * (i + 1));
    });

    // ── Fleet isolation ──
    const agents = [...useFleetStore.getState().agents.values()];
    expect(agents).toHaveLength(4);
    for (const id of IDS) {
      const mine = agents.filter((a) => agentBelongsToSession(a.sessionId, id));
      expect(mine).toHaveLength(1);
      expect(mine[0]?.sessionId).toBe(id);
    }

    // ── Confirm bubble: parked on the asking lane, foreground untouched ──
    expect(readLane('s2').pendingConfirm?.id).toBe('confirm-s2');
    expect(useSessionTabStore.getState().attention['s2']).toBe(true);
    for (const id of IDS) {
      if (id === 's2') continue;
      expect(readLane(id).pendingConfirm).toBeNull();
    }

    // ── Switch to s2: activate() re-opens ITS parked confirm ──
    start('s2');
    expect(useSessionLanes.getState().activeSessionId).toBe('s2');
    expect(readLane('s2').pendingConfirm?.id).toBe('confirm-s2');
  });
});
