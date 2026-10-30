import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const captures = vi.hoisted(() => ({ orchestratorOpts: null as Record<string, unknown> | null }));

vi.mock('@wrongstack/goal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/goal')>();
  class PhaseOrchestrator {
    constructor(opts: Record<string, unknown>) {
      captures.orchestratorOpts = opts;
    }
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
    listGoals = vi.fn(async () => []);
    load = vi.fn(async (id: string) => this.graphs.get(id) ?? null);
    acquireRunLease = vi.fn(async () => vi.fn(async () => undefined));
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
      return {
        phases: [
          {
            name: 'Only Phase',
            description: 'work',
            priority: 'high',
            estimateHours: 1,
            parallelizable: false,
            taskTemplates: [
              {
                title: 'Do work',
                description: 'work',
                type: 'implementation',
                priority: 'high',
                estimateHours: 1,
              },
            ],
          },
        ],
        parseFailed: false,
      };
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
  return {
    ...actual,
    GoalAssessor,
    GoalPlanner,
    PhaseGraphBuilder,
    PhaseOrchestrator,
    PhaseStore,
  };
});
vi.mock('@wrongstack/worktree', () => ({
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

function makeHandler(
  opts: {
    agentRun?: () => Promise<unknown>;
    taskAgentFactory?: () => Promise<unknown>;
    projectRoot?: string;
  } = {},
) {
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
    opts.projectRoot,
    onBoardState,
    opts.taskAgentFactory as never,
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

  it('reports an idle resume error and still answers status', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);

    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.pause' });
    expect(ws.sent.some((m) => m.type === 'goal.paused')).toBe(true);

    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.resume' });
    expect(ws.sent.find((m) => m.type === 'goal.error')?.payload).toMatchObject({
      message: 'No saved Goal to resume.',
    });

    // goal.status always returns an authoritative snapshot, including idle.
    const before = ws.sent.length;
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.status' });
    expect(ws.sent.length).toBe(before + 1);
    expect(ws.sent.at(-1)?.payload).toMatchObject({ status: 'idle', phases: [] });
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
        phases: [
          {
            name: 'Only Phase',
            description: '',
            priority: 'high',
            estimateHours: 1,
            taskTemplates: [
              {
                title: 'Do work',
                description: 'work',
                type: 'implementation',
                priority: 'high',
                estimateHours: 1,
              },
            ],
          },
        ],
        autonomous: false,
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const state = ws.sent.find((m) => m.type === 'goal.state')?.payload;
    expect(state).toMatchObject({ title: 'Ship the new dashboard.' });
    handler.dispose();
  });

  it('rejects a planner failure instead of launching taskless fallback phases', async () => {
    const { handler, ws } = makeHandler({
      agentRun: vi.fn(async () => {
        throw new Error('planner down');
      }) as never,
    });
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'vague goal' },
    });
    await new Promise((r) => setTimeout(r, 30));
    // `stage` lets the client report the failure in the chat that showed the
    // "planning" acknowledgement, not only as a transient toast (#416).
    expect(ws.sent.find((m) => m.type === 'goal.error')?.payload).toMatchObject({
      message: expect.stringContaining('did not produce executable tasks'),
      stage: 'planning',
      title: 'vague goal',
      sessionId: 'sess-1',
    });
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
    const stopping = handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.stop' });
    release();
    await Promise.all([starting, stopping]);
    const stopped = ws.sent.filter((m) => m.type === 'goal.stopped');
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    // The planning resolve must not have launched the run: no state broadcast
    // ever happened for the never-started graph.
    expect(ws.sent.some((m) => m.type === 'goal.state')).toBe(false);
    handler.dispose();
  });

  it('rejects a second start while a run is active', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    const phases = [
      {
        name: 'Only Phase',
        description: 'work',
        priority: 'high',
        estimateHours: 1,
        taskTemplates: [
          {
            title: 'Do work',
            description: 'work',
            type: 'implementation',
            priority: 'high',
            estimateHours: 1,
          },
        ],
      },
    ];
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'first', phases },
    });
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'second', phases },
    });
    expect(ws.sent.filter((m) => m.type === 'goal.error').at(-1)?.payload).toMatchObject({
      message: expect.stringContaining('already in progress'),
    });
    handler.dispose();
  });

  it('executes tasks on a fresh factory agent and disposes it', async () => {
    const mainRun = vi.fn();
    const workerRun = vi.fn(async () => ({ status: 'done', finalText: 'changed files' }));
    const dispose = vi.fn();
    const taskAgentFactory = vi.fn(async () => ({
      agent: { run: workerRun },
      events: {},
      dispose,
    }));
    const { handler, ws } = makeHandler({ agentRun: mainRun, taskAgentFactory });
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: {
        goal: 'isolated work',
        phases: [
          {
            name: 'Only Phase',
            description: 'work',
            priority: 'high',
            estimateHours: 1,
            taskTemplates: [
              {
                title: 'Do work',
                description: 'work',
                type: 'implementation',
                priority: 'high',
                estimateHours: 1,
              },
            ],
          },
        ],
      },
    });
    const ctx = captures.orchestratorOpts?.['ctx'] as {
      executeTask: (
        task: Record<string, unknown>,
        phaseId: string,
        env?: { cwd?: string },
      ) => Promise<unknown>;
    };
    await ctx.executeTask(
      {
        id: 't1',
        title: 'Do work',
        description: 'work',
        priority: 'high',
        type: 'implementation',
        updatedAt: 0,
      },
      'phase-1',
      { cwd: '/isolated' },
    );
    expect(taskAgentFactory).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'executor', cwd: '/isolated' }),
    );
    expect(workerRun).toHaveBeenCalledOnce();
    expect(mainRun).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    handler.dispose();
  });

  it('rejects a fulfilled worker result whose status is not done', async () => {
    const dispose = vi.fn();
    const taskAgentFactory = vi.fn(async () => ({
      agent: {
        run: vi.fn(async () => ({ status: 'failed', error: { message: 'worker failed' } })),
      },
      events: {},
      dispose,
    }));
    const { handler, ws } = makeHandler({ taskAgentFactory });
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: {
        goal: 'failure path',
        phases: [
          {
            name: 'Only Phase',
            description: 'work',
            priority: 'high',
            estimateHours: 1,
            taskTemplates: [
              {
                title: 'Do work',
                description: 'work',
                type: 'implementation',
                priority: 'high',
                estimateHours: 1,
              },
            ],
          },
        ],
      },
    });
    const ctx = captures.orchestratorOpts?.['ctx'] as {
      executeTask: (task: Record<string, unknown>, phaseId: string) => Promise<unknown>;
    };
    await expect(
      ctx.executeTask(
        {
          id: 't1',
          title: 'Do work',
          description: 'work',
          priority: 'high',
          type: 'implementation',
          updatedAt: 0,
        },
        'phase-1',
      ),
    ).rejects.toThrow('worker failed');
    expect(dispose).toHaveBeenCalledOnce();
    handler.dispose();
  });

  it('runs verification repair in the phase worktree using an isolated worker', async () => {
    const mainRun = vi.fn(async () => ({ status: 'done' }));
    const repairRun = vi.fn(async () => ({ status: 'done' }));
    const dispose = vi.fn();
    const taskAgentFactory = vi.fn(async () => ({
      agent: { run: repairRun },
      dispose,
    }));
    const { handler, ws } = makeHandler({
      agentRun: mainRun,
      taskAgentFactory,
      projectRoot: '/proj',
    });
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: {
        goal: 'repair worktree',
        verifyTasks: true,
        worktrees: false,
        phases: [
          {
            name: 'Only Phase',
            description: 'work',
            priority: 'high',
            estimateHours: 1,
            taskTemplates: [{ title: 'Do work', description: 'work', type: 'feature' }],
          },
        ],
      },
    });
    const ctx = captures.orchestratorOpts?.['ctx'] as {
      repairPhase: (
        phase: { name: string },
        failure: string,
        attempt: number,
        env: { cwd: string },
      ) => Promise<void>;
    };
    await ctx.repairPhase({ name: 'Only Phase' }, 'typecheck failed', 1, {
      cwd: '/phase-worktree',
    });

    expect(taskAgentFactory).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'executor', cwd: '/phase-worktree' }),
    );
    expect(repairRun).toHaveBeenCalledWith(
      expect.stringContaining('/phase-worktree'),
      expect.any(Object),
    );
    expect(mainRun).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    handler.dispose();
  });

  it('enables the verifier by default for a project-backed Goal run', async () => {
    const { handler, ws } = makeHandler({ projectRoot: '/proj' });
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: {
        goal: 'verified by default',
        worktrees: false,
        phases: [
          {
            name: 'Only Phase',
            description: 'work',
            priority: 'high',
            estimateHours: 1,
            taskTemplates: [{ title: 'Do work', description: 'work', type: 'feature' }],
          },
        ],
      },
    });
    const ctx = captures.orchestratorOpts?.['ctx'] as {
      verifyPhase?: unknown;
      verifyGoal?: unknown;
      repairPhase?: unknown;
    };
    expect(ctx.verifyPhase).toEqual(expect.any(Function));
    expect(ctx.verifyGoal).toEqual(expect.any(Function));
    expect(ctx.repairPhase).toEqual(expect.any(Function));
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
    expect(state?.['graphId']).toBeNull();
    handler.dispose();
  });

  it('reports in the state that no revert is available without a git baseline', async () => {
    const { handler, ws } = makeHandler();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.start',
      payload: { goal: 'goal without a baseline' },
    });
    await new Promise((r) => setTimeout(r, 30));
    const state = ws.sent.filter((m) => m.type === 'goal.state').at(-1)?.payload as
      | Record<string, unknown>
      | undefined;
    expect(state).toHaveProperty('revert', null);
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

  it('loads and resumes an incomplete persisted graph without replanning', async () => {
    const agentRun = vi.fn(async () => ({ status: 'done', finalText: '[]' }));
    const { handler, ws } = makeHandler({ agentRun });
    const store = (handler as unknown as { store: { graphs: Map<string, unknown> } }).store;
    const saved = {
      id: 'g1',
      title: 'Saved Goal',
      description: 'Build a saved project',
      autonomous: true,
      worktrees: false,
      verifyTasks: false,
      phases: new Map([
        ['p1', { id: 'p1', name: 'Build', status: 'paused', taskGraph: { nodes: new Map() } }],
      ]),
      completedPhaseIds: [],
      activePhaseIds: ['p1'],
      failedPhaseIds: [],
    };
    store.graphs.set('g1', saved);
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.load',
      payload: { query: 'Saved', resume: true },
    });

    expect(captures.orchestratorOpts?.['graph']).toBe(saved);
    expect(agentRun).not.toHaveBeenCalled();
    expect(ws.sent.some((message) => message.type === 'goal.resumed')).toBe(true);
    handler.dispose();
  });

  it('refuses to resume an already completed saved graph', async () => {
    const { handler, ws } = makeHandler();
    const store = (handler as unknown as { store: { graphs: Map<string, unknown> } }).store;
    store.graphs.set('done', {
      id: 'done',
      title: 'Done',
      description: 'Finished',
      phases: new Map([['p1', { id: 'p1', name: 'Build', status: 'completed' }]]),
      failedPhaseIds: [],
      completedPhaseIds: ['p1'],
      activePhaseIds: [],
      completedAt: 1,
    });
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage(ws as unknown as WebSocket, {
      type: 'goal.resume',
      payload: { graphId: 'done' },
    });

    expect(ws.sent.find((message) => message.type === 'goal.error')?.payload).toMatchObject({
      message: expect.stringContaining('already complete'),
    });
    handler.dispose();
  });
});
