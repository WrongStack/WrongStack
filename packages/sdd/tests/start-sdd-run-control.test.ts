import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentFactory } from '@wrongstack/core/coordination/agent-subagent-runner.js';
import { EventBus } from '@wrongstack/core/kernel/events.js';
import type { TaskGraph, TaskStore } from '@wrongstack/core/types/task-graph.js';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/core/agent.js';
import { SddBoardStore } from '../src/sdd-board-store.js';
import type { SddParallelRun } from '../src/sdd-parallel-run.js';
import { applySddControlCommand, startSddRun } from '../src/start-sdd-run.js';
import { TaskTracker } from '../src/task-tracker.js';

function tmp(): string {
  return path.join(os.tmpdir(), `sdd-ctrl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

async function makeGraph(nodeCount: number) {
  const tracker = new TaskTracker({ store: makeFakeStore() });
  const graph = await tracker.createGraph('spec-ctrl', 'Control Graph');
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

/** A factory whose agent blocks on a gate until released — lets us inject control commands mid-run. */
function gatedFactory(gate: Promise<void>): AgentFactory {
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

describe('startSddRun — control-drain branches', () => {
  it('applies every control command and safely ignores incomplete commands', async () => {
    const run = {
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      retryTask: vi.fn(),
      retryAllFailed: vi.fn(),
      reassignTask: vi.fn(),
      setTaskModel: vi.fn(),
      setTaskFallbacks: vi.fn(),
      setTaskVerification: vi.fn(),
      cancelTask: vi.fn().mockRejectedValue(new Error('cancel failed')),
      deleteTask: vi.fn(),
      splitTask: vi.fn(),
      cleanupWorktrees: vi.fn().mockRejectedValue(new Error('cleanup failed')),
      rollback: vi.fn().mockRejectedValue(new Error('rollback failed')),
    } as unknown as SddParallelRun;

    applySddControlCommand(run, { type: 'pause' });
    applySddControlCommand(run, { type: 'resume' });
    applySddControlCommand(run, { type: 'stop' });
    applySddControlCommand(run, { type: 'retry' });
    applySddControlCommand(run, { type: 'retry', payload: { taskId: 't1' } });
    applySddControlCommand(run, { type: 'retry_all_failed' });
    applySddControlCommand(run, { type: 'reassign' });
    applySddControlCommand(run, { type: 'reassign', payload: { taskId: 't1' } });
    applySddControlCommand(run, {
      type: 'reassign',
      payload: { taskId: 't2', agentName: 'agent-2' },
    });
    applySddControlCommand(run, { type: 'set_task_model' });
    applySddControlCommand(run, {
      type: 'set_task_model',
      payload: { taskId: 't1', model: 'model', provider: 'provider' },
    });
    applySddControlCommand(run, { type: 'set_task_fallbacks' });
    applySddControlCommand(run, {
      type: 'set_task_fallbacks',
      payload: { taskId: 't1', fallbackModels: ['fallback'] },
    });
    applySddControlCommand(run, { type: 'set_task_verification' });
    applySddControlCommand(run, {
      type: 'set_task_verification',
      payload: { taskId: 't1', verificationCommand: 'pnpm test' },
    });
    applySddControlCommand(run, { type: 'cancel_task' });
    applySddControlCommand(run, { type: 'cancel_task', payload: { taskId: 't1' } });
    applySddControlCommand(run, { type: 'delete_task' });
    applySddControlCommand(run, { type: 'delete_task', payload: { taskId: 't1' } });
    applySddControlCommand(run, { type: 'split_task' });
    applySddControlCommand(run, { type: 'split_task', payload: { taskId: 't1' } });
    applySddControlCommand(run, {
      type: 'split_task',
      payload: { taskId: 't1', subtasks: [] },
    });
    applySddControlCommand(run, {
      type: 'split_task',
      payload: { taskId: 't1', subtasks: [{ title: 'child', description: 'work' }] },
    });
    applySddControlCommand(run, { type: 'cleanup_worktrees' });
    applySddControlCommand(run, { type: 'rollback' });
    applySddControlCommand(run, { type: 'unknown' });
    await Promise.resolve();

    expect(run.pause).toHaveBeenCalledOnce();
    expect(run.reassignTask).toHaveBeenCalledWith('t1', '');
    expect(run.reassignTask).toHaveBeenCalledWith('t2', 'agent-2');
    expect(run.splitTask).toHaveBeenCalledOnce();
  });

  it('drains pause/resume control commands', async () => {
    const { tracker, graph } = await makeGraph(2);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    // Wait for t1 to be running
    const t1 = tracker.getAllNodes().sort((a, b) => a.createdAt - b.createdAt)[0]!;
    await expect
      .poll(() => tracker.getNode(t1.id)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    // Inject pause then resume
    await boardStore.appendControl(handle.runId, { ts: 1, type: 'pause' });
    await boardStore.appendControl(handle.runId, { ts: 2, type: 'resume' });

    // The run should accept these without crashing (pause/resume toggle internal state)
    release();
    const result = await handle.completion;
    expect(result.totalCompleted).toBeGreaterThanOrEqual(1);
  });

  it('drains stop control command', async () => {
    const { tracker, graph } = await makeGraph(3);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    const t1 = tracker.getAllNodes().sort((a, b) => a.createdAt - b.createdAt)[0]!;
    await expect
      .poll(() => tracker.getNode(t1.id)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    await boardStore.appendControl(handle.runId, { ts: 1, type: 'stop' });

    // stop() sets the run's internal stopped flag; the run is no longer running
    release();
    await handle.completion;
    expect(handle.run.isRunning()).toBe(false);
  });

  it('drains retry (single task) control command', async () => {
    const { tracker, graph } = await makeGraph(2);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    const [t1, t2] = tracker
      .getAllNodes()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.id) as [string, string];

    await expect
      .poll(() => tracker.getNode(t1)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    // Mark t2 as failed, then retry it via control channel
    tracker.updateNodeStatus(t2, 'failed', 'test failure');
    await boardStore.appendControl(handle.runId, { ts: 1, type: 'retry', payload: { taskId: t2 } });

    // The drain calls run.retryTask(t2) → t2 returns to pending
    await expect
      .poll(() => tracker.getNode(t2)?.status === 'pending', { timeout: 3000 })
      .toBe(true);

    release();
    const result = await handle.completion;
    expect(tracker.getNode(t2)?.status).toBe('completed');
    expect(result.totalCompleted).toBe(2);
  });

  it('drains reassign control command', async () => {
    const { tracker, graph } = await makeGraph(2);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    const [t1, t2] = tracker
      .getAllNodes()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.id) as [string, string];

    await expect
      .poll(() => tracker.getNode(t1)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    // Reassign t2 to a different agent (sets assignee field, not assignedAgent)
    await boardStore.appendControl(handle.runId, {
      ts: 1,
      type: 'reassign',
      payload: { taskId: t2, agentName: 'bug-hunter' },
    });

    // reassign sets the node's assignee field
    await expect
      .poll(() => tracker.getNode(t2)?.assignee === 'bug-hunter', { timeout: 3000 })
      .toBe(true);

    release();
    await handle.completion;
  });

  it('drains set_task_fallbacks control command', async () => {
    const { tracker, graph } = await makeGraph(2);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    const [t1, t2] = tracker
      .getAllNodes()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.id) as [string, string];

    await expect
      .poll(() => tracker.getNode(t1)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    const fallbacks = ['anthropic/claude-haiku', 'openai/gpt-4o-mini'];
    await boardStore.appendControl(handle.runId, {
      ts: 1,
      type: 'set_task_fallbacks',
      payload: { taskId: t2, fallbackModels: fallbacks },
    });

    await expect
      .poll(() => tracker.getNode(t2)?.metadata?.fallbackModels, { timeout: 3000 })
      .toEqual(fallbacks);

    release();
    await handle.completion;
  });

  it('drains split_task control command', async () => {
    // Give t2 a dependency on t1 so it can't enter the single slot
    // while t1 holds the gate — this prevents the race where the scheduler
    // advances t2 to in_progress before split_task drains (splitTask refuses
    // in-progress tasks).
    const { tracker, graph } = await makeGraph(2);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const [t1, t2] = tracker
      .getAllNodes()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((n) => n.id) as [string, string];

    // Make t2 depend on t1 so it stays pending while t1 is in-flight
    tracker.addDependency(t1, t2);

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    await expect
      .poll(() => tracker.getNode(t1)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    // Split t2 into two subtasks — t2 is guaranteed pending (blocked by t1)
    await boardStore.appendControl(handle.runId, {
      ts: 1,
      type: 'split_task',
      payload: {
        taskId: t2,
        subtasks: [
          { title: 'Subtask A', description: 'Part A' },
          { title: 'Subtask B', description: 'Part B' },
        ],
      },
    });

    // splitTask marks the parent as completed and adds children as pending leaves
    await expect
      .poll(() => tracker.getNode(t2)?.status === 'completed', { timeout: 3000 })
      .toBe(true);

    release();
    await handle.completion;
  });

  it('drains cleanup_worktrees control command (no-op without worktrees)', async () => {
    const { tracker, graph } = await makeGraph(1);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    const t1 = tracker.getAllNodes()[0]!;
    await expect
      .poll(() => tracker.getNode(t1.id)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    // cleanup_worktrees is a no-op when no worktree manager is configured
    await boardStore.appendControl(handle.runId, { ts: 1, type: 'cleanup_worktrees' });

    release();
    const result = await handle.completion;
    expect(result.totalCompleted).toBeGreaterThanOrEqual(1);
  });

  it('drains rollback control command (no-op without commits)', async () => {
    const { tracker, graph } = await makeGraph(1);
    const events = new EventBus();
    const boardStore = new SddBoardStore({ baseDir: tmp() });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const handle = startSddRun({
      tracker,
      graph,
      agent: fakeLeader(),
      projectRoot: '/proj',
      events,
      subagentFactory: gatedFactory(gate),
      boardStore,
      parallelSlots: 1,
      controlDrainMs: 15,
    });

    const t1 = tracker.getAllNodes()[0]!;
    await expect
      .poll(() => tracker.getNode(t1.id)?.status === 'in_progress', { timeout: 3000 })
      .toBe(true);

    // rollback is a no-op when no commits have been made
    await boardStore.appendControl(handle.runId, { ts: 1, type: 'rollback' });

    release();
    const result = await handle.completion;
    expect(result.totalCompleted).toBeGreaterThanOrEqual(1);
  });
});
