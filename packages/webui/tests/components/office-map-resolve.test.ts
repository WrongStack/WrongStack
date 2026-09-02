import { describe, expect, it } from 'vitest';
import { resolveClients } from '../../src/components/OfficeMapCanvas/resolve.js';
import type { LiveSession } from '../../src/stores/monitor-store.js';
import type { SubagentView } from '../../src/stores/types.js';

describe('resolveClients project roster', () => {
  it('merges a mailbox identity into the matching live-session agent', () => {
    const sessions: LiveSession[] = [
      {
        sessionId: 'session-a',
        projectName: 'WrongStack',
        clientType: 'tui',
        pid: 4242,
        lastHeartbeatAt: '2026-07-17T10:00:05.000Z',
        agents: [{ id: 'leader', name: 'Leader', status: 'running' }],
      },
    ];

    const clients = resolveClients(sessions, new Map(), [
      {
        agentId: 'leader@abc',
        name: 'Leader',
        role: 'lead',
        sessionId: 'session-a',
        status: 'running',
        lastSeenAt: '2026-07-17T10:00:00.000Z',
        online: true,
      },
    ]);

    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      label: 'TUI · PID 4242',
      lastHeartbeatAt: '2026-07-17T10:00:05.000Z',
    });
    expect(clients[0]?.agents).toHaveLength(1);
    expect(clients[0]?.agents[0]).toMatchObject({
      serverId: 'leader',
      mailboxId: 'leader@abc',
      role: 'lead',
      presenceSource: 'registry',
    });
  });

  it('does not create a fake office from mailbox-only presence', () => {
    const clients = resolveClients([], new Map(), [
      {
        agentId: 'worker@xyz',
        name: 'Worker',
        sessionId: 'session-b',
        status: 'streaming',
        source: 'cli',
        pid: 4242,
        iterations: 3,
        toolCalls: 9,
        lastSeenAt: '2026-07-17T10:00:00.000Z',
        online: true,
      },
    ]);

    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ id: 'client-self', agents: [] });
  });

  it('does not add an unmatched mailbox identity to a real session', () => {
    const sessions: LiveSession[] = [
      {
        sessionId: 'session-a',
        projectName: 'WrongStack',
        clientType: 'cli',
        agents: [{ id: 'leader', name: 'Leader', status: 'idle' }],
      },
    ];
    const clients = resolveClients(sessions, new Map(), [
      {
        agentId: 'chimera-review',
        name: 'Chimera Review',
        sessionId: 'session-a',
        status: 'running',
        source: 'cli',
        lastSeenAt: '2026-07-17T10:00:00.000Z',
        online: true,
      },
    ]);

    expect(clients[0]?.agents.map((agent) => agent.name)).toEqual(['Leader']);
  });

  it('does not resurrect offline mailbox agents', () => {
    const clients = resolveClients([], new Map(), [
      {
        agentId: 'old@xyz',
        name: 'Old worker',
        sessionId: 'session-old',
        status: 'offline',
        lastSeenAt: '2026-07-16T10:00:00.000Z',
        online: false,
      },
    ]);

    expect(clients[0]?.agents).toHaveLength(0);
  });

  it('resolves prompt, todos, and assigned tasks from the real session snapshot', () => {
    const sessions: LiveSession[] = [
      {
        sessionId: 'session-work',
        clientType: 'webui',
        agents: [
          {
            id: 'leader',
            name: 'Leader',
            status: 'running',
            currentTool: 'read',
            currentTask: 'Build the office briefing',
            latestPrompt: 'Show every agent task and the active todo list',
            latestPromptAt: 1_752_750_000_000,
            todos: [{ id: 'todo-1', content: 'Render task cards', status: 'in_progress' }],
          },
          {
            id: 'reviewer',
            name: 'Reviewer',
            status: 'running',
            taskId: 'task-review',
            currentTask: 'Review the task visualization',
          },
        ],
      },
    ];

    const [client] = resolveClients(sessions, new Map());
    expect(client).toMatchObject({
      latestPrompt: 'Show every agent task and the active todo list',
      latestPromptAt: 1_752_750_000_000,
      activeInstruction: 'Show every agent task and the active todo list',
      todos: [{ id: 'todo-1', content: 'Render task cards', status: 'in_progress' }],
    });
    expect(client?.agents[0]).toMatchObject({
      currentTool: 'read',
      currentTask: 'Build the office briefing',
    });
    expect(client?.agents[1]).toMatchObject({
      taskId: 'task-review',
      currentTask: 'Review the task visualization',
    });
  });
});

/** Build a minimal fleet-agent stub for resolve-only tests. */
function fleetAgent(overrides: Partial<SubagentView>): SubagentView {
  return {
    id: 'w1',
    sessionId: 'session-a',
    name: 'Worker',
    status: 'running',
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: 1_752_750_000_000,
    toolLog: [],
    sparklineBins: [],
    ...overrides,
  };
}

describe('resolveClients merge + retention fold', () => {
  const NOW = 1_752_750_000_000;
  const SESSION: LiveSession = {
    sessionId: 'session-a',
    projectName: 'WrongStack',
    clientType: 'webui',
    agents: [{ id: 'leader', name: 'Leader', status: 'running' }],
  };

  it('merges a live fleet subagent into the matching session client office', () => {
    const fleetAgents = new Map<string, SubagentView>([
      ['w1', fleetAgent({ id: 'w1', sessionId: 'session-a', status: 'running' })],
    ]);

    const clients = resolveClients([SESSION], fleetAgents, [], new Map(), NOW);

    expect(clients).toHaveLength(1);
    const agents = clients[0]?.agents ?? [];
    const worker = agents.find((a) => a.name === 'Worker');
    expect(worker).toMatchObject({
      presenceSource: 'fleet',
      serverId: 'w1',
    });
    // Worker attached to the same client as the live Leader, not the
    // synthetic `client-self` fallback.
    expect(clients).toHaveLength(1);
    expect(clients[0]?.id).not.toBe('client-self');
  });

  it('routes a fleet subagent to the synthetic fallback when no live session matches', () => {
    const fleetAgents = new Map<string, SubagentView>([
      ['w1', fleetAgent({ id: 'w1', sessionId: 'session-ghost', status: 'running' })],
    ]);

    const clients = resolveClients([], fleetAgents, [], new Map(), NOW);

    expect(clients).toHaveLength(1);
    expect(clients[0]?.id).toBe('client-self');
    expect(clients[0]?.agents).toHaveLength(1);
    expect(clients[0]?.agents[0]).toMatchObject({
      name: 'Worker',
      presenceSource: 'fleet',
    });
  });

  it('keeps a finished fleet agent visible inside the matched session office for the grace window', () => {
    const recentlyFinished = new Map([
      [
        'w1',
        {
          agent: fleetAgent({ id: 'w1', sessionId: 'session-a', status: 'completed' }),
          finishedAt: NOW - 60_000,
        },
      ],
    ]);

    const clients = resolveClients([SESSION], new Map(), [], recentlyFinished, NOW);

    expect(clients).toHaveLength(1);
    expect(clients[0]?.id).not.toBe('client-self');
    const worker = (clients[0]?.agents ?? []).find((a) => a.name === 'Worker');
    expect(worker).toMatchObject({
      presenceSource: 'fleet',
      serverId: 'w1',
    });
  });

  it('prunes retention entries past the grace window', () => {
    const recentlyFinished = new Map([
      [
        'w1',
        {
          agent: fleetAgent({ id: 'w1', sessionId: 'session-a', status: 'completed' }),
          finishedAt: NOW - 20 * 60 * 1000, // 20 min ago — past FINISHED_AGENT_GRACE_MS (15 min)
        },
      ],
    ]);

    const clients = resolveClients([SESSION], new Map(), [], recentlyFinished, NOW);

    expect(clients[0]?.agents ?? []).not.toContainEqual(
      expect.objectContaining({ serverId: 'w1' }),
    );
  });

  it('drops retention entries whose sessionId leaf matches no live client', () => {
    const recentlyFinished = new Map([
      [
        'w1',
        {
          agent: fleetAgent({ id: 'w1', sessionId: 'session-ghost', status: 'completed' }),
          finishedAt: NOW - 60_000,
        },
      ],
    ]);

    const clients = resolveClients([SESSION], new Map(), [], recentlyFinished, NOW);

    // Retention is stricter than the live-leftover path: an orphan entry
    // whose sessionId matches no live client is silently dropped (L277-278
    // guards on `findSessionClient(...) ?? continue`). Live leftovers in the
    // same situation fall through to `ensureFallbackHost()` at L260-266,
    // but retention deliberately avoids creating ghost offices.
    expect(clients).toHaveLength(1);
    expect(clients[0]?.id).not.toBe('client-self');
    // The live session's own leader is rendered, but the retention orphan
    // must not appear on it either.
    const workers = (clients[0]?.agents ?? []).filter((a) => a.serverId === 'w1');
    expect(workers).toHaveLength(0);
  });

  it('does not double-render an agent that is both live and recently-finished', () => {
    const fleetAgents = new Map<string, SubagentView>([
      ['w1', fleetAgent({ id: 'w1', sessionId: 'session-a', status: 'running' })],
    ]);
    const recentlyFinished = new Map([
      [
        'w1',
        {
          agent: fleetAgent({ id: 'w1', sessionId: 'session-a', status: 'completed' }),
          finishedAt: NOW - 5_000,
        },
      ],
    ]);

    const clients = resolveClients([SESSION], fleetAgents, [], recentlyFinished, NOW);

    const workerHits = (clients[0]?.agents ?? []).filter((a) => a.serverId === 'w1');
    expect(workerHits).toHaveLength(1);
  });
});
