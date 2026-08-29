import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalDashboard } from '../src/server/terminal-dashboard.js';
import {
  buildSessionRows,
  formatSessionRowsBlock,
  startWebUILiveStatusLogger,
} from '../src/server/webui-status-logger.js';

function fakeDashboard(enabled = true) {
  return {
    enabled,
    setSessions: vi.fn(),
  } as unknown as TerminalDashboard & { setSessions: ReturnType<typeof vi.fn> };
}

const flush = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SESSIONS = [
  { id: 'sess_abc123', model: 'claude-3-5-sonnet', provider: 'anthropic', isRunning: true },
  { id: 'sess_def456', model: 'glm-5.3', provider: 'zai', isRunning: false },
];

describe('startWebUILiveStatusLogger', () => {
  it('feeds merged session rows to the dashboard panel', async () => {
    const events = new EventEmitter();
    const dashboard = fakeDashboard(true);

    const stop = startWebUILiveStatusLogger({
      events,
      dashboard,
      debounceMs: 1,
      heartbeatMs: 10_000,
      getSessionList: () => SESSIONS,
    });

    events.emit('agent_spawned', { agentId: 'sub_1', role: 'coder', sessionId: 'sess_abc123' });
    events.emit('agent_status', { agentId: 'sub_1', status: 'done', sessionId: 'sess_abc123' });
    events.emit('iteration_started', { index: 2, maxIterations: 10, sessionId: 'sess_abc123' });
    await flush();

    expect(dashboard.setSessions).toHaveBeenCalled();
    const rows = dashboard.setSessions.mock.lastCall?.[0];
    expect(rows).toHaveLength(2);

    const running = rows![0]!;
    expect(running.id).toBe('sess_abc123');
    expect(running.isRunning).toBe(true);
    expect(running.provider).toBe('anthropic');
    expect(running.model).toBe('claude-3-5-sonnet');
    expect(running.iteration).toEqual({ index: 2, max: 10 });
    expect(running.totalSubagents).toBe(1);
    expect(running.runningSubagents).toBe(0);
    expect(running.agents).toEqual([
      expect.objectContaining({
        id: 'leader',
        label: 'leader',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        status: 'running',
        iteration: { index: 2, max: 10 },
        toolCalls: 0,
      }),
      expect.objectContaining({
        id: 'sub_1',
        label: 'coder',
        status: 'done',
        toolCalls: 0,
      }),
    ]);

    const idle = rows![1]!;
    expect(idle.isRunning).toBe(false);
    expect(idle.iteration).toBeUndefined();

    stop();
  });

  it('tracks real core leader and subagent lifecycle events', async () => {
    const events = new EventEmitter();
    const dashboard = fakeDashboard(true);
    let clock = 12_000;

    const stop = startWebUILiveStatusLogger({
      events,
      dashboard,
      debounceMs: 1,
      heartbeatMs: 10_000,
      getSessionList: () => SESSIONS,
      now: () => clock,
    });

    events.emit('iteration.started', { index: 1, sessionId: 'sess_abc123' });
    events.emit('tool.executed', {
      name: 'read',
      durationMs: 5,
      ok: true,
      sessionId: 'sess_abc123',
    });
    events.emit('subagent.spawned', {
      subagentId: 'sub_real',
      name: 'Reviewer',
      provider: 'openai',
      model: 'gpt-5.3-codex',
      sessionId: 'sess_abc123',
    });
    clock = 15_000;
    events.emit('subagent.tool_executed', {
      subagentId: 'sub_real',
      name: 'rg',
      durationMs: 20,
      ok: true,
      sessionId: 'sess_abc123',
    });
    events.emit('subagent.iteration_summary', {
      subagentId: 'sub_real',
      iteration: 2,
      toolCalls: 3,
      costUsd: 0.01,
      sessionId: 'sess_abc123',
    });
    events.emit('subagent.task_completed', {
      subagentId: 'sub_real',
      status: 'success',
      iterations: 2,
      toolCalls: 3,
      durationMs: 3_000,
      sessionId: 'sess_abc123',
    });
    await flush();

    const rows = dashboard.setSessions.mock.lastCall?.[0];
    expect(rows![0]!.agents).toEqual([
      expect.objectContaining({
        id: 'leader',
        iteration: { index: 1 },
        toolCalls: 1,
        startedAt: 12_000,
      }),
      expect.objectContaining({
        id: 'sub_real',
        label: 'Reviewer',
        provider: 'openai',
        model: 'gpt-5.3-codex',
        status: 'success',
        iteration: { index: 2 },
        toolCalls: 3,
        startedAt: 12_000,
        durationMs: 3_000,
      }),
    ]);
    stop();
  });

  it('clears the iteration counter and stamps on run.result', async () => {
    const events = new EventEmitter();
    const dashboard = fakeDashboard(true);

    const stop = startWebUILiveStatusLogger({
      events,
      dashboard,
      debounceMs: 1,
      heartbeatMs: 10_000,
      getSessionList: () => SESSIONS.map((s) => ({ ...s, isRunning: false })),
    });

    events.emit('iteration_started', { index: 4, maxIterations: 10, sessionId: 'sess_abc123' });
    await flush();
    events.emit('run.result', { sessionId: 'sess_abc123' });
    await flush();

    const rows = dashboard.setSessions.mock.lastCall?.[0];
    expect(rows![0]!.iteration).toBeUndefined();
    stop();
  });

  it('stamps run start so rows carry runningSince', async () => {
    const events = new EventEmitter();
    const dashboard = fakeDashboard(true);
    let clock = 5_000;

    const stop = startWebUILiveStatusLogger({
      events,
      dashboard,
      debounceMs: 1,
      heartbeatMs: 10_000,
      getSessionList: () => SESSIONS,
      now: () => clock,
    });

    // Any event triggers a debounced emit; use one that mutates nothing.
    events.emit('agent_status', { agentId: 'unknown_agent' });
    await flush();
    let rows = dashboard.setSessions.mock.lastCall?.[0];
    expect(rows![0]!.runningSince).toBe(5_000);

    clock = 9_000;
    events.emit('iteration_started', { index: 1, maxIterations: 3, sessionId: 'sess_abc123' });
    await flush();
    rows = dashboard.setSessions.mock.lastCall?.[0];
    expect(rows![0]!.runningSince).toBe(5_000);
    stop();
  });

  it('falls back to a plain console block when the dashboard is disabled', async () => {
    const events = new EventEmitter();
    const dashboard = fakeDashboard(false);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const stop = startWebUILiveStatusLogger({
      events,
      dashboard,
      debounceMs: 1,
      heartbeatMs: 10_000,
      getSessionList: () => SESSIONS,
    });

    events.emit('iteration_started', { index: 2, maxIterations: 10, sessionId: 'sess_abc123' });
    await flush();

    expect(consoleSpy).toHaveBeenCalled();
    const text = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('sess_abc123');
    expect(text).toContain('anthropic/claude-3-5-sonnet');
    expect(text).toContain('RUNNING');
    expect(text).toContain('iter 2/10');
    expect(text).toContain('sess_def456');

    stop();
    consoleSpy.mockRestore();
  });

  it('stops emitting after the disposer runs (debounce and timers cleared)', async () => {
    const events = new EventEmitter();
    const dashboard = fakeDashboard(true);

    const stop = startWebUILiveStatusLogger({
      events,
      dashboard,
      debounceMs: 1,
      heartbeatMs: 5,
      getSessionList: () => SESSIONS,
    });

    events.emit('agent_spawned', { agentId: 'sub_9', role: 'tester', sessionId: 'sess_abc123' });
    await flush();
    stop();

    const callsAfterStop = dashboard.setSessions.mock.calls.length;
    events.emit('agent_spawned', { agentId: 'sub_10', role: 'tester', sessionId: 'sess_abc123' });
    await flush(40);
    expect(dashboard.setSessions.mock.calls.length).toBe(callsAfterStop);
  });
});

describe('buildSessionRows', () => {
  it('merges subagents, iterations and run-start stamps', () => {
    const subagents = new Map([
      [
        'sess_abc123',
        new Map([['sub_1', { id: 'sub_1', role: 'coder', status: 'running', toolCalls: 0 }]]),
      ],
    ]);
    const iterations = new Map([['sess_abc123', { index: 3, max: 9 }]]);
    const started = new Map([['sess_abc123', 1_000]]);

    const rows = buildSessionRows(SESSIONS, subagents, iterations, started);

    expect(rows[0]).toEqual({
      id: 'sess_abc123',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      isRunning: true,
      iteration: { index: 3, max: 9 },
      runningSubagents: 1,
      totalSubagents: 1,
      runningSince: 1_000,
      agents: [
        {
          id: 'leader',
          label: 'leader',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          status: 'running',
          iteration: { index: 3, max: 9 },
          toolCalls: 0,
          startedAt: 1_000,
        },
        {
          id: 'sub_1',
          label: 'coder',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          status: 'running',
          toolCalls: 0,
        },
      ],
    });
    expect(rows[1]).toEqual({
      id: 'sess_def456',
      provider: 'zai',
      model: 'glm-5.3',
      isRunning: false,
      runningSubagents: 0,
      totalSubagents: 0,
      agents: [
        {
          id: 'leader',
          label: 'leader',
          provider: 'zai',
          model: 'glm-5.3',
          status: 'idle',
          toolCalls: 0,
        },
      ],
    });
  });

  it('omits iteration and elapsed for idle sessions', () => {
    const rows = buildSessionRows(
      [SESSIONS[1]!],
      new Map(),
      new Map([['sess_def456', { index: 2, max: 4 }]]),
      new Map([['sess_def456', 1_000]]),
    );

    expect(rows[0]!.iteration).toBeUndefined();
    expect(rows[0]!.runningSince).toBeUndefined();
  });
});

describe('formatSessionRowsBlock', () => {
  it('renders the append-only block for non-TTY output', () => {
    const rows = buildSessionRows(SESSIONS, new Map(), new Map(), new Map());
    const block = formatSessionRowsBlock(rows);

    expect(block).toContain('2 sessions');
    expect(block).toContain('sess_abc123');
    expect(block).toContain('anthropic/claude-3-5-sonnet → RUNNING');
    expect(block).toContain('sess_def456');
    expect(block).toContain('IDLE');
  });

  it('reports the empty state', () => {
    expect(formatSessionRowsBlock([])).toBe('[WebUI Live Status] No active sessions.');
  });
});
