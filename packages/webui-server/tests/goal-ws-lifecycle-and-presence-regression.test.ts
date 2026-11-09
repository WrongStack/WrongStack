import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { broadcastGoalCatalog, routeToSelectedGoal } from '../src/server/goal-ws-goal-routing.js';
import type { GoalWsHandlerInternals } from '../src/server/goal-ws-handler-internals.js';
import { attachGoalClient, disposeGoalHandler } from '../src/server/goal-ws-handler-lifecycle.js';

function createFakeHost(
  loadImpl?: (id: string) => Promise<unknown>,
  goalId?: string,
): GoalWsHandlerInternals {
  const unexpected = (): never => {
    throw new Error('Unexpected Goal execution in lifecycle-only fixture');
  };
  const host: GoalWsHandlerInternals = {
    goals: new Map(),
    selections: new WeakMap(),
    catalogTimer: null,
    catalogInFlight: false,
    readOnly: false,
    stopGeneration: 0,
    orchestrator: null,
    runPromise: null,
    setupPromise: null,
    disposed: false,
    graph: null,
    store: {
      load: loadImpl ?? (async () => null),
      list: async () => [],
      listGoals: async () => [],
      goalRunOwner: async () => null,
    } as never,
    persistence: {
      save: async () => undefined,
    } as never,
    clients: new Set(),
    broadcastInterval: null,
    lastGraphFingerprint: '',
    lastProgressJson: '',
    abort: null,
    assessAbort: null,
    assessSeq: 0,
    stopping: false,
    worktrees: null,
    runBase: null,
    usedNicknames: new Set(),
    startInFlight: false,
    runStatus: 'idle',
    releaseRunLease: null,
    agent: {} as never,
    context: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as never,
    events: undefined,
    projectRoot: undefined,
    onBoardState: undefined,
    taskAgentFactory: (() => ({})) as never,
    goalId,
    priceUsage: undefined,
    addClient(ws: WebSocket) {
      attachGoalClient(host, ws);
    },
    dispose() {
      disposeGoalHandler(host);
    },
    handleMessage: async () => undefined,
    broadcastCatalog: async () => undefined,
    sendState: () => undefined,
    broadcast: () => undefined,
    stopBroadcast: () => undefined,
    releaseActiveRunLease: async () => undefined,
    startRun: unexpected,
    broadcastState: unexpected,
    handleStop: unexpected,
    buildState: unexpected,
    handleAssess: unexpected,
    handleStart: unexpected,
    handleResumeGraph: unexpected,
    handleClear: unexpected,
    handleRevert: unexpected,
    planPhases: unexpected,
    executeTaskWithAgent: unexpected,
    runRepairPhase: unexpected,
    runChimeraReview: unexpected,
    persistDetached: unexpected,
    afterBoardMutation: unexpected,
    startBroadcast: unexpected,
  };
  return host;
}

function createFakeSocket(readyState = 1): WebSocket {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    readyState,
    on(event: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return this;
    },
    removeListener(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return this;
    },
  } as unknown as WebSocket;
}

describe('F70 GoalWebSocketHandler lifecycle and routing leak regressions', () => {
  it('deduplicates repeated addClient(ws) calls and ignores disposed hosts or closed sockets', () => {
    const host = createFakeHost();
    const ws = createFakeSocket(1);
    attachGoalClient(host, ws);
    attachGoalClient(host, ws);
    expect(host.clients.size).toBe(1);

    attachGoalClient(host, createFakeSocket(2));
    attachGoalClient(host, createFakeSocket(3));
    expect(host.clients.size).toBe(1);

    disposeGoalHandler(host);
    attachGoalClient(host, ws);
    expect(host.clients.size).toBe(0);
    expect(host.catalogTimer).toBeNull();
  });

  it('cleans up the newly created goal entry when store.load rejects on goal.start and skips catalog broadcast when disposed', async () => {
    let childDisposed = false;
    const host = createFakeHost(async () => {
      throw new Error('disk IO failure during store.load');
    });
    const ws = createFakeSocket(1);

    await expect(
      routeToSelectedGoal(
        host,
        ws,
        { type: 'goal.start', payload: { goalId: 'goal-1', title: 'Test' } },
        (goalId) => {
          const child = createFakeHost(undefined, goalId);
          child.dispose = () => {
            childDisposed = true;
            disposeGoalHandler(child);
          };
          return child;
        },
      ),
    ).rejects.toThrow('disk IO failure during store.load');

    expect(host.goals.size).toBe(0);
    expect(childDisposed).toBe(true);

    let broadcastedAfterDispose = false;
    const catalogHost = createFakeHost();
    catalogHost.store = {
      ...catalogHost.store,
      list: async () => {
        disposeGoalHandler(catalogHost);
        return [];
      },
      listGoals: async () => [],
    } as never;
    catalogHost.broadcast = () => {
      broadcastedAfterDispose = true;
    };
    await broadcastGoalCatalog(catalogHost);
    expect(broadcastedAfterDispose).toBe(false);
  });
});
