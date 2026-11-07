import { describe, expect, it } from 'vitest';
import { splitGraphNode } from '../src/graph-split.js';
import {
  deleteTask,
  retryTask,
  type SddParallelControlsHost,
} from '../src/sdd-parallel-controls.js';

describe('retryTask status and active subagent guard', () => {
  it('allows retrying failed or blocked tasks while refusing in_progress, completed, or active-subagent tasks', () => {
    const nodes = new Map<string, { status: string; metadata: Record<string, unknown> }>([
      ['failed-1', { status: 'failed', metadata: { cancelled: true } }],
      ['blocked-1', { status: 'blocked', metadata: {} }],
      ['running-1', { status: 'in_progress', metadata: {} }],
      ['done-1', { status: 'completed', metadata: {} }],
      ['pending-active', { status: 'pending', metadata: {} }],
    ]);

    const retryMap = new Map<string, number>([
      ['failed-1', 2],
      ['running-1', 1],
    ]);
    const cancelledTasks = new Set<string>(['failed-1']);
    const taskSubagents = new Map<string, string>([['pending-active', 'sub-1']]);

    const host = {
      opts: {
        tracker: {
          getNode: (id: string) => nodes.get(id) as never,
          patchMetadata: (id: string, patch: Record<string, unknown>) => {
            const n = nodes.get(id);
            if (n) Object.assign(n.metadata, patch);
          },
          updateNodeStatus: (id: string, status: string) => {
            const n = nodes.get(id);
            if (n) n.status = status;
          },
          updateNode: () => {},
        } as never,
        worktrees: undefined,
      } as never,
      retryMap,
      cancelledTasks,
      taskSubagents,
      mergedCommits: [],
      baseBranch: undefined,
      isRunning: () => true,
      persistRetries: () => {},
    } as unknown as SddParallelControlsHost;

    expect(retryTask(host, 'failed-1')).toBe(true);
    expect(nodes.get('failed-1')?.status).toBe('pending');
    expect(cancelledTasks.has('failed-1')).toBe(false);

    expect(retryTask(host, 'blocked-1')).toBe(true);
    expect(nodes.get('blocked-1')?.status).toBe('pending');

    expect(retryTask(host, 'running-1')).toBe(false);
    expect(nodes.get('running-1')?.status).toBe('in_progress');
    expect(retryMap.get('running-1')).toBe(1);

    expect(retryTask(host, 'done-1')).toBe(false);
    expect(nodes.get('done-1')?.status).toBe('completed');

    expect(retryTask(host, 'pending-active')).toBe(false);
    expect(retryTask(host, 'missing')).toBe(false);
  });

  it('refuses deleteTask and splitGraphNode on terminal completed tasks', () => {
    const nodes = new Map<string, { status: string; metadata: Record<string, unknown> }>([
      ['done-1', { status: 'completed', metadata: {} }],
      ['failed-1', { status: 'failed', metadata: {} }],
    ]);
    const tracker = {
      getNode: (id: string) => nodes.get(id) as never,
      removeNode: (id: string) => nodes.delete(id),
    };
    const host = {
      opts: { tracker } as never,
      retryMap: new Map<string, number>(),
      cancelledTasks: new Set<string>(),
      taskSubagents: new Map<string, string>(),
    } as unknown as SddParallelControlsHost;

    expect(deleteTask(host, 'done-1')).toBe(false);
    expect(nodes.has('done-1')).toBe(true);
    expect(
      splitGraphNode(tracker as never, 'done-1', [{ title: 'Sub', description: 'd' }]),
    ).toEqual([]);

    expect(deleteTask(host, 'failed-1')).toBe(true);
    expect(nodes.has('failed-1')).toBe(false);
  });

  it('releases worktree when executeSddTask fails during spawn or integrateTaskWorktree throws (F673)', async () => {
    const { TaskTracker } = await import('@wrongstack/core/tasking');
    const { executeSddTask } = await import('../src/sdd-task-execution.js');
    const { allocateTaskWorktrees, integrateTaskWorktree, resolveTaskWorktrees } = await import(
      '../src/sdd-worktree-integration.js'
    );

    const released: string[] = [];
    const emitted: string[] = [];
    const tracker = new TaskTracker({
      store: { saveGraph: async () => {}, loadGraph: async () => null } as never,
    });
    const graph = await tracker.createGraph('spec-f673', 'Graph F673');
    const task = tracker.addNode({
      title: 'Task F673',
      description: 'Desc',
      type: 'feature',
      priority: 'medium',
      status: 'pending',
    });
    const state = {
      taskCwds: new Map<string, string>(),
      taskBranches: new Map<string, string>(),
      taskWorktrees: new Map(),
      mergedCommits: [] as Array<{ taskId: string; sha: string; title: string }>,
    };
    const wt = {
      allocate: async (id: string) => ({
        id,
        dir: `/tmp/${id}`,
        branch: `sdd/${id}`,
        baseBranch: 'main',
        status: 'active' as const,
        createdAt: Date.now(),
      }),
      commitAll: async () => {
        throw new Error('git index.lock contention');
      },
      release: async (h: { id: string }) => {
        released.push(h.id);
      },
    };
    const opts = { tracker, graph, projectRoot: '/tmp', worktrees: wt as never } as never;

    await expect(
      executeSddTask({
        task,
        opts,
        coordinator: { spawn: async () => ({ subagentId: '' }) } as never,
        usedNicknames: new Set(),
        idleTimeoutMs: 1000,
        timeoutMs: undefined,
        runId: 'run-f673',
        nextSubagentId: () => 'sub-1',
        emit: () => {},
        taskCwds: state.taskCwds,
        taskBranches: state.taskBranches,
        taskSubagents: new Map(),
        cancelledTasks: new Set(),
        allocateWorktrees: (tasks) => allocateTaskWorktrees(opts, state, tasks),
        resolveWorktrees: (tasks) => resolveTaskWorktrees(opts, state, tasks),
        integrateWorktree: () => Promise.resolve({ ok: true }),
        applyTaskFailure: async () => {},
      }),
    ).rejects.toThrow();
    expect(released).toContain(`sdd-${task.id}`);
    expect(state.taskWorktrees.has(task.id)).toBe(false);

    released.length = 0;
    await executeSddTask({
      task,
      opts,
      coordinator: {
        spawn: async () => ({ subagentId: 'sub-2' }),
        assign: async () => {},
        awaitTasks: async () => [
          {
            subagentId: 'sub-2',
            taskId: 'corr-2',
            status: 'success',
            iterations: 1,
            toolCalls: 1,
            durationMs: 10,
          },
        ],
      } as never,
      usedNicknames: new Set(),
      idleTimeoutMs: 1000,
      timeoutMs: undefined,
      runId: 'run-f673',
      nextSubagentId: () => 'sub-2',
      emit: (ev) => {
        emitted.push(ev);
      },
      taskCwds: state.taskCwds,
      taskBranches: state.taskBranches,
      taskSubagents: new Map(),
      cancelledTasks: new Set(),
      allocateWorktrees: (tasks) => allocateTaskWorktrees(opts, state, tasks),
      resolveWorktrees: (tasks) => resolveTaskWorktrees(opts, state, tasks),
      integrateWorktree: (taskNode, result) =>
        integrateTaskWorktree({
          opts,
          state,
          task: taskNode,
          result,
          runId: 'run-f673',
          emit: () => {},
          abortRun: () => {},
        }),
      applyTaskFailure: async () => {},
    });
    expect(released).toContain(`sdd-${task.id}`);
    expect(state.taskWorktrees.has(task.id)).toBe(false);
  });

  it('honours cancelTask during verifyTask/superviseFailure without merging or retrying, and clears cancelled metadata on splitTask (F57)', async () => {
    const { EventBus } = await import('@wrongstack/contracts/kernel/events');
    const { DefaultTaskStore, TaskTracker } = await import('@wrongstack/core/tasking');
    const { buildBoardTasks } = await import('../src/board-types.js');
    const { SddParallelRun } = await import('../src/sdd-parallel-run.js');

    const store = new DefaultTaskStore();
    const tracker = new TaskTracker({ store });
    const graph = await tracker.createGraph('spec-f57', 'Graph F57');
    const tPass = tracker.addNode({
      title: 'Pass Cancel',
      description: 'desc',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });
    const tFail = tracker.addNode({
      title: 'Fail Cancel',
      description: 'desc',
      type: 'feature',
      priority: 'high',
      status: 'pending',
    });

    let mergedCount = 0;
    let runRef!: InstanceType<typeof SddParallelRun>;
    runRef = new SddParallelRun({
      tracker,
      graph,
      agent: { events: new EventBus() } as never,
      projectRoot: process.cwd(),
      sessionId: 'sess-f57',
      maxRetries: 1,
      worktrees: {
        allocate: async (ownerId: string) => ({
          id: ownerId,
          ownerId,
          status: 'active',
          dir: `/wt/${ownerId}`,
          branch: `b-${ownerId}`,
          baseBranch: 'main',
        }),
        commitAll: async () => {},
        baseHead: async () => 'SHA1',
        merge: async () => {
          mergedCount++;
          return { ok: true };
        },
        release: async () => {},
      } as never,
      verifyTask: async ({ task }) => {
        await runRef.cancelTask(task.id);
        return task.id === tFail.id ? { ok: false, reason: 'gate failed' } : { ok: true };
      },
    });

    (runRef as never as { coordinator: unknown }).coordinator = {
      spawn: async (c: { id: string }) => ({ subagentId: c.id }),
      assign: async () => {},
      awaitTasks: async (ids: string[]) =>
        ids.map((taskId) => ({
          subagentId: 's',
          taskId,
          status: 'success',
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        })),
      stop: async () => {},
      stopAll: () => {},
    };

    await runRef.executeWave({
      wave: 0,
      tasks: [tPass, tFail],
      deadlocked: false,
      allDone: false,
    } as never);

    expect(mergedCount).toBe(0);
    expect(tracker.getNode(tPass.id)?.status).toBe('failed');
    expect(tracker.getNode(tFail.id)?.status).toBe('failed');

    const leafIds = runRef.splitTask(tPass.id, [
      { title: 'Sub 1', description: 'd1' },
      { title: 'Sub 2', description: 'd2' },
    ]);
    expect(leafIds).toHaveLength(2);
    const parentBoardTask = buildBoardTasks(graph).tasks.find((t) => t.id === tPass.id);
    expect(parentBoardTask?.status).toBe('completed');
    expect(parentBoardTask?.displayStatus).toBe('completed');
  });

  it('flushes pending throttled snapshots and awaits appendEvent writes in SddBoardProjector.drain, and ignores post-dispose control drains (F58)', async () => {
    const { EventBus } = await import('@wrongstack/contracts/kernel/events');
    const { DefaultTaskStore, TaskTracker } = await import('@wrongstack/core/tasking');
    const { SddBoardProjector } = await import('../src/sdd-board-projector.js');
    const { startSddRun } = await import('../src/start-sdd-run.js');

    const store = new DefaultTaskStore();
    const tracker = new TaskTracker({ store });
    const graph = await tracker.createGraph('spec-f58', 'Graph F58');
    const events = new EventBus();
    const savedStatuses: string[] = [];
    const appendedTypes: string[] = [];

    const projector = new SddBoardProjector({
      runId: 'run-f58',
      graph,
      tracker,
      events,
      throttleMs: 50,
      store: {
        saveSnapshot: async (snap) => {
          await new Promise((r) => setTimeout(r, 5));
          savedStatuses.push(snap.status);
        },
        appendEvent: async (_runId, ev) => {
          await new Promise((r) => setTimeout(r, 15));
          appendedTypes.push(ev.type);
        },
      },
    });

    events.emit('sdd.run.started', {
      sessionId: 'sess-f58',
      runId: 'run-f58',
      graphId: graph.id,
      specId: 'spec-f58',
      total: 0,
    });

    await projector.drain();
    projector.dispose();

    expect(savedStatuses).toContain('running');
    expect(appendedTypes).toContain('sdd.run.started');

    let releaseDrain!: (cmds: Array<{ ts: number; type: string }>) => void;
    const handle = startSddRun({
      tracker,
      graph,
      agent: { events: new EventBus() } as never,
      projectRoot: process.cwd(),
      sessionId: 'sess-f58',
      events: new EventBus(),
      boardStore: {
        saveSnapshot: async () => {},
        appendEvent: async () => {},
        drainControl: () =>
          new Promise<Array<{ ts: number; type: string }>>((resolve) => {
            releaseDrain = resolve;
          }),
      } as never,
      controlTransport: 'legacy-file',
      boardStateTransport: 'legacy-file',
      controlDrainMs: 5,
    });

    await handle.completion;
    releaseDrain([{ ts: Date.now(), type: 'pause' }]);
    await new Promise((r) => setTimeout(r, 15));
    expect(handle.run.isPaused()).toBe(false);
  });
});
