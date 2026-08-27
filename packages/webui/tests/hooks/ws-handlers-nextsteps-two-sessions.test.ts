import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────
// The next-steps pipeline under test runs entirely through the WS handlers
// and the real lane store: tool.started → per-session tool-input map, then
// tool.executed → per-session completed map, then run.result → the owning
// lane's assistant message. Mock the side-effecty bits (favicon, chime,
// notify, ws-client) exactly like the streaming suite so the routing path is
// exercised end to end with the real stores.

vi.mock('@/lib/favicon', () => ({ setFaviconStatus: vi.fn() }));
vi.mock('@/lib/chime', () => ({
  playCompletionChime: vi.fn(),
  playPermissionChime: vi.fn(),
}));
vi.mock('@/lib/notify', () => ({
  ensureNotificationPermission: vi.fn(),
  notifyIfHidden: vi.fn(),
}));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send: vi.fn() }) }));

// ── SUT (imported after mocks) ────────────────────────────────────────────
import {
  handleRunResult,
  handleToolExecuted,
  handleToolStarted,
} from '../../src/hooks/ws-handlers/chat-handlers';
import { streamCoalescer } from '../../src/lib/stream-coalescer';
import { disposeLane, useChatLanes } from '../../src/stores/chat-lanes';
import type { WSServerMessage } from '../../src/types';

const SESSION_A = 'sess_a';
const SESSION_B = 'sess_b';

function nextStepsStarted(
  sessionId: string,
  toolId: string,
  steps: Array<{ text: string; auto?: boolean }>,
): WSServerMessage {
  return {
    type: 'tool.started',
    payload: { id: toolId, name: 'nextsteps', input: { steps }, sessionId },
  } as unknown as WSServerMessage;
}

function nextStepsExecuted(sessionId: string, toolId: string, ok = true): WSServerMessage {
  return {
    type: 'tool.executed',
    payload: { id: toolId, name: 'nextsteps', ok, output: '', sessionId },
  } as unknown as WSServerMessage;
}

function runResult(sessionId: string, status = 'done'): WSServerMessage {
  return {
    type: 'run.result',
    payload: { status, iterations: 1, sessionId },
  } as unknown as WSServerMessage;
}

beforeEach(() => {
  // Fresh lanes, no active tab — events must route purely by their own
  // `payload.sessionId`, exactly as they do when a window holds several tabs.
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  streamCoalescer.dropAll();
});

afterEach(() => {
  streamCoalescer.dropAll();
});

describe('next-steps survive interleaved runs across two sessions', () => {
  const stepsA = [{ text: 'Run lane A tests', auto: true }, { text: 'Review lane A diff' }];
  const stepsB = [{ text: 'Refactor lane B store' }];

  it("keeps each session's nextsteps tool output in its own lane", () => {
    // Both tabs start their nextsteps tools while the other is mid-flight.
    handleToolStarted(nextStepsStarted(SESSION_A, 'tool_a', stepsA));
    handleToolStarted(nextStepsStarted(SESSION_B, 'tool_b', stepsB));
    // B's tool completes first, then A's — completions interleave.
    // (With a single module-global completed map, B's run.result would
    // pick up A's steps — or consume them before A's run ended.)
    handleToolExecuted(nextStepsExecuted(SESSION_B, 'tool_b'));
    handleToolExecuted(nextStepsExecuted(SESSION_A, 'tool_a'));
    // B's run ends while A's is still finishing, then A's ends.
    handleRunResult(runResult(SESSION_B));
    handleRunResult(runResult(SESSION_A));

    const laneA = useChatLanes.getState().lanes[SESSION_A];
    const laneB = useChatLanes.getState().lanes[SESSION_B];
    expect(laneA).toBeDefined();
    expect(laneB).toBeDefined();

    const assistantSteps = (lane: typeof laneA | undefined) =>
      lane?.messages
        .filter((m) => m.role === 'assistant' && (m.nextSteps?.steps.length ?? 0) > 0)
        .map((m) => m.nextSteps?.steps.map((s) => s.text)) ?? [];

    // Each lane has exactly one suggestion-bearing assistant message, and it
    // carries that session's own steps — even though B finished last.
    expect(assistantSteps(laneA)).toEqual([stepsA.map((s) => s.text)]);
    expect(assistantSteps(laneB)).toEqual([stepsB.map((s) => s.text)]);

    // Tool bubbles route the same way: each lane owns only its own tool id.
    expect(laneA?.messages.filter((m) => m.role === 'tool').map((m) => m.toolUseId)).toEqual([
      'tool_a',
    ]);
    expect(laneB?.messages.filter((m) => m.role === 'tool').map((m) => m.toolUseId)).toEqual([
      'tool_b',
    ]);

    // Nothing from the other session's transcript leaks into either lane.
    const laneAText = JSON.stringify(laneA?.messages);
    const laneBText = JSON.stringify(laneB?.messages);
    expect(laneAText).not.toContain('Refactor lane B store');
    expect(laneBText).not.toContain('Run lane A tests');
  });

  it('a second run.result for the same session does not duplicate its steps', () => {
    handleToolStarted(nextStepsStarted(SESSION_A, 'tool_a', stepsA));
    handleToolExecuted(nextStepsExecuted(SESSION_A, 'tool_a'));
    handleRunResult(runResult(SESSION_A));
    // A duplicate broadcast (reconnect recovery, double-ack) must not add a
    // second suggestion bar — nor consume another session's completed map.
    handleRunResult(runResult(SESSION_A));

    const laneA = useChatLanes.getState().lanes[SESSION_A];
    const withSteps = laneA?.messages.filter((m) => (m.nextSteps?.steps.length ?? 0) > 0);
    expect(withSteps).toHaveLength(1);
    expect(withSteps?.[0]?.nextSteps?.steps.map((s) => s.text)).toEqual(stepsA.map((s) => s.text));
    // The second run.result left B (never touched) with no lane at all.
    expect(useChatLanes.getState().lanes[SESSION_B]).toBeUndefined();
  });

  it('a failing nextsteps tool never becomes suggestion chips', () => {
    handleToolStarted(nextStepsStarted(SESSION_A, 'tool_a', stepsA));
    handleToolExecuted(nextStepsExecuted(SESSION_A, 'tool_a', false));
    handleRunResult(runResult(SESSION_A));

    const laneA = useChatLanes.getState().lanes[SESSION_A];
    expect(laneA?.messages.filter((m) => (m.nextSteps?.steps.length ?? 0) > 0)).toHaveLength(0);
    // Bookkeeping is consumed; a later run cannot inherit the failed attempt.
    expect(laneA?.messages).toHaveLength(1); // only the tool bubble
  });

  it('releases a retired session so its steps cannot resurface', () => {
    handleToolStarted(nextStepsStarted(SESSION_A, 'tool_a', stepsA));
    handleToolExecuted(nextStepsExecuted(SESSION_A, 'tool_a'));
    // The tab closed: disposing the lane must take the handler maps with it
    // (via the onLaneDisposed subscription), not leave the completed steps in
    // a module map where a reused id would resurrect them.
    disposeLane(SESSION_A);
    // A late run.result for the retired id (or a brand-new tab that reused
    // it) must not render the disposed session's steps anywhere.
    handleRunResult(runResult(SESSION_A));

    // chatFor re-creates a lane on first write, so check the RECREATED lane:
    // it may exist, but it must be free of the retired session's suggestions.
    const laneA = useChatLanes.getState().lanes[SESSION_A];
    expect(laneA?.messages.filter((m) => (m.nextSteps?.steps.length ?? 0) > 0)).toHaveLength(0);
    const laneAText = JSON.stringify(laneA?.messages);
    expect(laneAText).not.toContain('Run lane A tests');
  });
});
