export interface EventBusLike {
  on(event: string, listener: (...args: any[]) => void): any;
  off(event: string, listener: (...args: any[]) => void): any;
}

export interface WebUIStatusLoggerOptions {
  events: EventBusLike;
  getSessionList: () => Array<{
    id: string;
    model: string;
    provider: string;
    isRunning: boolean;
  }>;
  getAgent?: ((sessionId?: string) => unknown) | undefined;
}

interface SubagentRecord {
  id: string;
  role: string;
  status: string;
}

export function startWebUILiveStatusLogger(options: WebUIStatusLoggerOptions): () => void {
  const { events, getSessionList } = options;

  const sessionSubagents = new Map<string, Map<string, SubagentRecord>>();
  const sessionIterations = new Map<string, { index: number; max?: number | undefined }>();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLoggedFingerprint = '';

  const formatStatus = (): string => {
    const sessions = getSessionList();
    if (sessions.length === 0) {
      return '[WebUI Live Status] No active sessions.';
    }

    let totalRunningAgents = 0;
    const sessionLines: string[] = [];

    for (const session of sessions) {
      const subagentMap = sessionSubagents.get(session.id);
      const subagents = subagentMap ? Array.from(subagentMap.values()) : [];
      const runningSubagents = subagents.filter((a) => a.status === 'running');
      const sessionRunningAgents = (session.isRunning ? 1 : 0) + runningSubagents.length;
      totalRunningAgents += sessionRunningAgents;

      const iter = sessionIterations.get(session.id);
      const iterStr =
        session.isRunning && iter ? ` (iter ${iter.index}${iter.max ? `/${iter.max}` : ''})` : '';

      const statusIcon = session.isRunning ? '🟢 RUNNING' : '⚪ IDLE';

      let agentSummary = '';
      if (subagents.length > 0) {
        const subagentList = subagents
          .map((a) => `${a.role || a.id.slice(0, 8)} [${a.status === 'running' ? '🟢' : '✓'}]`)
          .join(', ');
        agentSummary = ` | Subagents (${subagents.length}): ${subagentList}`;
      }

      sessionLines.push(
        `  ├── [${session.id.slice(0, 14)}] ${session.provider} / ${session.model} → ${statusIcon}${iterStr}${agentSummary}`,
      );
    }

    const header = `[WebUI Live Status] ${sessions.length} Active Session${sessions.length > 1 ? 's' : ''} | ${totalRunningAgents} Running Agent${totalRunningAgents !== 1 ? 's' : ''}`;
    return [header, ...sessionLines].join('\n');
  };

  const printStatus = (): void => {
    const output = formatStatus();
    if (output === lastLoggedFingerprint) return;
    lastLoggedFingerprint = output;
    console.log(`\n${output}\n`);
  };

  const requestPrint = (immediate = false): void => {
    if (immediate) {
      if (debounceTimer) clearTimeout(debounceTimer);
      printStatus();
      return;
    }
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      printStatus();
    }, 400);
  };

  // Event handlers
  const onAgentSpawned = (ev: unknown): void => {
    const data = ev as { agentId?: string; id?: string; role?: string; sessionId?: string };
    const agentId = data.agentId || data.id;
    const sessionId = data.sessionId;
    if (!agentId || !sessionId) return;

    if (!sessionSubagents.has(sessionId)) {
      sessionSubagents.set(sessionId, new Map());
    }
    sessionSubagents.get(sessionId)?.set(agentId, {
      id: agentId,
      role: data.role || 'subagent',
      status: 'running',
    });
    requestPrint();
  };

  const onAgentStatus = (ev: unknown): void => {
    const data = ev as { agentId?: string; id?: string; status?: string; sessionId?: string };
    const agentId = data.agentId || data.id;
    const sessionId = data.sessionId;
    if (!agentId) return;

    // Find and update the subagent
    if (sessionId && sessionSubagents.has(sessionId)) {
      const sub = sessionSubagents.get(sessionId)?.get(agentId);
      if (sub) {
        sub.status = data.status || 'unknown';
      }
    } else {
      for (const map of sessionSubagents.values()) {
        const sub = map.get(agentId);
        if (sub) {
          sub.status = data.status || 'unknown';
          break;
        }
      }
    }
    requestPrint();
  };

  const onIterationStarted = (ev: unknown): void => {
    const data = ev as { index?: number; maxIterations?: number; sessionId?: string };
    if (data.sessionId && typeof data.index === 'number') {
      sessionIterations.set(data.sessionId, {
        index: data.index,
        ...(typeof data.maxIterations === 'number' ? { max: data.maxIterations } : {}),
      });
    }
    requestPrint();
  };

  const onRunResult = (ev: unknown): void => {
    const data = ev as { sessionId?: string };
    if (data.sessionId) {
      sessionIterations.delete(data.sessionId);
    }
    requestPrint(true);
  };

  events.on('agent_spawned', onAgentSpawned);
  events.on('agent_status', onAgentStatus);
  events.on('agent:spawned', onAgentSpawned);
  events.on('agent:status', onAgentStatus);
  events.on('iteration_started', onIterationStarted);
  events.on('run.result', onRunResult);
  events.on('run:result', onRunResult);

  // Periodic heartbeat when runs are active (every 8 seconds)
  const heartbeatTimer = setInterval(() => {
    const sessions = getSessionList();
    const hasRunning = sessions.some((s) => s.isRunning);
    if (hasRunning) {
      printStatus();
    }
  }, 8_000);

  // Initial print shortly after boot
  setTimeout(() => requestPrint(true), 600);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(heartbeatTimer);
    events.off('agent_spawned', onAgentSpawned);
    events.off('agent_status', onAgentStatus);
    events.off('agent:spawned', onAgentSpawned);
    events.off('agent:status', onAgentStatus);
    events.off('iteration_started', onIterationStarted);
    events.off('run.result', onRunResult);
    events.off('run:result', onRunResult);
  };
}
