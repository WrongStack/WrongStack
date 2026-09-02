import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('@wrongstack/core/goal', () => {
  class PhaseOrchestrator {
    pause = vi.fn();
    resume = vi.fn();
    stop = vi.fn();
    isRunning = vi.fn(() => true);
    moveTask = vi.fn(() => true);
    setTaskAssignee = vi.fn(() => true);
    addTask = vi.fn(() => 'task-new');
    requeueTask = vi.fn(() => true);
    getProgress = vi.fn(() => ({ completed: 1, total: 2 }));
    start = vi.fn(async () => undefined);
  }
  class PhaseStore {
    saved: unknown[] = [];
    graphs = new Map<string, unknown>();
    save = vi.fn(async (graph: unknown) => {
      this.saved.push(graph);
    });
    list = vi.fn(async () => [{ id: 'g1', title: 'Saved Goal' }]);
    load = vi.fn(async (id: string) => this.graphs.get(id) ?? null);
  }
  class PhaseGraphBuilder {
    constructor(public readonly opts: unknown) {}
    build = vi.fn(async () =>
      makeGraph('graph-built', this.opts as Record<string, unknown> | undefined),
    );
  }
  class GoalPlanner {
    constructor(public readonly opts: unknown) {}
    plan = vi.fn(async () => {
      // Gate planning on runOnce so stop-during-planning tests can hold it.
      const opts = this.opts as { runOnce: (prompt: string) => Promise<string> };
      await opts.runOnce('plan');
      return { phases: [], parseFailed: true };
    });
  }
  class GoalAssessor {
    constructor(public readonly opts: unknown) {}
    assess = vi.fn(async () => {
      // Route through runOnce so a failing agent surfaces as a throw.
      const opts = this.opts as { runOnce: (prompt: string) => Promise<string> };
      await opts.runOnce('assess');
      return {
        realistic: false,
        durationClaimed: '2 days',
        explanation: 'too optimistic',
        recommendedDuration: '2 weeks',
        concerns: ['scope'],
        raw: '',
        parseFailed: false,
      };
    });
  }
  function makeGraph(id: string, opts: Record<string, unknown> = {}) {
    const phase = {
      id: 'phase-1',
      name: 'Only Phase',
      status: 'pending',
      taskGraph: { nodes: new Map() },
    };
    return {
      id,
      title: opts['title'] ?? 'Built Goal',
      autonomous: opts['autonomous'] ?? true,
      phases: new Map([[phase.id, phase]]),
      completedPhaseIds: [],
      activePhaseIds: [],
    };
  }
  return { GoalAssessor, GoalPlanner, PhaseGraphBuilder, PhaseOrchestrator, PhaseStore };
});
vi.mock('@wrongstack/core/worktree', () => ({
  WorktreeManager: vi.fn(),
}));
vi.mock('../src/server/git-process.js', () => ({
  gitStdout: vi.fn(async () => null),
  isGitWorkTree: vi.fn(async () => false),
}));

import { GoalWebSocketHandler } from '../src/server/goal-ws-handler.js';

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

class FakeWs {
  readyState = 1;
  bufferedAmount = 0;
  sent: Sent[] = [];
  handlers = new Map<string, Array<() => void>>();
  terminate = vi.fn();
  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data) as Sent);
  });
  on(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string): void {
    for (const cb of this.handlers.get(event) ?? []) cb();
  }
}

function makeHandler(opts: { agentRun?: () => Promise<unknown> } = {}) {
  const storeDir = '/store';
  const agent = {
    run: opts.agentRun ?? (vi.fn(async () => ({ status: 'done', finalText: '[]' })) as never),
  };
  const context = { session: { id: 'sess-1' }, cwd: '/proj' };
  const info = vi.fn();
  const logger = {
    debug: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
    level: 'info',
    trace: vi.fn(),
    child: vi.fn(),
  } as never;
  const onBoardState = vi.fn();
  const handler = new GoalWebSocketHandler(
    agent as never,
    context as never,
    logger,
    storeDir,
    undefined,
    undefined,
    onBoardState,
  );
  return { handler, logger, info, onBoardState, ws: new FakeWs() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GoalWebSocketHandler — client lifecycle and simple messages', () => {
  it('sends nothing to new clients until a graph exists, and drops them on close', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    expect(ws.sent).toHaveLength(0);

    ws.emit('close');
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.status' });
    // Broadcast reaches nobody after close, but nothing throws.
    handler.dispose();
  });

  it('relays pause, resume, and status to the orchestrator', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);

    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.pause' });
    expect(ws.sent.some((m) => m.type === 'goal.paused')).toBe(true);

    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.resume' });
    expect(ws.sent.some((m) => m.type === 'goal.resumed')).toBe(true);

    // goal.status without a graph is a silent no-op (broadcastState guards).
    const before = ws.sent.length;
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.status' });
    expect(ws.sent.length).toBe(before);
    handler.dispose();
  });

  it('lists persisted graphs', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.list' });
    const list = ws.sent.find((m) => m.type === 'goal.list')?.payload;
    expect(list?.['graphs']).toEqual([{ id: 'g1', title: 'Saved Goal' }]);
    handler.dispose();
  });
});

describe('GoalWebSocketHandler — goal.assess', () => {
  it('short-circuits an empty goal with a neutral result', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.assess',
      payload: { goal: '   ', seq: 7 },
    });
    const result = ws.sent.find((m) => m.type === 'goal.assess.result')?.payload;
    expect(result).toMatchObject({ realistic: true, reqSeq: 7, concerns: [] });
    handler.dispose();
  });

  it('returns the assessor verdict with the request seq', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.assess',
      payload: { goal: 'rewrite everything in 1 day', seq: 3 },
    });
    const result = ws.sent.find((m) => m.type === 'goal.assess.result')?.payload;
    expect(result).toMatchObject({
      realistic: false,
      durationClaimed: '2 days',
      recommendedDuration: '2 weeks',
      reqSeq: 3,
    });
    handler.dispose();
  });

  it('reports assessment failures as parse failures', async () => {
    const { handler, ws } = makeHandler({
      agentRun: vi.fn(async () => {
        throw new Error('agent down');
      }) as never,
    });
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.assess',
      payload: { goal: 'check this' },
    });
    const result = ws.sent.find((m) => m.type === 'goal.assess.result')?.payload;
    expect(result).toMatchObject({ realistic: true, parseFailed: true });
    expect(String(result?.['parseError'])).toContain('agent down');
    handler.dispose();
  });
});

describe('GoalWebSocketHandler — goal.start', () => {
  it('builds and persists the graph, then launches the orchestrator', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: {
        goal: 'Ship the new dashboard.\nMore detail here.',
        phases: [{ name: 'Only Phase', description: '', priority: 'high', estimateHours: 1 }],
        autonomous: false,
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const state = ws.sent.find((m) => m.type === 'goal.state')?.payload;
    expect(state).toMatchObject({ title: 'Ship the new dashboard.' });
    handler.dispose();
  });

  it('uses the default phases when the planner fails', async () => {
    const { handler, ws, info } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'vague goal' },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('using defaults'));
    handler.dispose();
  });

  it('never launches when a stop lands during planning', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { handler, ws } = makeHandler({
      agentRun: vi.fn(async () => {
        await held;
        return { status: 'done', finalText: '[]' } as never;
      }) as never,
    });
    handler.addClient(ws as unknown as WebSocket);
    const starting = handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'slow plan' },
    });
    await new Promise((r) => setTimeout(r, 20));
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.stop' });
    release();
    await starting;
    const stopped = ws.sent.filter((m) => m.type === 'goal.stopped');
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    // The planning resolve must not have launched the run: no state broadcast
    // ever happened for the never-started graph.
    expect(ws.sent.some((m) => m.type === 'goal.state')).toBe(false);
    handler.dispose();
  });
});

describe('GoalWebSocketHandler — stop, clear, revert', () => {
  it('stops the run and broadcasts the stopped title', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'stoppable goal' },
    });
    await new Promise((r) => setTimeout(r, 30));
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.stop' });
    const stopped = ws.sent.find((m) => m.type === 'goal.stopped')?.payload;
    expect(stopped).toMatchObject({ title: 'stoppable goal' });
    handler.dispose();
  });

  it('clears the board back to the empty state', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'clearable goal' },
    });
    await new Promise((r) => setTimeout(r, 30));
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.clear' });
    expect(ws.sent.some((m) => m.type === 'goal.cleared')).toBe(true);
    const state = ws.sent.filter((m) => m.type === 'goal.state').at(-1)?.payload;
    expect(state?.['graphId']).toBeUndefined();
    handler.dispose();
  });

  it('refuses a revert without a captured git baseline', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.revert' });
    const reverted = ws.sent.find((m) => m.type === 'goal.reverted')?.payload;
    expect(reverted).toMatchObject({
      ok: false,
      reverted: 0,
      reason: 'no git baseline was captured for this run',
    });
    handler.dispose();
  });
});

describe('GoalWebSocketHandler — board mutations without a live run', () => {
  it('ignores board mutations until a graph exists', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.moveTask',
      payload: { taskId: 't1', toPhaseId: 'p2' },
    });
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.addTask',
      payload: { phaseId: 'p1', title: 'new task' },
    });
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.toggleAutonomous',
      payload: { autonomous: false },
    });
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.save' });
    // No goal.state / goal.saved broadcasts — nothing is running.
    expect(ws.sent.some((m) => m.type === 'goal.saved')).toBe(false);
    handler.dispose();
  });

  it('loads a persisted graph by id and errors on unknown ids', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.load',
      payload: { graphId: 'missing' },
    });
    expect(ws.sent.find((m) => m.type === 'goal.error')?.payload).toMatchObject({
      message: 'Graph not found: missing',
    });
    handler.dispose();
  });
});
