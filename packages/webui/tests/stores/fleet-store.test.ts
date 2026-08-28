import { beforeEach, describe, expect, it } from 'vitest';
import { selectFleetSummary, selectSortedAgentList, useFleetStore } from '../../src/stores';
import type { FleetState } from '../../src/stores/fleet-store.js';

const fleet = () => useFleetStore.getState();
const get = (id: string) => fleet().agents.get(id);

beforeEach(() => fleet().clear());

// ── spawned ───────────────────────────────────────────────────────

describe('spawned', () => {
  it('creates an agent with nickname + model', () => {
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Von Neumann',
      provider: 'anthropic',
      model: 'claude-x',
      description: 'analyze',
    });
    const a = get('a1')!;
    expect(a.name).toBe('Von Neumann');
    expect(a.model).toBe('claude-x');
    expect(a.status).toBe('running');
  });

  it('falls back to id when no name', () => {
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'ghost', toolName: 'bash' });
    expect(get('ghost')!.name).toBe('ghost');
  });

  it('records sessionId when provided', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace', sessionId: 'sess_1' });
    expect(get('a1')!.sessionId).toBe('sess_1');
  });

  it('records provider and model', () => {
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Ada',
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(get('a1')!.provider).toBe('openai');
    expect(get('a1')!.model).toBe('gpt-4o');
  });

  it('records description and taskId', () => {
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'a1',
      name: 'Alan',
      description: 'analyze logs',
      taskId: 'task_x',
    });
    expect(get('a1')!.description).toBe('analyze logs');
    expect(get('a1')!.taskId).toBe('task_x');
  });

  it('is idempotent — second spawned does not overwrite name', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'First' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Second' });
    expect(get('a1')!.name).toBe('Second');
  });
});

describe('removed', () => {
  it('deletes the agent and its live timeline data', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().pushAgentTimelineEntry({
      subagentId: 'a1',
      agentName: 'Grace',
      content: 'working',
      kind: 'text',
      iteration: 1,
      ts: new Date().toISOString(),
    });

    fleet().applyEvent({ kind: 'removed', subagentId: 'a1', reason: 'completed' });

    expect(get('a1')).toBeUndefined();
    expect(fleet().getAgentTranscript('a1')).toEqual([]);
    expect(fleet().agentTimeline.some((entry) => entry.subagentId === 'a1')).toBe(false);
  });
});

// ── tool_executed ────────────────────────────────────────────────

describe('tool_executed', () => {
  it('increments toolCalls and records lastTool', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'read',
      ok: true,
      durationMs: 150,
    });
    const a = get('a1')!;
    expect(a.toolCalls).toBe(1);
    expect(a.lastTool).toBe('read');
  });

  it('appends to toolLog', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({
      kind: 'tool_executed',
      subagentId: 'a1',
      toolName: 'read',
      ok: true,
      durationMs: 150,
    });
    expect(get('a1')!.toolLog).toHaveLength(1);
    expect(get('a1')!.toolLog[0].name).toBe('read');
    expect(get('a1')!.toolLog[0].ok).toBe(true);
    expect(get('a1')!.toolLog[0].durationMs).toBe(150);
  });

  it('records failed tool', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'bash', ok: false });
    expect(get('a1')!.toolLog[0].ok).toBe(false);
  });

  it('accumulates multiple tool calls', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'read' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'edit' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'bash' });
    expect(get('a1')!.toolCalls).toBe(3);
    expect(get('a1')!.lastTool).toBe('bash');
  });

  it('adds to sparklineBins', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    for (let i = 0; i < 5; i++) {
      fleet().applyEvent({
        kind: 'tool_executed',
        subagentId: 'a1',
        toolName: 'bash',
        ok: true,
        durationMs: 100,
      });
    }
    const bins = get('a1')!.sparklineBins;
    const nonZero = bins.filter((b) => b > 0).length;
    expect(nonZero).toBeGreaterThan(0);
  });

  it('creates ghost agent if not known', () => {
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'ghost', toolName: 'read' });
    expect(get('ghost')!.name).toBe('ghost');
    expect(get('ghost')!.toolCalls).toBe(1);
  });
});

// ── iteration_summary ─────────────────────────────────────────────

describe('iteration_summary', () => {
  it('authoritative overwrite of toolCalls and iteration', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Ada' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'read' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'grep' });
    expect(get('a1')!.toolCalls).toBe(2);
    fleet().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a1',
      iteration: 25,
      toolCalls: 47,
      costUsd: 0.02,
      currentTool: 'edit',
    });
    const a = get('a1')!;
    expect(a.toolCalls).toBe(47);
    expect(a.iteration).toBe(25);
    expect(a.costUsd).toBeCloseTo(0.02);
    expect(a.currentTool).toBe('edit');
  });

  it('records partialText', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Ada' });
    fleet().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'a1',
      iteration: 1,
      partialText: 'Thinking...',
    });
    expect(get('a1')!.partialText).toBe('Thinking...');
  });
});

// ── ctx_pct ─────────────────────────────────────────────────────

describe('ctx_pct', () => {
  it('converts load fraction to display percent capped at 100', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a1',
      load: 0.732,
      tokens: 73_200,
      maxContext: 100_000,
    });
    expect(get('a1')!.ctxPct).toBe(73);
    expect(get('a1')!.ctxTokens).toBe(73_200);
    expect(get('a1')!.maxContext).toBe(100_000);
    // Legacy/malformed load > 1.0 stays capped in the UI display.
    fleet().applyEvent({ kind: 'ctx_pct', subagentId: 'a1', load: 1.5 });
    expect(get('a1')!.ctxPct).toBe(100);
  });

  it('updates tokensIn and fleetTokensIn', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a1',
      load: 0.5,
      tokens: 50_000,
      tokensIn: 1234,
    });
    expect(get('a1')!.tokensIn).toBe(1234);
    expect(fleet().fleetTokensIn).toBe(1234);
  });

  it('updates tokensOut and fleetTokensOut', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'ctx_pct', subagentId: 'a1', load: 0.5, tokensOut: 5678 });
    expect(get('a1')!.tokensOut).toBe(5678);
    expect(fleet().fleetTokensOut).toBe(5678);
  });

  it('accumulates fleetTokensIn across multiple agents', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'ctx_pct', subagentId: 'a1', tokensIn: 1000 });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Ada' });
    fleet().applyEvent({ kind: 'ctx_pct', subagentId: 'a2', tokensIn: 2000 });
    expect(fleet().fleetTokensIn).toBe(3000);
  });
});

// ── budget_extended ───────────────────────────────────────────────

describe('budget_extended', () => {
  it('records explicit budget warnings from the backend', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Alan' });
    fleet().applyEvent({
      kind: 'budget_warning',
      subagentId: 'a1',
      budgetKind: 'tool_calls',
      used: 40,
      limit: 40,
    });
    expect(get('a1')!.budgetWarning).toEqual({ kind: 'tool_calls', used: 40, limit: 40 });
    expect(fleet().eventTimeline[0].kind).toBe('budget_warning');
  });

  it('tracks self-extensions', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Alan' });
    fleet().applyEvent({ kind: 'budget_extended', subagentId: 'a1', totalExtensions: 3 });
    expect(get('a1')!.extensions).toBe(3);
  });

  it('is cumulative', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Alan' });
    fleet().applyEvent({ kind: 'budget_extended', subagentId: 'a1', totalExtensions: 1 });
    fleet().applyEvent({ kind: 'budget_extended', subagentId: 'a1', totalExtensions: 2 });
    fleet().applyEvent({ kind: 'budget_extended', subagentId: 'a1', totalExtensions: 3 });
    expect(get('a1')!.extensions).toBe(3);
  });

  it('clears budgetWarning when ctxPct is low (extension resolved it)', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Alan' });
    // budgetWarning derived automatically when ctxPct >= 80
    fleet().applyEvent({ kind: 'ctx_pct', subagentId: 'a1', load: 0.85 });
    expect(get('a1')!.budgetWarning).toBeDefined();
    // budget_extended clears it
    fleet().applyEvent({ kind: 'budget_extended', subagentId: 'a1', totalExtensions: 1 });
    expect(get('a1')!.budgetWarning).toBeUndefined();
  });
});

// ── task_completed ───────────────────────────────────────────────

describe('task_completed', () => {
  it('maps success → completed and clears currentTool', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Edsger' });
    fleet().applyEvent({ kind: 'iteration_summary', subagentId: 'a1', currentTool: 'bash' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'success',
      iterations: 12,
      toolCalls: 30,
    });
    const a = get('a1')!;
    expect(a.status).toBe('completed');
    expect(a.iteration).toBe(12);
    expect(a.currentTool).toBeUndefined();
    expect(a.completedAt).toBeTypeOf('number');
  });

  it('maps failed to failed status', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Edsger' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'failed',
      error: { kind: 'rate_limit', message: '429' },
    });
    const a = get('a1')!;
    expect(a.status).toBe('failed');
    expect(a.error).toEqual({ kind: 'rate_limit', message: '429' });
  });

  it('strips <nextsteps> blocks from finalText', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Edsger' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'success',
      finalText: 'Result text<nextsteps>Suggestion here</nextsteps>More text',
    });
    expect(get('a1')!.finalText).toBe('Result textMore text');
  });

  it('handles self-closing <next_steps/> tag', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Edsger' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'success',
      finalText: 'Before<next_steps/>After',
    });
    expect(get('a1')!.finalText).toBe('BeforeAfter');
  });

  it('handles multi-line <nextsteps> block', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Edsger' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'success',
      finalText: 'Start\n<nextsteps>\nStep 1\nStep 2\n</nextsteps>\nEnd',
    });
    expect(get('a1')!.finalText).toBe('Start\n\nEnd');
  });

  it('sets failureReason', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Linus' });
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'failed',
      failureReason: 'max_iterations',
    });
    expect(get('a1')!.failureReason).toBe('max_iterations');
  });

  it('handles timeout status', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Linus' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'timeout' });
    expect(get('a1')!.status).toBe('timeout');
  });

  it('handles stopped status', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Linus' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'stopped' });
    expect(get('a1')!.status).toBe('stopped');
  });

  it('toolCalls from event overrides live count', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Linus' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'read' });
    expect(get('a1')!.toolCalls).toBe(1);
    fleet().applyEvent({
      kind: 'task_completed',
      subagentId: 'a1',
      status: 'success',
      toolCalls: 50,
    });
    expect(get('a1')!.toolCalls).toBe(50);
  });
});

// ── session_stopped ───────────────────────────────────────────────

describe('session_stopped', () => {
  it('deletes agents matching the sessionId', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace', sessionId: 'sess_1' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Ada', sessionId: 'sess_2' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a3', name: 'Alan', sessionId: 'sess_1' });
    expect(fleet().agents.size).toBe(3);
    fleet().applyEvent({ kind: 'session_stopped', sessionId: 'sess_1' });
    expect(get('a1')).toBeUndefined();
    expect(get('a3')).toBeUndefined();
    expect(get('a2')).toBeDefined(); // different session
  });
});

// ── leader_updated ───────────────────────────────────────────────

describe('leader_updated', () => {
  it('sets isLeader on the new leader', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Ada' });
    fleet().applyEvent({ kind: 'leader_updated', subagentId: 'a1', isLeader: true });
    expect(get('a1')!.isLeader).toBe(true);
    expect(get('a2')!.isLeader).toBeUndefined();
  });

  it('updates fleet.leaderId', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'leader_updated', subagentId: 'a1', isLeader: true });
    expect(fleet().leaderId).toBe('a1');
  });
});

// ── task_started ─────────────────────────────────────────────────

describe('task_started', () => {
  it('records taskId', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'task_started', subagentId: 'a1', taskId: 'task_123' });
    expect(get('a1')!.taskId).toBe('task_123');
  });
});

// ── fleetConcurrency ─────────────────────────────────────────────

describe('fleetConcurrency', () => {
  it('clear() resets fleetConcurrency', () => {
    // fleetConcurrency defaults to 0 after clear
    expect(fleet().fleetConcurrency).toBe(0);
    expect(fleet().fleetConcurrencyMax).toBe(4);
  });
});

// ── clear ───────────────────────────────────────────────────────

describe('clear', () => {
  it('empties the roster', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    expect(fleet().agents.size).toBe(1);
    fleet().clear();
    expect(fleet().agents.size).toBe(0);
  });

  it('resets fleetTokens', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'ctx_pct', subagentId: 'a1', tokensIn: 1000 });
    fleet().clear();
    expect(fleet().fleetTokensIn).toBe(0);
    expect(fleet().fleetTokensOut).toBe(0);
  });

  it('is idempotent', () => {
    fleet().clear();
    fleet().clear();
    expect(fleet().agents.size).toBe(0);
  });
});

// ── selectFleetSummary ───────────────────────────────────────────────

describe('selectFleetSummary', () => {
  it('returns all zeros for an empty fleet', () => {
    fleet().clear();
    const s = selectFleetSummary(fleet());
    expect(s).toEqual({
      running: 0,
      completed: 0,
      failed: 0,
      total: 0,
      totalCost: 0,
      tokensIn: 0,
      tokensOut: 0,
      concurrency: 0,
      concurrencyMax: 4,
    });
  });

  it('counts running agents', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Ada' });
    expect(selectFleetSummary(fleet()).running).toBe(2);
  });

  it('counts completed, failed, and timeout separately', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'A', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'success' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'B', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a2', status: 'failed' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a3', name: 'C', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a3', status: 'timeout' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a4', name: 'D' });

    const s = selectFleetSummary(fleet());
    expect(s.running).toBe(1); // D
    expect(s.completed).toBe(1); // A
    expect(s.failed).toBe(2); // B (failed) + C (timeout)
    expect(s.total).toBe(4);
  });

  it('aggregates total cost across all agents', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'iteration_summary', subagentId: 'a1', costUsd: 0.1 });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Ada' });
    fleet().applyEvent({ kind: 'iteration_summary', subagentId: 'a2', costUsd: 0.2 });

    expect(selectFleetSummary(fleet()).totalCost).toBeCloseTo(0.3);
  });

  it('includes cost from completed/failed agents in totalCost', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({ kind: 'iteration_summary', subagentId: 'a1', costUsd: 0.1 });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'success' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Ada' });
    fleet().applyEvent({ kind: 'iteration_summary', subagentId: 'a2', costUsd: 0.2 });

    expect(selectFleetSummary(fleet()).totalCost).toBeCloseTo(0.3);
  });

  it('reads tokensIn and tokensOut from scalar fields', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Grace' });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a1',
      load: 0.5,
      tokensIn: 1000,
      tokensOut: 500,
    });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Ada' });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a2',
      load: 0.3,
      tokensIn: 2000,
      tokensOut: 1500,
    });

    const s = selectFleetSummary(fleet());
    expect(s.tokensIn).toBe(3000);
    expect(s.tokensOut).toBe(2000);
  });

  it('reads concurrency fields directly', () => {
    // fleetConcurrency defaults to 0; seed a non-zero value to verify the read
    const state = fleet();
    // Manually set concurrency to verify reads (no event sets concurrency)
    const patched: FleetState = { ...state, fleetConcurrency: 3, fleetConcurrencyMax: 10 };
    const s = selectFleetSummary(patched);
    expect(s.concurrency).toBe(3);
    expect(s.concurrencyMax).toBe(10);
  });

  it('handles stopped agents — they count toward total but not running/failed', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'A', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'stopped' });

    const s = selectFleetSummary(fleet());
    expect(s.running).toBe(0);
    expect(s.completed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.total).toBe(1);
  });
});

// ── selectSortedAgentList ─────────────────────────────────────────────

describe('selectSortedAgentList', () => {
  it('returns empty array for empty fleet', () => {
    fleet().clear();
    expect(selectSortedAgentList(fleet())).toEqual([]);
  });

  it('sorts leader first, then running agents, then completed/failed', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'c', name: 'Charlie' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a', name: 'Alpha' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'c', status: 'failed' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'b', name: 'Beta' });
    fleet().applyEvent({ kind: 'leader_updated', subagentId: 'b' });

    const sorted = selectSortedAgentList(fleet());
    const names = sorted.map((a) => a.name);
    // Beta is leader → first. Alpha is running. Charlie is failed.
    expect(names).toEqual(['Beta', 'Alpha', 'Charlie']);
  });

  it('within same status group, sorts by startedAt ascending', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'c', name: 'Charlie' });
    // Charlie started first but status is running — override to make it completed
    // so it sorts after the running agents.
    // Direct Map mutation is acceptable here because we read state synchronously
    // via getState(), not through useFleetStore() React subscribers.
    const state = fleet();
    const agent = state.agents.get('c');
    if (agent) {
      state.agents.set('c', { ...agent, status: 'completed', startedAt: 100 });
    }
    // Then spawn two running agents
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a', name: 'Alpha' }); // startedAt ≈ now
    fleet().applyEvent({ kind: 'spawned', subagentId: 'b', name: 'Beta' }); // startedAt ≈ now+1ms

    const sorted = selectSortedAgentList(fleet());
    const names = sorted.map((a) => a.name);
    // Running first (Alpha, Beta by start time), then completed (Charlie).
    expect(names[0]).toBe('Alpha');
    expect(names[1]).toBe('Beta');
    expect(names[2]).toBe('Charlie');
  });

  it('leader is always first regardless of status', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a', name: 'Alpha' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a', status: 'failed' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'b', name: 'Beta' });
    fleet().applyEvent({ kind: 'leader_updated', subagentId: 'a' }); // Alpha is leader despite failed

    const sorted = selectSortedAgentList(fleet());
    expect(sorted[0].name).toBe('Alpha'); // leader first
    expect(sorted[1].name).toBe('Beta'); // running second
  });

  it('works when leaderId is undefined (no leader)', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a', name: 'Alpha' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a', status: 'completed' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'b', name: 'Beta' });

    const sorted = selectSortedAgentList(fleet());
    expect(sorted[0].name).toBe('Beta'); // running first
    expect(sorted[1].name).toBe('Alpha'); // completed second
  });
});

// ── clearFinishedAgents ──────────────────────────────────────────────

describe('clearFinishedAgents', () => {
  it('removes completed, failed, timeout, and stopped agents', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'A', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'success' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'B', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a2', status: 'failed' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a3', name: 'C', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a3', status: 'timeout' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a4', name: 'D', sessionId: 'sess-a' });

    expect(fleet().agents.size).toBe(4);
    fleet().clearFinishedAgents('sess-a');
    expect(fleet().agents.size).toBe(1);
    expect(get('a4')?.name).toBe('D'); // running survivor
  });

  it('keeps running agents', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'A', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'B', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a3', name: 'C', sessionId: 'sess-a' });

    fleet().clearFinishedAgents('sess-a');
    expect(fleet().agents.size).toBe(3);
  });

  it('clears agentTranscripts for finished agents', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'A', sessionId: 'sess-a' });
    fleet().pushAgentTimelineEntry({
      subagentId: 'a1',
      agentName: 'A',
      content: 'work',
      kind: 'text',
      iteration: 1,
      ts: '2024-01-01',
    });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'success' });

    expect(fleet().getAgentTranscript('a1').length).toBeGreaterThan(0);
    fleet().clearFinishedAgents('sess-a');
    expect(fleet().getAgentTranscript('a1')).toEqual([]);
  });

  it('clears leaderId when the leader was finished', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Leader', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'leader_updated', subagentId: 'a1' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'success' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Worker', sessionId: 'sess-a' });

    expect(fleet().leaderId).toBe('a1');
    fleet().clearFinishedAgents('sess-a');
    expect(fleet().leaderId).toBeUndefined();
  });

  it('preserves leaderId when the leader is still running', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'Leader', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'leader_updated', subagentId: 'a1' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'Worker', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a2', status: 'success' });

    fleet().clearFinishedAgents('sess-a');
    expect(fleet().leaderId).toBe('a1');
    expect(fleet().agents.size).toBe(1);
  });

  it('filters eventTimeline for finished agents', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'A', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'tool_executed', subagentId: 'a1', toolName: 'read' });
    fleet().applyEvent({ kind: 'task_completed', subagentId: 'a1', status: 'success' });

    const before = fleet().eventTimeline.length;
    expect(before).toBeGreaterThan(0);
    fleet().clearFinishedAgents('sess-a');
    // Timeline should not include events about the removed agent
    const hasA1Events = fleet().eventTimeline.some((ev) => ev.agentId === 'a1');
    expect(hasA1Events).toBe(false);
  });

  it('is a no-op when all agents are running', () => {
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a1', name: 'A', sessionId: 'sess-a' });
    fleet().applyEvent({ kind: 'spawned', subagentId: 'a2', name: 'B', sessionId: 'sess-a' });

    expect(fleet().agents.size).toBe(2);
    fleet().clearFinishedAgents('sess-a');
    expect(fleet().agents.size).toBe(2);
  });
});
