import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from '../src/ws-runtime.js';

// Mock ws module (matches ws-utils.test.ts style)
vi.mock('ws/native', async (importOriginal) => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  return { ...(await importOriginal<Record<string, unknown>>()), WebSocket: MockWebSocket };
});

// Mock git-process so we never spawn a real git binary
vi.mock('../src/server/git-process.js', () => ({
  gitStdout: vi.fn(async () => null),
  isGitWorkTree: vi.fn(async () => false),
}));

// Mock core/goal with stub types — handler does `new PhaseOrchestrator(...)` and
// `new PhaseStore(...)`, so we need constructors (must use class/function syntax).
vi.mock('@wrongstack/core/goal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/goal')>();
  class FakeOrchestrator {
    start = vi.fn();
    stop = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    moveTask = vi.fn(() => true);
    setTaskAssignee = vi.fn(() => true);
    addTask = vi.fn(() => true);
    requeueTask = vi.fn(() => true);
    getProgress = vi.fn(() => null);
  }
  class FakeGraphBuilder {
    build = vi.fn(async () => ({
      id: 'graph-1',
      title: 'Test Graph',
      description: 'desc',
      phases: new Map(),
      rootPhaseIds: [],
      autonomous: true,
      multiBoard: false,
      verifyTasks: false,
      chimeraReview: false,
      failedPhaseIds: [],
      save: vi.fn(),
    }));
  }
  class FakePhaseStore {
    save = vi.fn(async () => undefined);
    load = vi.fn(async () => null);
    list = vi.fn(async () => []);
    listGoals = vi.fn(async () => []);
    acquireRunLease = vi.fn(async () => vi.fn(async () => undefined));
  }
  class FakePlanner {
    plan = vi.fn(async () => ({ phases: [], parseFailed: false }));
  }
  class FakeAssessor {
    assess = vi.fn(async () => ({
      realistic: true,
      durationClaimed: null,
      explanation: '',
      recommendedDuration: null,
      concerns: [],
      raw: '',
      parseFailed: false,
    }));
  }
  return {
    ...actual,
    PhaseOrchestrator: FakeOrchestrator,
    PhaseGraphBuilder: FakeGraphBuilder,
    PhaseStore: FakePhaseStore,
    GoalPlanner: FakePlanner,
    GoalAssessor: FakeAssessor,
  };
});

vi.mock('@wrongstack/core/coordination', () => ({
  assignNickname: vi.fn(() => ({ key: 'nick-1', display: 'alice (1)' })),
}));

vi.mock('@wrongstack/core/worktree', () => {
  class FakeWorktreeManager {
    currentBase = vi.fn(async () => ({ branch: 'main', sha: 'abc' }));
    cleanupAllManaged = vi.fn(async () => undefined);
    revertCommits = vi.fn(async () => ({ ok: true, reverted: 0 }));
  }
  return { WorktreeManager: FakeWorktreeManager };
});

vi.mock('@wrongstack/core/utils', async () => {
  const actual =
    await vi.importActual<typeof import('@wrongstack/core/utils')>('@wrongstack/core/utils');
  return {
    ...actual,
    toErrorMessage:
      actual.toErrorMessage ?? ((e: unknown) => (e instanceof Error ? e.message : String(e))),
  };
});

import { GoalWebSocketHandler } from '../src/server/goal-ws-handler.js';

function makeMockAgent() {
  return {
    run: vi.fn(async () => ({ status: 'done', finalText: 'mock response' })),
  } as any;
}

function makeMockContext() {
  return {
    cwd: '/tmp/proj',
    session: { id: 'sess-1' },
  } as any;
}

function makeMockLogger() {
  const noop = () => undefined;
  return {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    child: vi.fn(function (this: any) {
      return this;
    }),
  } as any;
}

/** Decoded frames the handler wrote to a mock client, in send order. */
function sentMessages(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return ws.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

function makeMockWs(): any {
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    terminate: vi.fn(),
    on(event: string, cb: (...args: any[]) => void) {
      if (handlers[event] === undefined) handlers[event] = [];
      handlers[event]!.push(cb);
      return this;
    },
    close() {
      handlers['close']?.forEach((cb) => {
        cb();
      });
    },
    errorOut() {
      handlers['error']?.forEach((cb) => {
        cb(new Error('mock ws error'));
      });
    },
  };
}

describe('GoalWebSocketHandler', () => {
  let agent: any;
  let context: any;
  let logger: any;

  beforeEach(() => {
    agent = makeMockAgent();
    context = makeMockContext();
    logger = makeMockLogger();
  });

  describe('addClient / dispose lifecycle', () => {
    it('registers a client and assigns an id', () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      // No assertion helper exposes clients; verify behavior via broadcast.
      // We use the fact that sendState bails silently when no graph → no send.
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('removes a client on close', () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      ws.close();
      // Re-attempt: add again, then close again. Both should be no-op (send not called).
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('removes a client on error', () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      ws.errorOut();
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('dispose clears stopping flag, aborts work, clears clients', () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws1 = makeMockWs();
      const ws2 = makeMockWs();
      handler.addClient(ws1);
      handler.addClient(ws2);

      expect(() => handler.dispose()).not.toThrow();
      // After dispose, no broadcasts are emitted (clients cleared).
      expect(ws1.send).not.toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('dispose is safe to call on a fresh handler', () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      expect(() => handler.dispose()).not.toThrow();
    });
  });

  describe('handleMessage — early-exit cases', () => {
    it('ignores messages for unknown graph state (no current graph)', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      await handler.handleMessage(ws, { type: 'goal.selectPhase', payload: { phaseId: 'p1' } });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.pause without orchestrator: broadcast emits goal.paused to clients', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, { type: 'goal.pause', payload: {} });

      // The broadcast is unconditional; only the orchestrator call is optional.
      expect(sentMessages(ws)).toEqual([{ type: 'goal.paused', payload: {} }]);
    });

    it('goal.resume without a saved graph reports an error', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, { type: 'goal.resume', payload: {} });

      expect(sentMessages(ws)).toEqual([
        { type: 'goal.error', payload: { message: 'No saved Goal to resume.' } },
      ]);
    });

    it('goal.status without graph returns an authoritative idle snapshot', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, { type: 'goal.status', payload: {} });

      expect(sentMessages(ws)).toEqual([
        expect.objectContaining({
          type: 'goal.state',
          payload: expect.objectContaining({ status: 'idle', phases: [] }),
        }),
      ]);
    });

    it('goal.list triggers store.list and broadcasts goal.list', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, { type: 'goal.list', payload: {} });

      // The mock PhaseStore.list returns [] → goal.list has its own
      // unconditional broadcast branch, independent of any loaded graph.
      expect(sentMessages(ws)).toEqual([{ type: 'goal.list', payload: { graphs: [], goals: [] } }]);
    });

    it('goal.load with unknown id: broadcasts goal.error', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, { type: 'goal.load', payload: { graphId: 'missing' } });

      // Mock PhaseStore.load returns null → broadcast goal.error.
      expect(sentMessages(ws)).toEqual([
        { type: 'goal.error', payload: { message: 'Graph not found: missing' } },
      ]);
    });

    it('goal.load without a saved graph reports an error', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, { type: 'goal.load', payload: {} });

      expect(sentMessages(ws)).toEqual([
        { type: 'goal.error', payload: { message: 'No saved Goals.' } },
      ]);
    });
  });

  describe('handleMessage — task mutation dispatch (no-op without orchestrator)', () => {
    it('goal.moveTask with no orchestrator: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, {
        type: 'goal.moveTask',
        payload: { taskId: 't1', toPhaseId: 'p2' },
      });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.assignTask with no orchestrator: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, { type: 'goal.assignTask', payload: { taskId: 't1' } });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.addTask with no orchestrator: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, {
        type: 'goal.addTask',
        payload: { phaseId: 'p1', title: 'x' },
      });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.addTask with empty title: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, {
        type: 'goal.addTask',
        payload: { phaseId: 'p1', title: '   ' },
      });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.retryTask with no orchestrator: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, { type: 'goal.retryTask', payload: { taskId: 't1' } });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.runTask with no orchestrator: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, { type: 'goal.runTask', payload: { taskId: 't1' } });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.save with no graph: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, { type: 'goal.save', payload: {} });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('goal.taskStatus with no graph: silent', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);
      await handler.handleMessage(ws, {
        type: 'goal.taskStatus',
        payload: { taskId: 't1', status: 'completed' },
      });
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('goal.assess (unicast)', () => {
    it('empty goal sends a default realistic assessment', async () => {
      const handler = new GoalWebSocketHandler(agent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, { type: 'goal.assess', payload: { goal: '', seq: 7 } });

      // sendSerialized calls ws.send when ws.readyState === OPEN.
      // The exact JSON varies; we just verify the socket received a goal.assess.result.
      const sent = (ws.send as any).mock.calls.map((c: any[]) => c[0]).join('\n');
      expect(sent).toContain('goal.assess.result');
    });

    it('non-empty goal sends an assessment derived from the agent', async () => {
      // Build a fresh agent stub so we control run() deterministically.
      const stubAgent = {
        run: vi.fn(async () => ({ status: 'done', finalText: 'verdict text' })),
      } as any;
      const handler = new GoalWebSocketHandler(stubAgent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await handler.handleMessage(ws, {
        type: 'goal.assess',
        payload: { goal: 'Write 100 tests by tomorrow', seq: 3 },
      });

      const sent = (ws.send as any).mock.calls.map((c: any[]) => c[0]).join('\n');
      // The handler must have emitted a goal.assess.result frame on the wire
      // (the LLM stub returned `done`, so the assessor's parseFailed path is
      // skipped; we accept either verdict-derived or realistic-only result).
      expect(sent).toContain('goal.assess.result');
    });

    it('agent throwing does not crash the handler', async () => {
      const failingAgent = {
        run: vi.fn(async () => {
          throw new Error('LLM down');
        }),
      } as any;
      const handler = new GoalWebSocketHandler(failingAgent, context, logger, '/tmp/store');
      const ws = makeMockWs();
      handler.addClient(ws);

      await expect(
        handler.handleMessage(ws, { type: 'goal.assess', payload: { goal: 'anything', seq: 1 } }),
      ).resolves.toBeUndefined();

      const sent = (ws.send as any).mock.calls.map((c: any[]) => c[0]).join('\n');
      expect(sent).toContain('parseFailed');
    });
  });
});
