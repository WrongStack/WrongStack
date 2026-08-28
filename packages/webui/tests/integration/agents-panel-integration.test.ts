/**
 * Integration tests for the AgentsPanel data pipeline.
 *
 * Tests the full store action → selector → display data flow
 * that the AgentsPanel, FleetSummaryBar, AgentRosterCard, and
 * AgentDetailSection components consume.
 *
 * Component rendering is not possible in this test environment
 * (zustand v5 + useSyncExternalStore infinite loop with selectors
 * that return new references). Instead, we test the store actions
 * and selectors directly — the same data paths the components use.
 */

import { describe, expect, it } from 'vitest';
import {
  selectFleetSummary,
  selectLeaderName,
  selectSortedAgentList,
  useFleetStore,
} from '../../src/stores/index.js';

describe('AgentsPanel integration — full data pipeline', () => {
  beforeEach(() => {
    useFleetStore.setState({
      agents: new Map(),
      leaderId: undefined,
      fleetTokensIn: 0,
      fleetTokensOut: 0,
      fleetConcurrency: 0,
      fleetConcurrencyMax: 4,
      eventTimeline: [],
      agentTimeline: [],
      agentTranscripts: new Map(),
    });
  });

  // ── Spawn → sorted list → summary ───────────────────────────────

  it('spawns agents into the sorted list with correct ordering', () => {
    // Spawn agents in non-sorted order.
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'c',
      name: 'Charlie',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'Alpha',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'b',
      name: 'Beta',
    });

    const list = selectSortedAgentList(useFleetStore.getState());
    // All running → sorted by startedAt (oldest first).
    expect(list.map((a) => a.name)).toEqual(['Charlie', 'Alpha', 'Beta']);
  });

  it('sorted list places leader first regardless of spawn order', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'Alpha',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'b',
      name: 'Leader',
    });
    useFleetStore.getState().applyEvent({
      kind: 'leader_updated',
      subagentId: 'b',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'c',
      name: 'Charlie',
    });

    const list = selectSortedAgentList(useFleetStore.getState());
    expect(list[0].name).toBe('Leader');
    expect(list[1].name).toBe('Alpha');
    expect(list[2].name).toBe('Charlie');
  });

  it('summary updates after spawning and completing agents', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'A',
      sessionId: 'sess-a',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'b',
      name: 'B',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a',
      status: 'success',
    });

    const s = selectFleetSummary(useFleetStore.getState());
    expect(s.running).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.total).toBe(2);
  });

  // ── Filter simulation ───────────────────────────────────────────

  it('selectLeaderName returns the leader name', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'Captain',
    });
    useFleetStore.getState().applyEvent({
      kind: 'leader_updated',
      subagentId: 'a',
    });

    expect(selectLeaderName(useFleetStore.getState())).toBe('Captain');
  });

  it('selectLeaderName returns undefined when no leader', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'LoneWolf',
    });
    expect(selectLeaderName(useFleetStore.getState())).toBeUndefined();
  });

  // ── Tool log data ───────────────────────────────────────────────

  it('records tool execution with ok/fail status in toolLog', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Worker',
    });
    useFleetStore.getState().applyEvent({
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'read',
      ok: true,
    });
    useFleetStore.getState().applyEvent({
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'write',
      ok: false,
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.toolLog).toHaveLength(2);
    // Most recent first.
    expect(agent?.toolLog[0].name).toBe('write');
    expect(agent?.toolLog[0].ok).toBe(false);
    expect(agent?.toolLog[1].name).toBe('read');
    expect(agent?.toolLog[1].ok).toBe(true);
  });

  it('toolLog records durationMs', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Worker',
    });
    useFleetStore.getState().applyEvent({
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'bash',
      ok: true,
      durationMs: 1500,
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.toolLog[0].durationMs).toBe(1500);
  });

  // ── Partial text (streaming) ────────────────────────────────────

  it('updates partialText from iteration_summary', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Streamer',
    });
    useFleetStore.getState().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a1',
      partialText: 'Step 1…',
    });
    useFleetStore.getState().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a1',
      partialText: 'Step 2…',
    });

    expect(useFleetStore.getState().agents.get('a1')?.partialText).toBe('Step 2…');
  });

  it('partialText is absent when no iteration_summary fired', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Silent',
    });
    expect(useFleetStore.getState().agents.get('a1')?.partialText).toBeUndefined();
  });

  // ── Transcript data ─────────────────────────────────────────────

  it('pushAgentTimelineEntry stores transcript entries', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Talker',
    });
    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: 'a1',
      agentName: 'Talker',
      content: 'Hello',
      kind: 'text',
      iteration: 1,
      ts: new Date().toISOString(),
    });
    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: 'a1',
      agentName: 'Talker',
      content: 'Hmm…',
      kind: 'thinking',
      iteration: 2,
      ts: new Date().toISOString(),
    });

    const transcript = useFleetStore.getState().getAgentTranscript('a1');
    expect(transcript).toHaveLength(2);
    expect(transcript[0].kind).toBe('text');
    expect(transcript[1].kind).toBe('thinking');
  });

  // ── Clear finished ──────────────────────────────────────────────

  it('clearFinishedAgents removes non-running agents, preserves running', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'A',
      sessionId: 'sess-a',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a',
      status: 'success',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'b',
      name: 'B',
      sessionId: 'sess-a',
    });

    useFleetStore.getState().clearFinishedAgents('sess-a');
    expect(useFleetStore.getState().agents.has('a')).toBe(false);
    expect(useFleetStore.getState().agents.has('b')).toBe(true);
    expect(useFleetStore.getState().agents.size).toBe(1);
  });

  it('clearFinishedAgents with all running is a no-op', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'A',
      sessionId: 'sess-a',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'b',
      name: 'B',
      sessionId: 'sess-a',
    });

    useFleetStore.getState().clearFinishedAgents('sess-a');
    expect(useFleetStore.getState().agents.size).toBe(2);
  });

  // ── Timeline events ─────────────────────────────────────────────

  it('eventTimeline records spawned and completed events', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'A',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a',
      status: 'success',
    });

    const tl = useFleetStore.getState().eventTimeline;
    expect(tl.length).toBeGreaterThanOrEqual(2);
    // Most recent first.
    expect(tl[0].kind).toBe('task_completed');
    expect(tl[1].kind).toBe('spawned');
  });

  it('eventTimeline includes budget_warning events', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'A',
    });
    useFleetStore.getState().applyEvent({
      kind: 'budget_warning',
      subagentId: 'a',
      budgetKind: 'iterations',
      used: 8,
      limit: 10,
    });

    const tl = useFleetStore.getState().eventTimeline;
    expect(tl[0].kind).toBe('budget_warning');
    expect(tl[0].agentId).toBe('a');
  });

  // ── Empty state transitions ─────────────────────────────────────

  it('transitions from no-agents to has-agents state', () => {
    // Initially empty.
    expect(selectSortedAgentList(useFleetStore.getState())).toEqual([]);
    expect(selectFleetSummary(useFleetStore.getState()).total).toBe(0);

    // Spawn one.
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'First',
    });
    expect(selectSortedAgentList(useFleetStore.getState())).toHaveLength(1);
    expect(selectFleetSummary(useFleetStore.getState()).running).toBe(1);
  });

  it('transitions from has-agents to all-finished state', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'Worker',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a',
      status: 'success',
    });

    const s = selectFleetSummary(useFleetStore.getState());
    expect(s.running).toBe(0);
    expect(s.completed).toBe(1);
    expect(s.total).toBe(1);
  });

  // ── Concurrency and token updates ───────────────────────────────

  it('fleet-wide tokens update via ctx_pct events', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a',
      name: 'A',
    });
    useFleetStore.getState().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a',
      load: 0.5,
      tokens: 1000,
      tokensIn: 600,
      tokensOut: 400,
    });

    const state = useFleetStore.getState();
    expect(state.fleetTokensIn).toBe(600);
    expect(state.fleetTokensOut).toBe(400);
    expect(selectFleetSummary(state).tokensIn).toBe(600);
  });

  it('fleetConcurrencyMax defaults to 4', () => {
    expect(useFleetStore.getState().fleetConcurrencyMax).toBe(4);
    expect(selectFleetSummary(useFleetStore.getState()).concurrencyMax).toBe(4);
  });

  // ── Agent details for config display ────────────────────────────

  it('stores provider, model, description, taskId on spawned agents', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Configured',
      provider: 'anthropic',
      model: 'claude-opus-4',
      description: 'Audits auth layer',
      taskId: 'task_42',
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.provider).toBe('anthropic');
    expect(agent?.model).toBe('claude-opus-4');
    expect(agent?.description).toBe('Audits auth layer');
    expect(agent?.taskId).toBe('task_42');
  });

  it('records failure details on task_completed with failed status', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Failing',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'failed',
      failureReason: 'provider_auth',
      error: { kind: 'auth_error', message: 'Invalid API key' },
    });

    const agent = useFleetStore.getState().agents.get('a1');
    expect(agent?.status).toBe('failed');
    expect(agent?.failureReason).toBe('provider_auth');
    expect(agent?.error?.kind).toBe('auth_error');
  });

  it('records timeout status on task_completed with timeout status', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Slow',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'timeout',
    });

    expect(useFleetStore.getState().agents.get('a1')?.status).toBe('timeout');
  });
});
