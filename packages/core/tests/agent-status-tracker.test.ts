/**
 * AgentStatusTracker unit tests — verify that EventBus events correctly
 * translate to SessionRegistry.updateAgents() calls with the right state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStatusTracker } from '../src/coordination/agent-status-tracker.js';
import type { EventBus } from '../src/kernel/events.js';
import type { AgentEntry, SessionRegistry } from '../src/session-catalog/session-registry.js';

// ── Mocks ──────────────────────────────────────────────────────────────

/** Minimal mock EventBus — only the surface AgentStatusTracker touches. */
function mockEventBus() {
  const listeners = new Map<string, Array<(event: string, payload: unknown) => void>>();
  return {
    onPattern: vi.fn((pattern: string, fn: (event: string, payload: unknown) => void) => {
      const list = listeners.get(pattern) ?? [];
      list.push(fn);
      listeners.set(pattern, list);
      return () => {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    }),
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

/** Spy on the SessionRegistry methods used by AgentStatusTracker. */
function mockRegistry() {
  return {
    updateAgents: vi.fn<(agents: AgentEntry[]) => Promise<void>>().mockResolvedValue(undefined),
    register: vi.fn<SessionRegistry['register']>().mockResolvedValue(undefined),
  };
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
      events: events as never as EventBus,
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

  it('mirrors the leader prompt, current task, and live todo list', () => {
    tracker.start();
    events.emit('agent.run.started', {
      at: '2026-07-17T12:00:00.000Z',
      inputText: 'Build the live office mission board',
      ctx: {
        todos: [
          { id: 'todo-1', content: 'Inspect session telemetry', status: 'completed' },
          {
            id: 'todo-2',
            content: 'Render active tasks',
            activeForm: 'Rendering active tasks',
            status: 'in_progress',
          },
        ],
      },
    });

    let call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    let leader = call?.find((agent) => agent.id === 'leader');
    expect(leader).toMatchObject({
      currentTask: 'Build the live office mission board',
      latestPrompt: 'Build the live office mission board',
      latestPromptAt: Date.parse('2026-07-17T12:00:00.000Z'),
      todos: [
        { id: 'todo-1', content: 'Inspect session telemetry', status: 'completed' },
        {
          id: 'todo-2',
          content: 'Render active tasks',
          activeForm: 'Rendering active tasks',
          status: 'in_progress',
        },
      ],
    });

    events.emit('iteration.completed', {
      ctx: {
        todos: [{ id: 'todo-2', content: 'Render active tasks', status: 'completed' }],
      },
    });
    call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    leader = call?.find((agent) => agent.id === 'leader');
    expect(leader?.todos).toEqual([
      { id: 'todo-2', content: 'Render active tasks', status: 'completed' },
    ]);

    events.emit('agent.run.completed', { status: 'done', ctx: { todos: leader?.todos } });
    call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    leader = call?.find((agent) => agent.id === 'leader');
    expect(leader?.currentTask).toBeUndefined();
    expect(leader?.latestPrompt).toBe('Build the live office mission board');
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

  it('publishes completed leader tools and cumulative file/line totals', () => {
    tracker.start();
    events.emit('tool.started', {
      name: 'read_file',
      id: 'tu-read',
      input: { file_path: 'src/app.ts', offset: 1, limit: 40 },
    });
    events.emit('tool.executed', {
      name: 'read_file',
      id: 'tu-read',
      ok: true,
      durationMs: 25,
      input: { file_path: 'src/app.ts', offset: 1, limit: 40 },
      outputLines: 40,
      outputBytes: 1_024,
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((agent) => agent.id === 'leader');
    expect(leader?.recentTools?.[0]).toMatchObject({
      id: 'tu-read',
      name: 'read_file',
      ok: true,
      durationMs: 25,
      outputLines: 40,
    });
    expect(leader?.activity).toMatchObject({
      filesTouched: ['src/app.ts'],
      reads: 1,
      linesRead: 40,
    });
  });

  const leaderStatus = (): string | undefined => {
    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    return call?.find((a: AgentEntry) => a.id === 'leader')?.status;
  };

  it('sets leader to waiting_user on a pending brain.decision_ask_human', () => {
    tracker.start();
    events.emit('brain.decision_ask_human', { pending: true });

    expect(leaderStatus()).toBe('waiting_user');
  });

  it('ignores a non-pending brain.decision_ask_human (nobody is being asked)', () => {
    tracker.start();
    events.emit('brain.decision_ask_human', {});

    expect(leaderStatus()).not.toBe('waiting_user');
  });

  it('leaves waiting_user once the human answers', () => {
    tracker.start();
    events.emit('brain.decision_ask_human', { pending: true });
    expect(leaderStatus()).toBe('waiting_user');

    events.emit('brain.human_answered', { id: 'req-1', optionId: 'go' });
    expect(leaderStatus()).toBe('running');
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
    events.emit('subagent.tool_executed', {
      subagentId: 'sa-t',
      name: 'bash',
      ok: true,
      durationMs: 5,
    });
    events.emit('subagent.tool_executed', {
      subagentId: 'sa-t',
      name: 'read',
      ok: true,
      durationMs: 3,
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-t');
    expect(sub?.toolCalls).toBe(2);
    expect(sub?.currentTool).toBeUndefined();
  });

  it('tracks subagent starts, writes, edits, and line deltas in the shared snapshot', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-work', name: 'worker' });
    events.emit('subagent.tool_started', {
      subagentId: 'sa-work',
      id: 'tu-write',
      name: 'write_file',
      input: { file_path: 'src/new.ts', content: 'one\ntwo\nthree' },
    });
    events.emit('subagent.tool_executed', {
      subagentId: 'sa-work',
      id: 'tu-write',
      name: 'write_file',
      ok: true,
      durationMs: 10,
      input: { file_path: 'src/new.ts', content: 'one\ntwo\nthree' },
    });
    events.emit('subagent.tool_executed', {
      subagentId: 'sa-work',
      id: 'tu-edit',
      name: 'apply_patch',
      ok: true,
      durationMs: 8,
      input: { file_path: 'src/new.ts', patch: '@@\n-old\n+new\n+more' },
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((agent) => agent.id === 'sa-work');
    expect(sub?.recentTools).toHaveLength(2);
    expect(sub?.activity).toMatchObject({
      filesTouched: ['src/new.ts'],
      writes: 1,
      edits: 1,
      linesWritten: 3,
      linesAdded: 2,
      linesRemoved: 1,
    });
  });

  it('accumulates leader cost + tokens from token.accounted', () => {
    tracker.start();
    events.emit('token.accounted', {
      usage: { input: 1000, output: 200 },
      cost: { input: 0.1, output: 0.2, total: 0.3 },
    });
    events.emit('token.accounted', {
      usage: { input: 500, output: 100 },
      cost: { input: 0.05, output: 0.1, total: 0.15 },
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.tokensIn).toBe(1500);
    expect(leader?.tokensOut).toBe(300);
    expect(leader?.costUsd).toBeCloseTo(0.45, 5);
  });

  it('ignores session-scoped events for other sessions', () => {
    tracker = new AgentStatusTracker({
      events: events as never as EventBus,
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
    events.emit('subagent.spawned', {
      subagentId: 'sa-m',
      name: 'worker',
      model: 'anthropic/claude-opus-4-8',
    });
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
    events.emit('subagent.iteration_summary', {
      subagentId: 'sa-c',
      iteration: 10,
      toolCalls: 20,
      costUsd: 0.077,
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-c');
    expect(sub?.costUsd).toBeCloseTo(0.077, 5);
  });

  it('takes authoritative counts from subagent.iteration_summary', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-i', name: 'worker' });
    events.emit('subagent.iteration_summary', {
      subagentId: 'sa-i',
      iteration: 25,
      toolCalls: 47,
      currentTool: 'grep',
    });

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

  it('tracks and clears a subagent task assignment', () => {
    tracker.start();
    events.emit('subagent.spawned', {
      subagentId: 'sa-task',
      name: 'reviewer',
      taskId: 'task-42',
      description: 'Review the Office telemetry patch',
    });

    let call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    let sub = call?.find((agent) => agent.id === 'sa-task');
    expect(sub).toMatchObject({
      taskId: 'task-42',
      currentTask: 'Review the Office telemetry patch',
    });

    events.emit('subagent.task_completed', {
      subagentId: 'sa-task',
      status: 'success',
    });
    call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    sub = call?.find((agent) => agent.id === 'sa-task');
    expect(sub?.currentTask).toBeUndefined();
    expect(sub?.taskId).toBeUndefined();
  });

  it('sets subagent to idle on successful task_completed', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-3', name: 'critic' });
    events.emit('subagent.task_completed', {
      subagentId: 'sa-3',
      status: 'success',
      iterations: 4,
      toolCalls: 9,
    });

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

  it('removes subagent immediately on subagent.removed', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-removed', name: 'temp' });
    events.emit('subagent.removed', { subagentId: 'sa-removed', reason: 'idle timeout' });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    expect(call?.find((a: AgentEntry) => a.id === 'sa-removed')).toBeUndefined();
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
      events: events as never as EventBus,
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

  it('keeps bounded mail receipts and session mail totals per agent', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'worker-a', name: 'worker' });
    events.emit('mailbox.message_sent', {
      messageId: 'mail-out',
      from: 'worker-a',
      to: 'leader',
      type: 'result',
      subject: 'Work complete',
    });
    events.emit('mailbox.received', {
      messageId: 'mail-in',
      from: 'leader',
      to: 'worker-a',
      type: 'note',
      subject: 'One more thing',
    });
    // Duplicate delivery notifications must not inflate the session dashboard.
    events.emit('mailbox.received', {
      messageId: 'mail-in',
      from: 'leader',
      to: 'worker-a',
      type: 'note',
      subject: 'One more thing',
    });

    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const worker = call?.find((agent) => agent.id === 'worker-a');
    expect(worker?.recentMail).toEqual([
      expect.objectContaining({ id: 'mail-in', direction: 'incoming' }),
      expect.objectContaining({ id: 'mail-out', direction: 'outgoing' }),
    ]);
    expect(worker?.activity).toMatchObject({ mailReceived: 1, mailSent: 1 });
  });

  it('does not register updateAgents failure as a crash', () => {
    const failingRegistry = {
      updateAgents: vi.fn().mockRejectedValue(new Error('disk full')),
    } as never as SessionRegistry;
    const t = new AgentStatusTracker({
      events: events as never as EventBus,
      registry: failingRegistry,
    });
    t.start();

    // Should not throw
    expect(() => events.emit('agent.run.started', {})).not.toThrow();
  });

  // ── Edge coverage ─────────────────────────────────────────────────

  it('getAgents is empty before any flush and populated after', () => {
    expect(tracker.getAgents()).toEqual([]);
    tracker.start();
    events.emit('agent.run.started', { model: 'anthropic/claude-haiku-4-5' });
    const agents = tracker.getAgents();
    const leader = agents.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('handles iteration.started without ctx, provider.response, and text_delta without text', () => {
    tracker.start();
    events.emit('iteration.started', { index: 1 }); // no ctx branch
    events.emit('provider.text_delta', {}); // no text → return
    events.emit('provider.response', { ctx: { model: 'anthropic/anthropic-test-model' } });
    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const leader = call?.find((a: AgentEntry) => a.id === 'leader');
    expect(leader?.model).toBe('anthropic/anthropic-test-model');
  });

  it('ignores token.accounted with no payload and subagent events without a subagentId', () => {
    tracker.start();
    const before = registry.updateAgents.mock.calls.length;
    events.emit('token.accounted', null);
    events.emit('subagent.spawned', {}); // no subagentId
    events.emit('subagent.ctx_pct', { load: 0.5 }); // no subagentId
    events.emit('subagent.task_started', {}); // no subagentId
    events.emit('subagent.tool_executed', {}); // no subagentId
    events.emit('subagent.iteration_summary', {}); // no subagentId
    events.emit('subagent.task_completed', {}); // no subagentId
    events.emit('subagent.stopped', {}); // no subagentId → delete returns false → no flush
    expect(registry.updateAgents.mock.calls.length).toBe(before);
  });

  it('clamps a non-finite subagent ctx load to 0', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-nan', name: 'worker' });
    events.emit('subagent.ctx_pct', { subagentId: 'sa-nan', load: Number.NaN });
    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    expect(call?.find((a: AgentEntry) => a.id === 'sa-nan')?.ctxPct).toBe(0);
  });

  it('caps an oversized subagent partialText', () => {
    tracker.start();
    events.emit('subagent.spawned', { subagentId: 'sa-big', name: 'worker' });
    events.emit('subagent.iteration_summary', {
      subagentId: 'sa-big',
      partialText: 'x'.repeat(2000),
    });
    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    const sub = call?.find((a: AgentEntry) => a.id === 'sa-big');
    expect(sub?.partialText?.length).toBe(1200);
  });

  it('accepts non-object payloads when a sessionId is configured', () => {
    tracker = new AgentStatusTracker({
      events: events as never as EventBus,
      registry: registry as never as SessionRegistry,
      sessionId: 's1',
    });
    tracker.start();
    // Non-object payload → acceptsSession returns true (no sessionId field to check).
    events.emit('tool.started', 'not-an-object');
    const call = registry.updateAgents.mock.calls.at(-1)?.[0] as AgentEntry[];
    expect(call?.find((a: AgentEntry) => a.id === 'leader')).toBeDefined();
  });

  it('stop() clears a pending partial flush timer', () => {
    vi.useFakeTimers();
    try {
      tracker.start();
      events.emit('provider.text_delta', { text: 'streaming' }); // schedules partialTimer
      tracker.stop(); // clears partialTimer + sweepTimer + unsubscribers
      // No flush fires after stop.
      const before = registry.updateAgents.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(registry.updateAgents.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onUpdate fires after a successful registry write', async () => {
    let updated = false;
    tracker = new AgentStatusTracker({
      events: events as never as EventBus,
      registry: registry as never as SessionRegistry,
      onUpdate: () => {
        updated = true;
      },
    });
    tracker.start();
    events.emit('agent.run.started', {});
    // registry.updateAgents resolves → onUpdate fires on the microtask.
    await vi.waitFor(() => expect(updated).toBe(true));
  });
});
