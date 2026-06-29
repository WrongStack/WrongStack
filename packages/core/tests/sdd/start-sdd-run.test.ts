import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { startSddRun } from '../../src/sdd/start-sdd-run.js';
import { makeCommandVerifier } from '../../src/sdd/verify-task.js';
import { SddBoardStore } from '../../src/sdd/sdd-board-store.js';
import { SddRunRegistry } from '../../src/sdd/sdd-run-registry.js';
import { TaskTracker } from '../../src/sdd/task-tracker.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Agent } from '../../src/core/agent.js';
import type { AgentFactory } from '../../src/coordination/agent-subagent-runner.js';
import type { TaskGraph, TaskStore } from '../../src/types/task-graph.js';

function tmp(): string {
  return path.join(os.tmpdir(), `start-sdd-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

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
      return [...graphs.values()].map((g) => ({ id: g.id, title: g.title, updatedAt: g.updatedAt }));
    },
    async deleteGraph(id) {
      graphs.delete(id);
    },
  };
}

const fakeLeader = (): Agent => ({ events: new EventBus(), run: async () => ({}) }) as never as Agent;

/** A factory whose agents always succeed (status 'done' → task marked completed). */
function successFactory(calls: { count: number }): AgentFactory {
  return async () => {
    calls.count++;
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

async function makeGraph(nodeCount: number) {
  const tracker = new TaskTracker({ store: makeFakeStore() });
  const graph = await tracker.createGraph('spec-1', 'Run Graph');
  for (let i = 0; i < nodeCount; i++) {
    tracker.addNode({
      title: `T${i + 1}`,
      description: 'work',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    } as never);
  }
  return { tracker, graph };
}

describe('startSddRun (integration — real SddParallelRun + coordinator)', () => {
  it('drives every task to completion via the injected factory', async () => {
    const { tracker, graph } = await makeGraph(3);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });
    const registry = new SddRunRegistry();
    const calls = { count: 0 };

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: successFactory(calls),
      boardStore,
      registry,
    });

    expect(handle.runId).toBeTruthy();
    const result = await handle.completion;

    // Every task ran through a real coordinator + runner and completed.
    expect(result.totalCompleted).toBe(3);
    expect(result.totalFailed).toBe(0);
    expect(result.deadlocked).toBe(false);
    expect(tracker.getAllNodes({ status: ['completed'] })).toHaveLength(3);
    expect(calls.count).toBe(3); // one subagent spawned per task

    // Board snapshot persisted to disk (projector drained in startSddRun's finally).
    const boards = await boardStore.list();
    expect(boards.length).toBe(1);
    expect(boards[0]?.runId).toBe(handle.runId);

    // Registry cleaned up after completion.
    expect(registry.getActive()).toBeNull();
  });

  it('drains set_task_model / cancel_task / delete_task control commands into the live run', async () => {
    const { tracker, graph } = await makeGraph(4); // t1..t4, in creation order
    const [t1, t2, t3, t4] = tracker
      .getAllNodes()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.id) as [string, string, string, string];
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    // Gate the worker so t1 stays running (slots=1) while we inject control on
    // the still-pending t2/t3/t4 — exercising the cross-process control channel.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory: AgentFactory = async () => {
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

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: factory,
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    await boardStore.appendControl(handle.runId, {
      ts: 1,
      type: 'set_task_model',
      payload: { taskId: t2, model: 'claude-haiku-4-5', provider: 'anthropic' },
    });
    await boardStore.appendControl(handle.runId, {
      ts: 2,
      type: 'set_task_verification',
      payload: { taskId: t2, verificationCommand: 'pnpm vitest run t2' },
    });
    await boardStore.appendControl(handle.runId, { ts: 3, type: 'cancel_task', payload: { taskId: t3 } });
    await boardStore.appendControl(handle.runId, { ts: 4, type: 'delete_task', payload: { taskId: t4 } });

    // Wait for the drain to apply (poll, no fixed sleep) — t4 removal is the marker.
    await expect.poll(() => tracker.getNode(t4) === undefined, { timeout: 3000 }).toBe(true);
    expect(tracker.getNode(t2)?.metadata?.model).toBe('claude-haiku-4-5');
    expect(tracker.getNode(t2)?.metadata?.provider).toBe('anthropic');
    expect(tracker.getNode(t2)?.metadata?.verificationCommand).toBe('pnpm vitest run t2');
    expect(tracker.getNode(t3)?.status).toBe('failed');
    expect(tracker.getNode(t3)?.metadata?.cancelled).toBe(true);

    release();
    const result = await handle.completion;
    // t1 + t2 complete; t3 cancelled (terminal, not retried); t4 deleted.
    expect(tracker.getNode(t1)?.status).toBe('completed');
    expect(tracker.getNode(t2)?.status).toBe('completed');
    expect(result.totalCompleted).toBe(2);
  });

  it('drains a retry_all_failed control command into the live run', async () => {
    const { tracker, graph } = await makeGraph(2);
    const [t1, t2] = tracker
      .getAllNodes()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.id) as [string, string];
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    // Gate the worker so t1 stays in-flight (slots=1) while we mark t2 failed and
    // inject retry_all_failed over the cross-process control channel.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const factory: AgentFactory = async () => {
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

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: factory,
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    await expect.poll(() => tracker.getNode(t1)?.status === 'in_progress', { timeout: 3000 }).toBe(true);
    tracker.updateNodeStatus(t2, 'failed', 'boom');
    await boardStore.appendControl(handle.runId, { ts: 1, type: 'retry_all_failed' });

    // The drain calls run.retryAllFailed() → t2 returns to pending.
    await expect.poll(() => tracker.getNode(t2)?.status === 'pending', { timeout: 3000 }).toBe(true);

    release();
    const result = await handle.completion;
    expect(tracker.getNode(t1)?.status).toBe('completed');
    expect(tracker.getNode(t2)?.status).toBe('completed');
    expect(result.totalCompleted).toBe(2);
  });

  it('keeps a task out of completed when the shared verifyTask gate fails', async () => {
    // A worker that "succeeds" but whose verificationCommand exits non-zero must
    // NOT be allowed to complete — the completion gate is the production wiring
    // shared by the CLI + standalone WebUI (makeCommandVerifier).
    const tracker = new TaskTracker({ store: makeFakeStore() });
    const graph = await tracker.createGraph('spec-1', 'Gated Graph');
    tracker.addNode({
      title: 'T1',
      description: 'work',
      type: 'feature',
      priority: 'high',
      status: 'pending',
      metadata: { verificationCommand: 'exit 1' },
    } as never);

    const events = new EventBus();
    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      // Real, existing cwd so the verifier's child process can chdir + run.
      projectRoot: os.tmpdir(),
      events,
      subagentFactory: successFactory({ count: 0 }),
      boardStore: new SddBoardStore({ baseDir: tmp() }),
      verifyTask: makeCommandVerifier(),
    });

    const result = await handle.completion;
    expect(result.totalCompleted).toBe(0);
    expect(tracker.getAllNodes({ status: ['completed'] })).toHaveLength(0);
    expect(tracker.getNode([...graph.nodes.keys()][0]!)?.status).not.toBe('completed');
  });

  it('emits sdd.run.started / finished on the shared bus', async () => {
    const { tracker, graph } = await makeGraph(1);
    const events = new EventBus();
    const seen: string[] = [];
    const sessionIds: Array<string | undefined> = [];
    events.on('sdd.run.started', (event) => {
      seen.push('started');
      sessionIds.push(event.sessionId);
    });
    events.on('sdd.run.finished', (event) => {
      seen.push('finished');
      sessionIds.push(event.sessionId);
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      sessionId: () => '2026-06-29/sess_sdd',
      subagentFactory: successFactory({ count: 0 }),
      boardStore: new SddBoardStore({ baseDir: tmp() }),
    });
    await handle.completion;
    expect(seen).toContain('started');
    expect(seen).toContain('finished');
    expect(sessionIds).toEqual(['2026-06-29/sess_sdd', '2026-06-29/sess_sdd']);
  });
});
