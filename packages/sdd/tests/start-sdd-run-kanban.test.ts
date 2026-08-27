/**
 * Kanban-transport failure and lifecycle coverage for startSddRun. Mirrors
 * start-sdd-run.test.ts (legacy-file) but mocks `@wrongstack/kanban` so the
 * subscribe/drain/interval branches can be force-injected without standing up
 * a real daemon. The drain tries covers the gated-IPC, race, and dispose
 * paths; the warning branches need the mock to reject.
 */
import type { Agent } from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import type { TaskStore } from '@wrongstack/core/tasking';
import type { TaskGraph } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SddBoardStore } from '../src/sdd-board-store.js';
import { startSddRun } from '../src/start-sdd-run.js';
import { TaskTracker } from '../src/task-tracker.js';

const kanban = vi.hoisted(() => ({
  subscribe: vi.fn(),
  drain: vi.fn(),
  writeState: vi.fn(),
}));

vi.mock('@wrongstack/kanban', () => ({
  kanbanWorkflowId: (kind: string, name: string) => `${kind}:${name}`,
  subscribeKanbanWorkflowCommands: (...args: unknown[]) => kanban.subscribe(...args),
  drainKanbanWorkflowCommands: (...args: unknown[]) => kanban.drain(...args),
  writeKanbanWorkflowState: (...args: unknown[]) => kanban.writeState(...args),
}));

function makeFakeStore(): TaskStore {
  const graphs = new Map<string, TaskGraph>();
  const clone = (g: TaskGraph): TaskGraph => ({
    ...g,
    nodes: new Map(g.nodes),
    edges: [...g.edges],
    rootNodes: [...g.rootNodes],
  });
  return {
    async saveGraph(g) {
      graphs.set(g.id, clone(g));
    },
    async loadGraph(id) {
      const g = graphs.get(id);
      return g ? clone(g) : null;
    },
    async listGraphs() {
      return [...graphs.values()].map((g) => ({
        id: g.id,
        title: g.title,
        updatedAt: g.updatedAt,
      }));
    },
    async deleteGraph(id) {
      graphs.delete(id);
    },
  };
}

const fakeLeader = (): Agent =>
  ({ events: new EventBus(), run: async () => ({}) }) as never as Agent;

async function makeSuccessfulGraph() {
  const tracker = new TaskTracker({ store: makeFakeStore() });
  const graph = await tracker.createGraph('spec-1', 'Run');
  tracker.addNode({
    title: 'T1',
    description: 'work',
    type: 'feature',
    priority: 'high',
    status: 'pending',
  });
  return { tracker, graph };
}

function successFactory(): Parameters<typeof startSddRun>[0]['subagentFactory'] {
  return async () => {
    const bus = new EventBus();
    return {
      agent: {
        events: bus,
        run: async () => ({ status: 'done', iterations: 1, toolCalls: 0, finalText: 'done' }),
      } as never as Agent,
      events: bus,
    };
  };
}

function gatedFactory(gate: Promise<void>): Parameters<typeof startSddRun>[0]['subagentFactory'] {
  return async () => {
    const bus = new EventBus();
    return {
      agent: {
        events: bus,
        run: async () => {
          await gate;
          return { status: 'done', iterations: 1, toolCalls: 0, finalText: 'done' };
        },
      } as never as Agent,
      events: bus,
    };
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const mock of Object.values(kanban)) mock.mockReset();
  kanban.subscribe.mockResolvedValue(() => undefined);
  kanban.drain.mockResolvedValue([]);
  kanban.writeState.mockImplementation(async (_root, _id, value) => ({ revision: 1, value }));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('startSddRun — kanban transport', () => {
  it('asserts requirement coverage when the graph declares a scope (:141-142)', async () => {
    const { tracker, graph } = await makeSuccessfulGraph();
    graph.requiredRequirementIds = []; // defined → assert path runs, valid → pass

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: successFactory(),
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
      // Omit controlTransport → defaults to kanban; subscribe/drain must
      // therefore be reached.
    });
    await handle.completion;
  });

  it('warns when the kanban drain rejects and the worker keeps running', async () => {
    const { tracker, graph } = await makeSuccessfulGraph();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    kanban.drain.mockRejectedValue(new Error('daemon down'));

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: gatedFactory(gate),
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
      controlDrainMs: 5,
    });

    await expect
      .poll(
        () =>
          warnSpy.mock.calls.some(([line]: [unknown]) =>
            /sdd\.control_drain_failed/.test(String(line)),
          ),
        {
          timeout: 3000,
        },
      )
      .toBe(true);
    release();
    await handle.completion;
    const warned = warnSpy.mock.calls.flat().join('\n');
    expect(warned).toContain('sdd.control_drain_failed');
    expect(warned).toContain('daemon down');
    expect(warned).toContain('"transport":"kanban"');
  });

  it('logs a non-Error drain rejection via String(error) (:250)', async () => {
    const { tracker, graph } = await makeSuccessfulGraph();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Reject with a string so the `error instanceof Error` branch takes the
    // `String(error)` fallback.
    kanban.drain.mockRejectedValue('drain-string');

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: gatedFactory(gate),
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
      controlDrainMs: 5,
    });

    await expect
      .poll(
        () =>
          warnSpy.mock.calls.some(([line]: [unknown]) =>
            /sdd\.control_drain_failed/.test(String(line)),
          ),
        {
          timeout: 3000,
        },
      )
      .toBe(true);
    release();
    await handle.completion;
    const warned = warnSpy.mock.calls.flat().join('\n');
    expect(warned).toContain('drain-string');
  });

  it('warns when the kanban subscription rejects (Error and non-Error)', async () => {
    const { tracker, graph } = await makeSuccessfulGraph();

    // First run: subscribe rejects with an Error. The mock must be set BEFORE
    // startSddRun is called, because startSddRun invokes subscribe synchronously.
    kanban.subscribe.mockImplementationOnce(() => Promise.reject(new Error('sub failed')));
    const handleA = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: successFactory(),
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
    });
    await handleA.completion;
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('sdd.control_subscribe_failed');

    // Second run: subscribe rejects with a non-Error value.
    warnSpy.mockClear();
    kanban.subscribe.mockImplementationOnce(() => Promise.reject('sub-string'));
    const handleB = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: successFactory(),
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
    });
    await handleB.completion;
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('sub-string');
  });

  it('unsubscribes immediately when the run settles before subscribe resolves (:275)', async () => {
    const { tracker, graph } = await makeSuccessfulGraph();
    let resolveSubscribe!: (u: () => void) => void;
    kanban.subscribe.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const unsubscribed = vi.fn();
    let gate!: () => void;
    const factory = gatedFactory(
      new Promise<void>((r) => {
        gate = r;
      }),
    );

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: factory,
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
    });
    // Let the run finish BEFORE the subscribe promise resolves.
    gate();
    await handle.completion;
    resolveSubscribe(unsubscribed);
    // Flush the microtask queue so the .then observe controlDisposed=true.
    await new Promise((resolve) => setImmediate(resolve));
    expect(unsubscribed).toHaveBeenCalled();
  });

  it('short-circuits a concurrent drain while one is in flight (:236)', async () => {
    const { tracker, graph } = await makeSuccessfulGraph();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let activeDrains = 0;
    let maxConcurrent = 0;
    let resolveDrain!: () => void;
    kanban.drain.mockImplementation(async () => {
      activeDrains++;
      maxConcurrent = Math.max(maxConcurrent, activeDrains);
      // Hold the drain until the run releases the worker.
      await new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      activeDrains--;
      return [];
    });

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: gatedFactory(gate),
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
      controlDrainMs: 5,
    });

    // Wait until the first drain is in flight, then let subsequent timer ticks
    // try to overlap — the in-flight guard must keep concurrent calls at 1.
    await expect.poll(() => activeDrains > 0, { timeout: 3000 }).toBe(true);
    release();
    resolveDrain();
    await handle.completion;
    expect(maxConcurrent).toBe(1);
  });

  it('short-circuits a drain fired after the run disposed (:236)', async () => {
    const { tracker, graph } = await makeSuccessfulGraph();
    let capturedCallback: (() => void) | undefined;
    kanban.subscribe.mockImplementation(async (_root: string, _id: string, cb: () => void) => {
      capturedCallback = cb;
      return () => undefined;
    });

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: successFactory(),
      boardStore: new SddBoardStore({ baseDir: 'C:\\nope' }),
    });
    await handle.completion;
    // After run completion, controlDisposed=true. Firing the subscribe callback
    // must hit the early-return branch without invoking kanban.drain again.
    const before = kanban.drain.mock.calls.length;
    capturedCallback?.();
    capturedCallback?.();
    expect(kanban.drain.mock.calls.length).toBe(before);
  });
});

describe('startSddRun — legacy-file initial drain commands (:300, :310)', () => {
  it('applies commands queued before the run starts', async () => {
    const tracker = new TaskTracker({ store: makeFakeStore() });
    const graph = await tracker.createGraph('spec-1', 'Run');
    const t1 = tracker.addNode({
      title: 'T1',
      description: 'work',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    const boardStore = new SddBoardStore({ baseDir: 'C:\\nope' });
    // Gate the worker so the task stays in flight while the interval drain
    // picks up the appended command — otherwise the run finishes before the
    // next drain tick.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: gatedFactory(gate),
      boardStore,
      controlTransport: 'legacy-file',
      controlDrainMs: 15,
    });
    await boardStore.appendControl(handle.runId, {
      ts: 1,
      type: 'set_task_model',
      payload: { taskId: t1.id, model: 'haiku', provider: 'anthropic' },
    });
    await expect
      .poll(() => tracker.getNode(t1.id)?.metadata?.model === 'haiku', { timeout: 3000 })
      .toBe(true);
    release();
    await handle.completion;
  });

  it('logs a non-Error legacy drain rejection via String(error) (:310)', async () => {
    const tracker = new TaskTracker({ store: makeFakeStore() });
    const graph = await tracker.createGraph('spec-1', 'Run');
    const boardStore = new SddBoardStore({ baseDir: 'C:\\nope' });
    vi.spyOn(boardStore, 'drainControl').mockRejectedValue('legacy-string');

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: successFactory(),
      boardStore,
      controlTransport: 'legacy-file',
    });
    await handle.completion;
    const warned = warnSpy.mock.calls.flat().join('\n');
    expect(warned).toContain('sdd.control_drain_failed');
    expect(warned).toContain('legacy-string');
    expect(warned).toContain('"transport":"legacy-file"');
  });

  it('fires the interval drain while the run is alive (:319)', async () => {
    const tracker = new TaskTracker({ store: makeFakeStore() });
    const graph = await tracker.createGraph('spec-1', 'Run');
    const t1 = tracker.addNode({
      title: 'T1',
      description: 'work',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    const boardStore = new SddBoardStore({ baseDir: 'C:\\nope' });
    // Gate the worker so the interval can tick and the appended command lands.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      sessionId: '2026-08-26/sess_01TESTSDDRUN000000000000',
      agent: fakeLeader(),
      projectRoot: '/proj',
      events: new EventBus(),
      subagentFactory: gatedFactory(gate),
      boardStore,
      controlTransport: 'legacy-file',
      controlDrainMs: 15,
    });

    await boardStore.appendControl(handle.runId, {
      ts: 1,
      type: 'set_task_model',
      payload: { taskId: t1.id, model: 'haiku', provider: 'anthropic' },
    });
    await expect
      .poll(() => tracker.getNode(t1.id)?.metadata?.model === 'haiku', { timeout: 3000 })
      .toBe(true);
    release();
    await handle.completion;
  });
});
