import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const control = vi.hoisted(() => ({
  start: (): Promise<void> => Promise.resolve(),
}));

vi.mock('@wrongstack/goal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/goal')>();
  class PhaseOrchestrator {
    pause = vi.fn();
    resume = vi.fn();
    stop = vi.fn();
    isRunning = vi.fn(() => false);
    getProgress = vi.fn(() => ({ completed: 1, total: 1 }));
    start = vi.fn(() => control.start());
  }
  class PhaseStore {
    save = vi.fn(async () => undefined);
    list = vi.fn(async () => []);
    listGoals = vi.fn(async () => []);
    load = vi.fn(async () => null);
    acquireRunLease = vi.fn(async () => vi.fn(async () => undefined));
  }
  class PhaseGraphBuilder {
    constructor(public readonly opts: Record<string, unknown>) {}
    build = vi.fn(async () => {
      const phase = {
        id: 'phase-1',
        name: 'Only Phase',
        status: 'pending',
        taskGraph: { nodes: new Map() },
      };
      return {
        id: 'graph-built',
        title: this.opts['title'] ?? 'Built Goal',
        autonomous: true,
        phases: new Map([[phase.id, phase]]),
        completedPhaseIds: [],
        failedPhaseIds: [],
        activePhaseIds: [],
      };
    });
  }
  return { ...actual, PhaseGraphBuilder, PhaseOrchestrator, PhaseStore };
});
vi.mock('@wrongstack/worktree', () => ({ WorktreeManager: vi.fn() }));
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
  terminate = vi.fn();
  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data) as Sent);
  });
  on(): void {}
}

const PHASES = [
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
];

function makeHandler() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    level: 'info',
    trace: vi.fn(),
    child: vi.fn(),
  } as never;
  const handler = new GoalWebSocketHandler(
    { run: vi.fn(async () => ({ status: 'done', finalText: '[]' })) } as never,
    { session: { id: 'sess-1' }, cwd: '/proj' } as never,
    logger,
    '/store',
  );
  // Record the runState each save actually persisted — the store mock keeps
  // references, which would only show the final in-memory value.
  const persisted: Array<string | undefined> = [];
  const store = (handler as unknown as { store: { save: ReturnType<typeof vi.fn> } }).store;
  store.save.mockImplementation(async (graph: { runState?: string }) => {
    persisted.push(graph.runState);
  });
  const ws = new FakeWs();
  handler.addClient(ws as unknown as WebSocket);
  return { handler, ws, persisted };
}

async function startAndSettle(handler: GoalWebSocketHandler, ws: FakeWs): Promise<void> {
  await handler.handleMessage(ws as unknown as WebSocket, {
    type: 'goal.start',
    payload: { goal: 'Ship it', phases: PHASES },
  });
  await vi.waitFor(() =>
    expect(ws.sent.some((m) => m.type === 'goal.completed' || m.type === 'goal.failed')).toBe(true),
  );
  await new Promise((r) => setTimeout(r, 20));
}

afterEach(() => {
  control.start = () => Promise.resolve();
});

describe('GoalWebSocketHandler run state', () => {
  // Regression: a finished run kept `host.orchestrator`, so goal.pause after
  // completion flipped the finished Goal to 'paused' and persisted it.
  it('ignores goal.pause after the run completed', async () => {
    const { handler, ws, persisted } = makeHandler();
    await startAndSettle(handler, ws);
    expect(persisted.at(-1)).toBe('completed');
    const sentBefore = ws.sent.length;

    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.pause' });
    await new Promise((r) => setTimeout(r, 20));

    expect(persisted.at(-1)).toBe('completed');
    // No "paused" announcement for a run that cannot pause.
    expect(ws.sent.slice(sentBefore).some((m) => m.type === 'goal.paused')).toBe(false);
    await handler.handleMessage(ws as unknown as WebSocket, { type: 'goal.status' });
    expect(ws.sent.at(-1)?.payload).toMatchObject({ status: 'completed' });
    handler.dispose();
  });

  // Regression: an orchestrator that rejected was saved before `runState`
  // flipped to 'failed', so the aborted run stayed 'running' on disk.
  it('persists an aborted run as failed', async () => {
    control.start = () => Promise.reject(new Error('orchestrator blew up'));
    const { handler, ws, persisted } = makeHandler();
    await startAndSettle(handler, ws);

    expect(persisted.at(-1)).toBe('failed');
    handler.dispose();
  });
});
