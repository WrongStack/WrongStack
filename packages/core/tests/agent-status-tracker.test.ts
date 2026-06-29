/**
 * AgentStatusTracker unit tests — verify that EventBus events correctly
 * translate to SessionRegistry.updateAgents() calls with the right state.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentStatusTracker } from '../src/agent-status-tracker.js';
import type { AgentEntry } from '../src/session-registry.js';
import type { SessionRegistry } from '../src/session-registry.js';

// ── Mocks ──────────────────────────────────────────────────────────────

/** Minimal mock EventBus — only the surface AgentStatusTracker touches. */
function mockEventBus() {
  const listeners = new Map<string, Array<(event: string, payload: unknown) => void>>();
  return {
    onPattern: vi.fn(
      (pattern: string, fn: (event: string, payload: unknown) => void) => {
        const list = listeners.get(pattern) ?? [];
        list.push(fn);
        listeners.set(pattern, list);
        return () => {
          const idx = list.indexOf(fn);
          if (idx >= 0) list.splice(idx, 1);
        };
      },
    ),
    /** Fire an event to all matching pattern listeners. */
    emit: (event: string, payload: unknown) => {
      for (const [pattern, fns] of listeners) {
        if (event.startsWith(pattern.replace('*', ''))) {
          for (const fn of fns) fn(event, payload);
        }
      }
    },
  };
}

/** Spy on SessionRegistry.updateAgents */
function mockRegistry() {
  return {
    updateAgents: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
  } as never as SessionRegistry;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('AgentStatusTracker', () => {
  let events: ReturnType<typeof mockEventBus>;
  let registry: ReturnType<typeof mockRegistry>;
  let tracker: AgentStatusTracker;

  beforeEach(() => {
    events = mockEventBus();
    registry = mockRegistry();
    tracker = new AgentStatusTracker({
      events: events as never as import('@wrongstack/core').EventBus,
      registry: registry as never as SessionRegistry,
    });
  });

  // ── Leader events ──────────────────────────────────────────────────

  it('sets leader to running on agent.run.started', () => {
    tracker.start();
    events.emit('agent.run.started', { at: '2026-06-24T10:00:00.000Z' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('running');
    expect(leader?.iterations).toBe(1);
    expect(leader?.startedAt).toBe('2026-06-24T10:00:00.000Z');
  });

  it('captures leader model and starts a run from iteration.started', () => {
    tracker.start();
    events.emit('iteration.started', {
      index: 2,
      ctx: {
        model: 'anthropic/claude-opus-4-8',
        lastRequestTokens: 42_000,
        provider: { capabilities: { maxContext: 200_000 } },
      },
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('running');
    expect(leader?.iterations).toBe(3);
    expect(leader?.model).toBe('anthropic/claude-opus-4-8');
    expect(leader?.ctxPct).toBe(21);
    expect(leader?.startedAt).toBeDefined();
  });

  it('sets leader to idle on agent.run.completed', () => {
    tracker.start();
    events.emit('agent.run.started', {});
    events.emit('agent.run.completed', { status: 'done' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('idle');
    expect(leader?.startedAt).toBeUndefined();
  });

  it('sets leader to error on failed agent.run.completed and keeps run start', () => {
    tracker.start();
    events.emit('agent.run.started', { at: '2026-06-24T10:00:00.000Z' });
    events.emit('agent.run.completed', { status: 'failed' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('error');
    expect(leader?.startedAt).toBe('2026-06-24T10:00:00.000Z');
  });

  it('sets leader to error on agent.run.error', () => {
    tracker.start();
    events.emit('agent.run.error', { err: new Error('boom') });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('error');
  });

  it('tracks current tool on tool.started', () => {
    tracker.start();
    events.emit('tool.started', { name: 'bash', id: 'tu-1' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.currentTool).toBe('bash');
    expect(leader?.toolCalls).toBe(1);
  });

  it('clears current tool on tool.executed', () => {
    tracker.start();
    events.emit('tool.started', { name: 'read', id: 'tu-2' });
    events.emit('tool.executed', { name: 'read', id: 'tu-2' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.currentTool).toBeUndefined();
  });

  it('sets leader to waiting_user on brain.ask_human', () => {
    tracker.start();
    events.emit('brain.ask_human', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('waiting_user');
  });

  it('sets leader to streaming on llm.stream_started', () => {
    tracker.start();
    events.emit('llm.stream_started', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('streaming');
  });

  it('accumulates streamed assistant text into leader.partialText (throttled)', () => {
    vi.useFakeTimers();
    try {
      tracker.start();
      events.emit('provider.text_delta', { text: 'Hello ' });
      events.emit('provider.text_delta', { text: 'world' });
      // Throttled — the flush fires after the debounce window.
      vi.advanceTimersByTime(350);
      const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
      const leader = call?.find((a: AgentEntry) => a.id === 'leader');
      expect(leader?.partialText).toBe('Hello world');
      expect(leader?.status).toBe('streaming');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears leader.partialText when the turn completes', () => {
    tracker.start();
    events.emit('llm.stream_started', {});
    events.emit('provider.text_delta', { text: 'partial answer' });
    events.emit('agent.run.completed', {});
    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.partialText).toBeUndefined();
  });

  // ── Fleet events ───────────────────────────────────────────────────

  it('adds subagent on subagent.spawned (running)', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-1', name: 'bug-hunter' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-1');
    expect(sub).toBeDefined();
    expect(sub?.name).toBe('bug-hunter');
    expect(sub?.status).toBe('running');
    expect(sub?.iterations).toBe(0);
  });

  it('counts subagent tool calls on subagent.tool_executed', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-t', name: 'worker' });
    events.emit('subagent.tool_executed', { subagentId: 'sa-t', name: 'bash', ok: true, durationMs: 5 });
    events.emit('subagent.tool_executed', { subagentId: 'sa-t', name: 'read', ok: true, durationMs: 3 });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-t');
    expect(sub?.toolCalls).toBe(2);
    expect(sub?.currentTool).toBe('read');
  });

  it('accumulates leader cost + tokens from token.accounted', () => {
    tracker.start();
    events.emit('token.accounted', { usage: { input: 1000, output: 200 }, cost: { input: 0.1, output: 0.2, total: 0.3 } });
    events.emit('token.accounted', { usage: { input: 500, output: 100 }, cost: { input: 0.05, output: 0.1, total: 0.15 } });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.tokensIn).toBe(1500);
    expect(leader?.tokensOut).toBe(300);
    expect(leader?.costUsd).toBeCloseTo(0.45, 5);
  });

  it('ignores session-scoped events for other sessions', () => {
    tracker = new AgentStatusTracker({
      events: events as never as import('@wrongstack/core').EventBus,
      registry: registry as never as SessionRegistry,
      sessionId: 's1',
    });
    tracker.start();

    events.emit('tool.started', { sessionId: 's2', name: 'bash', id: 'tu-other' });
    events.emit('token.accounted', {
      sessionId: 's2',
      usage: { input: 1000, output: 200 },
      cost: { input: 0.1, output: 0.2, total: 0.3 },
    });
    expect(registry.updateAgents).not.toHaveBeenCalled();

    events.emit('token.accounted', {
      sessionId: 's1',
      usage: { input: 10, output: 2 },
      cost: { input: 0, output: 0, total: 0.01 },
    });
    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.tokensIn).toBe(10);
    expect(leader?.tokensOut).toBe(2);
    expect(leader?.costUsd).toBeCloseTo(0.01, 5);
  });

  it('captures leader context fill from ctx.pct', () => {
    tracker.start();
    events.emit('ctx.pct', { load: 0.68, tokens: 136_000, maxContext: 200_000 });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.ctxPct).toBe(68);
  });

  it('caps leader context fill at 100%', () => {
    tracker.start();
    events.emit('ctx.pct', { load: 1.35, tokens: 270_000, maxContext: 200_000 });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.ctxPct).toBe(100);
  });

  it('updates leader model when provider fallback switches model', () => {
    tracker.start();
    events.emit('provider.fallback', {
      from: { providerId: 'anthropic', model: 'claude-opus-4-8' },
      to: { providerId: 'openai', model: 'gpt-5' },
      status: 529,
      providerSwitched: true,
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.model).toBe('openai/gpt-5');
  });

  it('captures subagent model + context fill', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-m', name: 'worker', model: 'anthropic/claude-opus-4-8' });
    events.emit('subagent.ctx_pct', { subagentId: 'sa-m', load: 0.42 });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-m');
    expect(sub?.model).toBe('anthropic/claude-opus-4-8');
    expect(sub?.ctxPct).toBe(42);
  });

  it('caps subagent context fill at 100%', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-hot', name: 'worker' });
    events.emit('subagent.ctx_pct', { subagentId: 'sa-hot', load: 1.2 });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-hot');
    expect(sub?.ctxPct).toBe(100);
  });

  it('records subagent cost from iteration_summary', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-c', name: 'worker' });
    events.emit('subagent.iteration_summary', { subagentId: 'sa-c', iteration: 10, toolCalls: 20, costUsd: 0.077 });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-c');
    expect(sub?.costUsd).toBeCloseTo(0.077, 5);
  });

  it('takes authoritative counts from subagent.iteration_summary', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-i', name: 'worker' });
    events.emit('subagent.iteration_summary', { subagentId: 'sa-i', iteration: 25, toolCalls: 47, currentTool: 'grep' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-i');
    expect(sub?.iterations).toBe(25);
    expect(sub?.toolCalls).toBe(47);
    expect(sub?.currentTool).toBe('grep');
  });

  it('captures + clears subagent live partialText', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-p', name: 'worker' });
    events.emit('subagent.iteration_summary', {
      subagentId: 'sa-p',
      iteration: 1,
      toolCalls: 0,
      partialText: 'thinking about the fix…',
    });
    let call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    expect(call?.find((a: AgentEntry) => a.id === 'sa-p')?.partialText).toBe(
      'thinking about the fix…',
    );

    events.emit('subagent.task_completed', { subagentId: 'sa-p', status: 'completed' });
    call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    expect(call?.find((a: AgentEntry) => a.id === 'sa-p')?.partialText).toBeUndefined();
  });

  it('updates subagent to running on task_started', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-2', name: 'refactor-planner' });
    events.emit('subagent.task_started', { subagentId: 'sa-2' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-2');
    expect(sub?.status).toBe('running');
    expect(sub?.iterations).toBe(1);
  });

  it('sets subagent to idle on successful task_completed', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-3', name: 'critic' });
    events.emit('subagent.task_completed', { subagentId: 'sa-3', status: 'success', iterations: 4, toolCalls: 9 });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-3');
    expect(sub?.status).toBe('idle');
    expect(sub?.toolCalls).toBe(9);
  });

  it('sets subagent to error on failed task_completed', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-4', name: 'worker' });
    events.emit('subagent.task_completed', { subagentId: 'sa-4', status: 'failed' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-4');
    expect(sub?.status).toBe('error');
  });

  it('reaps a finished subagent after the TTL, keeping the leader', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z').getTime() });
    try {
      tracker.start();
      events.emit('subagent.spawned', { subagentId: 'sa-reap', name: 'tmp' });
      events.emit('subagent.task_completed', { subagentId: 'sa-reap', status: 'success' });

      // Present immediately after completion.
      let last = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
      expect(last.find((a) => a.id === 'sa-reap')).toBeDefined();

      // 45s later (> 30s TTL), a sweep should have removed it...
      await vi.advanceTimersByTimeAsync(45_000);
      last = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
      expect(last.find((a) => a.id === 'sa-reap')).toBeUndefined();
      // ...but the leader is never reaped.
      expect(last.find((a) => a.id === 'leader')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT reap a still-running subagent regardless of age', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z').getTime() });
    try {
      tracker.start();
      events.emit('subagent.spawned', { subagentId: 'sa-busy', name: 'worker' }); // status running
      await vi.advanceTimersByTimeAsync(120_000);
      const last = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
      expect(last.find((a) => a.id === 'sa-busy')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes subagent on subagent.stopped', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-5', name: 'temp' });
    events.emit('subagent.stopped', { subagentId: 'sa-5' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-5');
    expect(sub).toBeUndefined();
  });

  // ── Fleet: multiple agents ─────────────────────────────────────────

  it('tracks leader + multiple subagents simultaneously', () => {
    tracker.start();
    events.emit('agent.run.started', {});
    events.emit('tool.started', { name: 'bash', id: 't1' });
    events.emit('subagent.spawned', { subagentId: 's1', name: 'bug-hunter' });
    events.emit('subagent.spawned', { subagentId: 's2', name: 'refactor' });
    events.emit('subagent.task_started', { subagentId: 's1' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    expect(call).toHaveLength(3); // leader + 2 subagents

    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.status).toBe('running');
    expect(leader?.currentTool).toBe('bash');

    const s1 = call?.find((a: AgentEntry) => a.id === 's1');
    expect(s1?.status).toBe('running');
    expect(s1?.iterations).toBe(1);

    const s2 = call?.find((a: AgentEntry) => a.id === 's2');
    expect(s2?.status).toBe('running');
    expect(s2?.iterations).toBe(0);
  });

  // ── Stop / cleanup ─────────────────────────────────────────────────

  it('stop() unsubscribes all listeners', () => {
    tracker.start();
    tracker.stop();

    // After stop, events should NOT trigger updateAgents
    const beforeCount = registry.updateAgents.mock.calls.length;
    events.emit('agent.run.started', {});
    expect(registry.updateAgents.mock.calls.length).toBe(beforeCount);
  });

  // ── Custom leader name ─────────────────────────────────────────────

  it('uses custom leader name when provided', () => {
    const customTracker = new AgentStatusTracker({
      events: events as never as import('@wrongstack/core').EventBus,
      registry: registry as never as SessionRegistry,
      leaderName: 'commander',
    });
    customTracker.start();
    events.emit('agent.run.started', {});

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.name).toBe('commander');
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it('ignores a completion for an unknown subagent', () => {
    tracker.start();
    const beforeCount = registry.updateAgents.mock.calls.length;
    // task_completed for an agent we never saw spawn/run must not materialise it.
    events.emit('subagent.task_completed', { subagentId: 'ghost', status: 'success' });

    expect(registry.updateAgents.mock.calls.length).toBe(beforeCount);
  });

  it('handles multiple tool.started calls (toolCalls increments)', () => {
    tracker.start();
    events.emit('tool.started', { name: 'read', id: 't1' });
    events.emit('tool.started', { name: 'write', id: 't2' });
    events.emit('tool.started', { name: 'bash', id: 't3' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.toolCalls).toBe(3);
  });

  it('does not register updateAgents failure as a crash', () => {
    const failingRegistry = {
      updateAgents: vi.fn().mockRejectedValue(new Error('disk full')),
    } as never as SessionRegistry;
    const t = new AgentStatusTracker({
      events: events as never as import('@wrongstack/core').EventBus,
      registry: failingRegistry,
    });
    t.start();

    // Should not throw
    expect(() => events.emit('agent.run.started', {})).not.toThrow();
  });
});
