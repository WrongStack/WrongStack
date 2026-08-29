/**
 * Live status tracker for the WebUI host terminal.
 *
 * Subscribes to the agent/iteration events, merges them with the host's
 * session list, and feeds one {@link DashboardSessionRow} per session to the
 * terminal dashboard's fixed panel — running/idle state, iteration counter,
 * subagent counts and run elapsed time. Redraws are debounced and
 * fingerprint-gated by the dashboard, so bursts of events cost at most one
 * panel repaint, and the heartbeat only refreshes the elapsed column.
 *
 * When the dashboard is disabled (non-TTY output or `WEBUI_VERBOSE=1`) the
 * tracker falls back to printing a compact status block on change — the
 * append-only shape redirected output and log collectors expect.
 */

import type {
  DashboardAgentRow,
  DashboardSessionRow,
  TerminalDashboard,
} from './terminal-dashboard.js';

interface EventBusLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface StatusSessionInfo {
  id: string;
  model: string;
  provider: string;
  isRunning: boolean;
}

interface SubagentRecord {
  id: string;
  role: string;
  status: string;
  provider?: string | undefined;
  model?: string | undefined;
  iteration?: { index: number; max?: number | undefined } | undefined;
  toolCalls: number;
  startedAt?: number | undefined;
  durationMs?: number | undefined;
}

export interface WebUILiveStatusLoggerOptions {
  events: EventBusLike;
  getSessionList: () => StatusSessionInfo[];
  /** The terminal dashboard that owns the fixed panel. */
  dashboard: Pick<TerminalDashboard, 'enabled' | 'setSessions'>;
  debounceMs?: number | undefined;
  heartbeatMs?: number | undefined;
  now?: (() => number) | undefined;
}

/**
 * Merge the host session list with the tracked subagents, iterations and
 * run-start timestamps into panel rows. Pure — exported for tests.
 */
export function buildSessionRows(
  sessions: readonly StatusSessionInfo[],
  sessionSubagents: ReadonlyMap<string, Map<string, SubagentRecord>>,
  sessionIterations: ReadonlyMap<string, { index: number; max?: number | undefined }>,
  runStartedAt: ReadonlyMap<string, number>,
  sessionToolCalls: ReadonlyMap<string, number> = new Map(),
): DashboardSessionRow[] {
  return sessions.map((session) => {
    const subagentMap = sessionSubagents.get(session.id);
    const subagents = subagentMap ? Array.from(subagentMap.values()) : [];
    const runningSubagents = subagents.filter((a) => a.status === 'running').length;
    const iteration = sessionIterations.get(session.id);
    const leader: DashboardAgentRow = {
      id: 'leader',
      label: 'leader',
      provider: session.provider,
      model: session.model,
      status: session.isRunning ? 'running' : 'idle',
      ...(session.isRunning && iteration
        ? {
            iteration: {
              index: iteration.index,
              ...(iteration.max !== undefined ? { max: iteration.max } : {}),
            },
          }
        : {}),
      toolCalls: sessionToolCalls.get(session.id) ?? 0,
      ...(session.isRunning && runStartedAt.has(session.id)
        ? { startedAt: runStartedAt.get(session.id) }
        : {}),
    };
    const agents: DashboardAgentRow[] = [
      leader,
      ...subagents.map((sub) => ({
        id: sub.id,
        label: sub.role || 'subagent',
        provider: sub.provider ?? session.provider,
        model: sub.model ?? session.model,
        status: sub.status,
        ...(sub.iteration ? { iteration: sub.iteration } : {}),
        toolCalls: sub.toolCalls ?? 0,
        ...(sub.startedAt !== undefined ? { startedAt: sub.startedAt } : {}),
        ...(sub.durationMs !== undefined ? { durationMs: sub.durationMs } : {}),
      })),
    ];
    return {
      id: session.id,
      provider: session.provider,
      model: session.model,
      isRunning: session.isRunning,
      ...(session.isRunning && iteration
        ? {
            iteration: {
              index: iteration.index,
              ...(iteration.max !== undefined ? { max: iteration.max } : {}),
            },
          }
        : {}),
      runningSubagents,
      totalSubagents: subagents.length,
      ...(session.isRunning && runStartedAt.has(session.id)
        ? { runningSince: runStartedAt.get(session.id) }
        : {}),
      agents,
    };
  });
}

/** Compact append-only block for non-TTY output (log files, pipes). */
export function formatSessionRowsBlock(rows: readonly DashboardSessionRow[]): string {
  if (rows.length === 0) return '[WebUI Live Status] No active sessions.';
  const runningCount = rows.filter((r) => r.isRunning).length;
  const agents = runningCount + rows.reduce((sum, r) => sum + Math.max(0, r.runningSubagents), 0);
  const lines = rows.map((row) => {
    const parts = [
      `[${row.id.slice(0, 14)}]`,
      `${row.provider}/${row.model} →`,
      row.isRunning ? 'RUNNING' : 'IDLE',
    ];
    if (row.iteration)
      parts.push(
        `(iter ${row.iteration.index}${row.iteration.max ? `/${row.iteration.max}` : ''})`,
      );
    if (row.totalSubagents > 0) parts.push(`| sub ${row.runningSubagents}/${row.totalSubagents}`);
    const agentLines = (row.agents ?? [])
      .map((agent) => {
        const target = [agent.provider, agent.model].filter(Boolean).join('/');
        const iter = agent.iteration
          ? `${agent.iteration.index}${agent.iteration.max ? `/${agent.iteration.max}` : ''}`
          : '-';
        return `      └── ${agent.label}:${agent.id.slice(0, 8)} ${target} ${agent.status} iter ${iter} tools ${agent.toolCalls}`;
      })
      .join('\n');
    return [`  ├── ${parts.join(' ')}`, agentLines].filter(Boolean).join('\n');
  });
  return `[WebUI Live Status] ${rows.length} session${rows.length === 1 ? '' : 's'} | ${agents} running agent${agents === 1 ? '' : 's'}\n${lines.join('\n')}`;
}

export function startWebUILiveStatusLogger(options: WebUILiveStatusLoggerOptions): () => void {
  const { events, getSessionList, dashboard } = options;
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? 400;
  const heartbeatMs = options.heartbeatMs ?? 5_000;

  const sessionSubagents = new Map<string, Map<string, SubagentRecord>>();
  const sessionIterations = new Map<string, { index: number; max?: number | undefined }>();
  const sessionToolCalls = new Map<string, number>();
  const runStartedAt = new Map<string, number>();
  const wasRunning = new Set<string>();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBlock = '';

  const trackRunTransitions = (sessions: readonly StatusSessionInfo[]): void => {
    for (const session of sessions) {
      if (session.isRunning && !wasRunning.has(session.id)) {
        if (!runStartedAt.has(session.id)) runStartedAt.set(session.id, now());
        if (!sessionToolCalls.has(session.id)) sessionToolCalls.set(session.id, 0);
        wasRunning.add(session.id);
      } else if (!session.isRunning && wasRunning.has(session.id)) {
        wasRunning.delete(session.id);
        runStartedAt.delete(session.id);
      }
    }
  };

  const emit = (): void => {
    const sessions = getSessionList();
    // Track idle→running flips BEFORE building rows so the row carries the
    // fresh run-start stamp on the very first emit of a run.
    trackRunTransitions(sessions);
    const rows = buildSessionRows(
      sessions,
      sessionSubagents,
      sessionIterations,
      runStartedAt,
      sessionToolCalls,
    );
    if (dashboard.enabled) {
      dashboard.setSessions(rows);
      return;
    }
    const block = formatSessionRowsBlock(rows);
    if (block === lastBlock) return;
    lastBlock = block;
    console.log(`\n${block}\n`);
  };

  const requestEmit = (immediate = false): void => {
    if (immediate) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      emit();
      return;
    }
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emit();
    }, debounceMs);
  };

  const ensureSubagentMap = (sessionId: string): Map<string, SubagentRecord> => {
    let map = sessionSubagents.get(sessionId);
    if (!map) {
      map = new Map();
      sessionSubagents.set(sessionId, map);
    }
    return map;
  };

  const onAgentSpawned = (ev: unknown): void => {
    const data = ev as {
      agentId?: string;
      subagentId?: string;
      id?: string;
      role?: string;
      name?: string;
      provider?: string;
      model?: string;
      sessionId?: string;
    };
    const agentId = data.agentId || data.subagentId || data.id;
    const sessionId = data.sessionId;
    if (!agentId || !sessionId) return;

    ensureSubagentMap(sessionId).set(agentId, {
      id: agentId,
      role: data.role || data.name || 'subagent',
      status: 'running',
      toolCalls: 0,
      startedAt: now(),
      ...(data.provider ? { provider: data.provider } : {}),
      ...(data.model ? { model: data.model } : {}),
    });
    requestEmit();
  };

  const onAgentStatus = (ev: unknown): void => {
    const data = ev as {
      agentId?: string;
      subagentId?: string;
      id?: string;
      agentName?: string;
      status?: string;
      sessionId?: string;
    };
    const agentId = data.agentId || data.subagentId || data.id;
    if (!agentId) return;

    if (data.sessionId && sessionSubagents.has(data.sessionId)) {
      const sub = sessionSubagents.get(data.sessionId)?.get(agentId);
      if (sub) {
        sub.status = data.status || 'unknown';
        if (data.agentName) sub.role = data.agentName;
      }
    } else {
      for (const map of sessionSubagents.values()) {
        const sub = map.get(agentId);
        if (sub) {
          sub.status = data.status || 'unknown';
          if (data.agentName) sub.role = data.agentName;
          break;
        }
      }
    }
    requestEmit();
  };

  const onIterationStarted = (ev: unknown): void => {
    const data = ev as { index?: number; maxIterations?: number; sessionId?: string };
    if (data.sessionId && typeof data.index === 'number') {
      if (!runStartedAt.has(data.sessionId)) runStartedAt.set(data.sessionId, now());
      if (!sessionToolCalls.has(data.sessionId)) sessionToolCalls.set(data.sessionId, 0);
      sessionIterations.set(data.sessionId, {
        index: data.index,
        ...(typeof data.maxIterations === 'number' ? { max: data.maxIterations } : {}),
      });
    }
    requestEmit();
  };

  const onToolExecuted = (ev: unknown): void => {
    const data = ev as { sessionId?: string };
    if (!data.sessionId) return;
    sessionToolCalls.set(data.sessionId, (sessionToolCalls.get(data.sessionId) ?? 0) + 1);
    requestEmit();
  };

  const onSubagentToolExecuted = (ev: unknown): void => {
    const data = ev as {
      subagentId?: string;
      id?: string;
      sessionId?: string;
      agentName?: string;
    };
    const agentId = data.subagentId || data.id;
    if (!agentId || !data.sessionId) return;
    const sub = ensureSubagentMap(data.sessionId).get(agentId);
    if (sub) {
      sub.toolCalls += 1;
      sub.status = 'running';
      if (data.agentName) sub.role = data.agentName;
    }
    requestEmit();
  };

  const onSubagentIterationSummary = (ev: unknown): void => {
    const data = ev as {
      subagentId?: string;
      sessionId?: string;
      iteration?: number;
      toolCalls?: number;
    };
    if (!data.subagentId || !data.sessionId) return;
    const sub = ensureSubagentMap(data.sessionId).get(data.subagentId);
    if (!sub) return;
    if (typeof data.iteration === 'number') sub.iteration = { index: data.iteration };
    if (typeof data.toolCalls === 'number') sub.toolCalls = data.toolCalls;
    requestEmit();
  };

  const onSubagentTaskCompleted = (ev: unknown): void => {
    const data = ev as {
      subagentId?: string;
      sessionId?: string;
      status?: string;
      iterations?: number;
      toolCalls?: number;
      durationMs?: number;
    };
    if (!data.subagentId || !data.sessionId) return;
    const sub = ensureSubagentMap(data.sessionId).get(data.subagentId);
    if (!sub) return;
    sub.status = data.status || 'completed';
    if (typeof data.iterations === 'number') sub.iteration = { index: data.iterations };
    if (typeof data.toolCalls === 'number') sub.toolCalls = data.toolCalls;
    if (typeof data.durationMs === 'number') sub.durationMs = data.durationMs;
    requestEmit(true);
  };

  const onRunResult = (ev: unknown): void => {
    const data = ev as { sessionId?: string };
    if (data.sessionId) {
      sessionIterations.delete(data.sessionId);
    }
    requestEmit(true);
  };

  events.on('agent_spawned', onAgentSpawned);
  events.on('agent_status', onAgentStatus);
  events.on('agent:spawned', onAgentSpawned);
  events.on('agent:status', onAgentStatus);
  events.on('iteration_started', onIterationStarted);
  events.on('subagent.spawned', onAgentSpawned);
  events.on('agent.status_changed', onAgentStatus);
  events.on('iteration.started', onIterationStarted);
  events.on('tool.executed', onToolExecuted);
  events.on('subagent.tool_executed', onSubagentToolExecuted);
  events.on('subagent.iteration_summary', onSubagentIterationSummary);
  events.on('subagent.task_completed', onSubagentTaskCompleted);
  events.on('run.result', onRunResult);
  events.on('run:result', onRunResult);

  // Heartbeat: while anything is running, refresh the panel so the elapsed
  // column stays live. With the dashboard enabled this repaints in place;
  // without it, the fingerprint check keeps the block out of the log.
  const heartbeatTimer = setInterval(() => {
    const hasRunning = getSessionList().some((s) => s.isRunning);
    if (hasRunning) emit();
  }, heartbeatMs);

  // Initial panel shortly after boot.
  initialTimer = setTimeout(() => {
    initialTimer = null;
    requestEmit(true);
  }, 600);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (initialTimer) clearTimeout(initialTimer);
    clearInterval(heartbeatTimer);
    events.off('agent_spawned', onAgentSpawned);
    events.off('agent_status', onAgentStatus);
    events.off('agent:spawned', onAgentSpawned);
    events.off('agent:status', onAgentStatus);
    events.off('iteration_started', onIterationStarted);
    events.off('subagent.spawned', onAgentSpawned);
    events.off('agent.status_changed', onAgentStatus);
    events.off('iteration.started', onIterationStarted);
    events.off('tool.executed', onToolExecuted);
    events.off('subagent.tool_executed', onSubagentToolExecuted);
    events.off('subagent.iteration_summary', onSubagentIterationSummary);
    events.off('subagent.task_completed', onSubagentTaskCompleted);
    events.off('run.result', onRunResult);
    events.off('run:result', onRunResult);
  };
}
