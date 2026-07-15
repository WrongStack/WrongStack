import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  makeKanbanQueueTool,
  type SubagentConfig,
  serializeTaskGraph,
  type TaskGraph,
  type TaskResult,
  type TaskSpec,
} from '@wrongstack/core';
import {
  addDependency,
  addGoalMetricToTask,
  addTask,
  assignTask,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  duplicateBoard,
  exportBoardToTaskGraph,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanPath,
  getTaskChain,
  heartbeatTaskAssignment,
  type KanbanBoard,
  listKanbanEvents,
  listReadyTasks,
  mergeTasks,
  moveTask,
  readBoard,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeBoard,
  searchKanban,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transferTaskToBoard,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { kanbanTool } from '../../tools/src/kanban.js';
import type { WsServerMessage } from '../src/webui-server/ws-handlers/index.js';
import { handleKanbanMessage, type KanbanContext } from '../src/webui-server/ws-handlers/kanban.js';

const FAKE_WS = {} as WebSocket;

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

function wsRig(): { ctx: KanbanContext; sent: WsServerMessage[] } {
  const sent: WsServerMessage[] = [];
  return {
    sent,
    ctx: {
      projectRoot: tmpDir,
      send: (_ws, msg) => sent.push(msg),
      broadcast: () => {},
      log: () => {},
    },
  };
}

function lastPayload<T>(sent: WsServerMessage[], type: string): T {
  return sent.filter((msg) => msg.type === type).at(-1)?.payload as T;
}

describe('kanban storage and manager', () => {
  it('creates boards and resolves unique short board ids', async () => {
    const board = await createBoard(tmpDir, { title: 'Ship kanban MVP' });
    const shortId = board.id.slice(0, 8);

    const loaded = await getBoard(tmpDir, shortId);
    expect(loaded?.id).toBe(board.id);

    const added = await addTask(tmpDir, shortId, {
      title: 'Wire slash command',
      columnId: 'backlog',
    });
    expect(added?.task.title).toBe('Wire slash command');

    const moved = await moveTask(tmpDir, shortId, added!.task.id, 'in-progress');
    expect(moved?.tasks.find((task) => task.id === added!.task.id)?.columnId).toBe('in-progress');

    await expect(fs.stat(getKanbanPath(tmpDir, board.id))).resolves.toBeDefined();
    await expect(removeBoard(tmpDir, shortId)).resolves.toBe(true);
    await expect(getBoard(tmpDir, board.id)).resolves.toBeNull();
  });

  it('rejects board ids that would escape the kanban directory', async () => {
    await expect(readBoard(tmpDir, '../escape')).rejects.toThrow('Invalid kanban board id');
    await expect(() => getKanbanPath(tmpDir, '..\\escape')).toThrow('Invalid kanban board id');
  });

  it('supports multiple boards, board duplication, and cross-board task copy/transfer', async () => {
    const source = await createBoard(tmpDir, { title: 'Backend board' });
    const target = await createBoard(tmpDir, { title: 'Frontend board' });
    const added = await addTask(tmpDir, source.id, {
      title: 'Implement websocket route',
      labels: ['api'],
      assignedAgent: 'api-agent',
    });
    expect(added).toBeTruthy();

    const duplicate = await duplicateBoard(tmpDir, source.id, { title: 'Backend board clone' });
    expect(duplicate?.id).not.toBe(source.id);
    expect(duplicate?.title).toBe('Backend board clone');
    expect(duplicate?.tasks).toHaveLength(1);
    expect(duplicate?.tasks[0]?.id).not.toBe(added!.task.id);

    const copied = await copyTaskToBoard(tmpDir, source.id, added!.task.id, target.id);
    expect(copied?.targetBoard.tasks.map((task) => task.title)).toContain(
      'Implement websocket route',
    );
    expect(copied?.task.assignedAgent).toBeUndefined();

    const transferred = await transferTaskToBoard(tmpDir, source.id, added!.task.id, target.id);
    expect(transferred?.task.assignedAgent).toBe('api-agent');
    await expect(getBoard(tmpDir, source.id)).resolves.toMatchObject({ tasks: [] });
    expect((await getBoard(tmpDir, target.id))?.tasks).toHaveLength(2);
  });

  it('tracks assignment lifecycle and searches assigned tasks', async () => {
    const board = await createBoard(tmpDir, { title: 'Agent work' });
    const added = await addTask(tmpDir, board.id, { title: 'Let agent fix tests' });
    await assignTask(tmpDir, board.id, added!.task.id.slice(0, 8), {
      agentId: 'tester',
      provider: 'openai',
      model: 'gpt-5',
      fallbackModels: ['anthropic/anthropic-test-model'],
      tools: ['kanban', 'bash'],
      allowedCapabilities: ['fs.write', 'shell.exec'],
    });

    let loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      agentId: 'tester',
      provider: 'openai',
      model: 'gpt-5',
      fallbackModels: ['anthropic/anthropic-test-model'],
    });

    await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
      status: 'running',
      subagentId: 'sub-1',
    });
    loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.status).toBe('in_progress');

    await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
      status: 'completed',
      lastResult: 'done',
    });
    loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.status).toBe('completed');
    expect(loaded?.tasks[0]?.columnId).toBe('done');
    expect(loaded?.tasks[0]?.assignment?.completedAt).toBeTruthy();

    const matches = await searchKanban(tmpDir, { assignedAgent: 'tester' });
    expect(matches.map((match) => match.task.title)).toEqual(['Let agent fix tests']);
  });

  it('creates role-only routed tasks through the kanban tool without losing assignment metadata', async () => {
    const board = await createBoard(tmpDir, { title: 'Tool create board' });

    const result = await kanbanTool.execute(
      {
        action: 'add_task',
        boardId: board.id,
        title: 'Role routed task',
        role: 'implementer',
        fallbackProfile: 'careful',
        tools: ['bash'],
        allowedCapabilities: ['fs.write'],
        assignee: 'human-owner',
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ ok: true });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]).toMatchObject({
      title: 'Role routed task',
      assignedAgent: 'implementer',
      assignee: 'human-owner',
      assignment: {
        status: 'assigned',
        role: 'implementer',
        fallbackProfile: 'careful',
        tools: ['bash'],
        allowedCapabilities: ['fs.write'],
      },
    });
  });

  it('claims and releases ready tasks atomically for agent queues', async () => {
    const board = await createBoard(tmpDir, { title: 'Claim board' });
    const first = await addTask(tmpDir, board.id, {
      title: 'Critical work',
      priority: 'critical',
      status: 'ready',
    });
    await addTask(tmpDir, board.id, { title: 'Normal work', status: 'ready' });

    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      agentId: 'agent-a',
      provider: 'openai',
      model: 'gpt-5',
    });
    expect(claimed?.task.id).toBe(first!.task.id);
    expect(claimed?.task.assignment).toMatchObject({
      agentId: 'agent-a',
      provider: 'openai',
      model: 'gpt-5',
      status: 'queued',
    });
    expect(claimed?.task.assignment?.claimedAt).toBeTruthy();
    expect(claimed?.task.assignment?.dispatchedAt).toBe(claimed?.task.assignment?.claimedAt);

    let ready = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(ready.map((result) => result.task.title)).toEqual(['Normal work']);

    await releaseTaskClaim(tmpDir, board.id, first!.task.id, { reason: 'worker unavailable' });
    ready = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(ready.map((result) => result.task.title)).toContain('Critical work');

    const snapshot = await getKanbanOrchestrationSnapshot(tmpDir, { boardId: board.id });
    expect(snapshot.ready.map((result) => result.task.title)).toEqual([
      'Critical work',
      'Normal work',
    ]);
  });

  it('preserves preconfigured task routing metadata when claiming without overrides', async () => {
    const board = await createBoard(tmpDir, { title: 'Routed claim board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Use the routed model',
      status: 'ready',
    });
    await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      provider: 'anthropic',
      model: 'anthropic-test-model',
      fallbackProfile: 'careful',
      fallbackModels: ['openai/gpt-5'],
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
      leaseId: 'lease-existing',
      claimedAt: '2026-07-07T00:00:00.000Z',
      heartbeatAt: '2026-07-07T00:01:00.000Z',
      leaseExpiresAt: '2026-07-07T00:05:00.000Z',
      attempt: 2,
      maxAttempts: 3,
    });

    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      agentId: 'worker-42',
    });

    expect(claimed?.task.assignment).toMatchObject({
      agentId: 'worker-42',
      role: 'implementer',
      provider: 'anthropic',
      model: 'anthropic-test-model',
      fallbackProfile: 'careful',
      fallbackModels: ['openai/gpt-5'],
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
      leaseId: 'lease-existing',
      claimedAt: '2026-07-07T00:00:00.000Z',
      heartbeatAt: '2026-07-07T00:01:00.000Z',
      leaseExpiresAt: '2026-07-07T00:05:00.000Z',
      attempt: 2,
      maxAttempts: 3,
      status: 'queued',
    });
  });

  it('refreshes assignment heartbeat leases without disturbing assignment ownership or results', async () => {
    const board = await createBoard(tmpDir, { title: 'Heartbeat board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Long running work',
      status: 'ready',
    });
    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: task!.task.id,
      agentId: 'worker-1',
      status: 'running',
      leaseId: 'lease-1',
      leaseExpiresAt: '2026-07-07T00:05:00.000Z',
    });
    await updateTaskAssignment(tmpDir, board.id, claimed!.task.id, {
      status: 'running',
      subagentId: 'sub-1',
      runTaskId: 'run-1',
      lastResult: 'halfway done',
    });

    const heartbeat = await heartbeatTaskAssignment(tmpDir, board.id, claimed!.task.id, {
      heartbeatAt: '2026-07-07T00:03:00.000Z',
      leaseExpiresAt: '2026-07-07T00:08:00.000Z',
    });

    expect(heartbeat?.tasks[0]?.status).toBe('in_progress');
    expect(heartbeat?.tasks[0]?.columnId).toBe('in-progress');
    expect(heartbeat?.tasks[0]?.assignment).toMatchObject({
      status: 'running',
      agentId: 'worker-1',
      subagentId: 'sub-1',
      runTaskId: 'run-1',
      lastResult: 'halfway done',
      leaseId: 'lease-1',
      heartbeatAt: '2026-07-07T00:03:00.000Z',
      leaseExpiresAt: '2026-07-07T00:08:00.000Z',
    });

    const toolResult = await kanbanTool.execute(
      {
        action: 'heartbeat_assignment',
        boardId: board.id,
        taskId: claimed!.task.id,
        heartbeatAt: '2026-07-07T00:04:00.000Z',
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );

    expect(toolResult).toMatchObject({ ok: true });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      agentId: 'worker-1',
      lastResult: 'halfway done',
      heartbeatAt: '2026-07-07T00:04:00.000Z',
      leaseExpiresAt: '2026-07-07T00:08:00.000Z',
    });
  });

  it('recovers stale queued and running assignment leases by retry, release, or fail mode', async () => {
    const retryBoard = await createBoard(tmpDir, { title: 'Retry recovery board' });
    const retryTask = await addTask(tmpDir, retryBoard.id, {
      title: 'Retry stale work',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: retryBoard.id,
      taskId: retryTask!.task.id,
      agentId: 'worker-1',
      status: 'running',
      leaseId: 'lease-retry',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
      attempt: 1,
      maxAttempts: 3,
    });

    const retried = await recoverStaleTaskAssignments(tmpDir, retryBoard.id, {
      mode: 'retry',
      now: '2026-07-07T00:02:00.000Z',
      reason: 'worker heartbeat expired',
    });

    expect(retried?.tasks).toHaveLength(1);
    expect(retried?.tasks[0]).toMatchObject({ status: 'ready', columnId: 'todo' });
    expect(retried?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(retried?.tasks[0]?.assignment?.leaseId).toBeUndefined();
    expect(retried?.tasks[0]?.assignment?.runTaskId).toBeUndefined();

    const releaseBoard = await createBoard(tmpDir, { title: 'Release recovery board' });
    const releaseTask = await addTask(tmpDir, releaseBoard.id, {
      title: 'Release stale work',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: releaseBoard.id,
      taskId: releaseTask!.task.id,
      agentId: 'worker-2',
      status: 'running',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
    });

    const released = await kanbanTool.execute(
      {
        action: 'recover_stale',
        boardId: releaseBoard.id,
        recoveryMode: 'release',
        recoveryNow: '2026-07-07T00:02:00.000Z',
        releaseReason: 'worker unavailable',
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );

    expect(released).toMatchObject({ ok: true, recoveredTasks: [{ status: 'ready' }] });
    const releasedBoard = await getBoard(tmpDir, releaseBoard.id);
    expect(releasedBoard?.tasks[0]?.assignment).toBeUndefined();
    expect(releasedBoard?.tasks[0]?.notes?.[0]?.content).toContain('worker unavailable');

    const failBoard = await createBoard(tmpDir, { title: 'Fail recovery board' });
    const failTask = await addTask(tmpDir, failBoard.id, {
      title: 'Fail stale work',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: failBoard.id,
      taskId: failTask!.task.id,
      agentId: 'worker-3',
      status: 'running',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
    });

    const failed = await recoverStaleTaskAssignments(tmpDir, failBoard.id, {
      mode: 'fail',
      now: '2026-07-07T00:02:00.000Z',
      reason: 'worker lost',
    });

    expect(failed?.tasks[0]).toMatchObject({ status: 'failed', columnId: 'review' });
    expect(failed?.tasks[0]?.assignment).toMatchObject({
      status: 'failed',
      error: 'worker lost',
    });
  });

  it('appends append-only Kanban assignment events for claim, running, completed, failed, and stale recovery transitions', async () => {
    const board = await createBoard(tmpDir, { title: 'Events board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Track lifecycle events',
      status: 'ready',
    });

    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: task!.task.id,
      agentId: 'worker-events',
      status: 'running',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
    });

    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'running',
      subagentId: 'sub-events',
      runTaskId: 'run-events',
    });
    await heartbeatTaskAssignment(tmpDir, board.id, task!.task.id, {
      heartbeatAt: '2026-07-07T00:00:30.000Z',
    });
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'completed',
      lastResult: 'ok',
    });

    const events = await listKanbanEvents(tmpDir, board.id);

    expect(events.map((event) => event.type)).toEqual([
      'task.created',
      'task.claimed',
      'task.assignment.running',
      'task.assignment.heartbeat',
      'task.assignment.completed',
    ]);

    const completedEvent = events.find((event) => event.type === 'task.assignment.completed');
    expect(completedEvent?.taskId).toBe(task!.task.id);
    expect(completedEvent?.subagentId).toBe('sub-events');
    expect(completedEvent?.runTaskId).toBe('run-events');
    expect(completedEvent?.actor).toBe('worker-events');

    const toolEvents = await kanbanTool.execute(
      {
        action: 'events',
        boardId: board.id,
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(toolEvents).toMatchObject({ ok: true });
    expect(toolEvents.events.length).toBe(events.length);
  });

  it('dispatches ready kanban work into the director fleet and writes completion back', async () => {
    const board = await createBoard(tmpDir, { title: 'Fleet board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Implement fleet bridge',
      description: 'Wire Kanban ready work into Director subagents.',
      status: 'ready',
      priority: 'high',
    });
    await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
    });

    const spawns: SubagentConfig[] = [];
    const assignments: TaskSpec[] = [];
    const fakeDirector = {
      spawn: async (config: SubagentConfig) => {
        spawns.push(config);
        return 'sub-1';
      },
      assign: async (spec: TaskSpec) => {
        assignments.push(spec);
        return 'fleet-task-1';
      },
      awaitTasks: async (taskIds: string[]): Promise<TaskResult[]> => {
        expect(taskIds).toEqual(['fleet-task-1']);
        return [
          {
            subagentId: 'sub-1',
            taskId: 'fleet-task-1',
            status: 'success',
            result: 'done',
            iterations: 1,
            toolCalls: 2,
            durationMs: 3,
          },
        ];
      },
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);

    const result = await tool.execute(
      { boardId: board.id, awaitCompletion: true },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      allowedCapabilities: ['fs.write'],
    });
    expect(spawns[0]?.tools).toEqual(['bash', 'kanban']);
    expect(assignments[0]?.description).toContain('Implement fleet bridge');
    expect(assignments[0]?.description).toContain('Lease contract');
    expect(assignments[0]?.description).toContain('heartbeat_assignment');
    expect(assignments[0]?.description).toContain('recover_stale');
    expect(assignments[0]?.context).toMatchObject({
      kanban: { boardId: board.id, taskId: task!.task.id },
    });

    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'completed',
      subagentId: 'sub-1',
      runTaskId: 'fleet-task-1',
      lastResult: 'done',
      provider: 'openai',
      model: 'gpt-5',
    });
    expect(loaded?.tasks[0]?.assignment?.leaseId).toBeTruthy();
    expect(loaded?.tasks[0]?.assignment?.leaseExpiresAt).toBeTruthy();
    expect(loaded?.tasks[0]?.status).toBe('completed');
  });

  it('cleans up spawned kanban queue workers when fleet assignment fails', async () => {
    const board = await createBoard(tmpDir, { title: 'Fleet failure board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Assign should fail',
      status: 'ready',
    });
    const terminated: string[] = [];
    const fakeDirector = {
      spawn: async (_config: SubagentConfig) => 'sub-orphan',
      assign: async (_spec: TaskSpec) => {
        throw new Error('assign refused');
      },
      awaitTasks: async (_taskIds: string[]): Promise<TaskResult[]> => [],
      terminate: async (subagentId: string) => {
        terminated.push(subagentId);
      },
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);

    const result = await tool.execute({ boardId: board.id }, { projectRoot: tmpDir } as never, {
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      count: 0,
      errors: [expect.objectContaining({ taskId: task!.task.id, error: 'assign refused' })],
    });
    expect(terminated).toEqual(['sub-orphan']);
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'failed',
      subagentId: 'sub-orphan',
      error: 'assign refused',
    });
    expect(loaded?.tasks[0]?.status).toBe('failed');
  });

  it('reports awaited kanban queue task failures as tool failures', async () => {
    const board = await createBoard(tmpDir, { title: 'Fleet result failure board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Subagent will fail',
      status: 'ready',
    });
    const fakeDirector = {
      spawn: async (_config: SubagentConfig) => 'sub-failed',
      assign: async (_spec: TaskSpec) => 'fleet-task-failed',
      awaitTasks: async (_taskIds: string[]): Promise<TaskResult[]> => [
        {
          subagentId: 'sub-failed',
          taskId: 'fleet-task-failed',
          status: 'failed',
          error: { kind: 'tool_failed', message: 'verification failed', retryable: false },
          iterations: 1,
          toolCalls: 1,
          durationMs: 2,
        },
      ],
      terminate: async (_subagentId: string) => {},
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);

    const result = await tool.execute(
      { boardId: board.id, awaitCompletion: true },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      ok: false,
      count: 1,
      resultFailures: [
        expect.objectContaining({
          taskId: task!.task.id,
          runTaskId: 'fleet-task-failed',
          status: 'failed',
          error: 'tool_failed: verification failed',
        }),
      ],
    });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'failed',
      subagentId: 'sub-failed',
      runTaskId: 'fleet-task-failed',
      error: 'tool_failed: verification failed',
    });
  });

  it('rejects self dependencies and dependency cycles', async () => {
    const board = await createBoard(tmpDir, { title: 'Dependency board' });
    const a = await addTask(tmpDir, board.id, { title: 'A' });
    const b = await addTask(tmpDir, board.id, { title: 'B' });

    await expect(addDependency(tmpDir, board.id, a!.task.id, a!.task.id)).rejects.toThrow(
      'cannot depend on itself',
    );
    await expect(addDependency(tmpDir, board.id, a!.task.id, b!.task.id)).resolves.toBeTruthy();
    await expect(addDependency(tmpDir, board.id, b!.task.id, a!.task.id)).rejects.toThrow(
      'dependency cycle',
    );
  });

  it('keeps task order and completion metadata consistent when moving tasks', async () => {
    const board = await createBoard(tmpDir, { title: 'Move board' });
    const existing = await addTask(tmpDir, board.id, {
      title: 'Already running',
      columnId: 'in-progress',
    });
    const moved = await addTask(tmpDir, board.id, { title: 'Move me' });

    let loaded = await moveTask(tmpDir, board.id, moved!.task.id, 'in-progress');
    const runningTasks = loaded!.tasks
      .filter((task) => task.columnId === 'in-progress')
      .sort((a, b) => a.order - b.order);
    expect(runningTasks.map((task) => task.title)).toEqual(['Already running', 'Move me']);
    expect(runningTasks.map((task) => task.order)).toEqual([0, 1]);
    expect(runningTasks.find((task) => task.id === existing!.task.id)?.completedAt).toBeUndefined();

    loaded = await moveTask(tmpDir, board.id, moved!.task.id, 'done');
    const completed = loaded!.tasks.find((task) => task.id === moved!.task.id);
    expect(completed).toMatchObject({ columnId: 'done', status: 'completed' });
    expect(completed?.completedAt).toBeTruthy();
  });

  it('rejects dependency cycles through task updates and ambiguous column prefixes', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Strict board',
      columns: [
        { id: 'doing', title: 'Doing', order: 0 },
        { id: 'done', title: 'Done', order: 1 },
      ],
    });
    const a = await addTask(tmpDir, board.id, { title: 'A', columnId: 'doing' });
    const b = await addTask(tmpDir, board.id, { title: 'B', columnId: 'doing' });

    await expect(moveTask(tmpDir, board.id, a!.task.id, 'do')).rejects.toThrow(
      'Ambiguous kanban column id',
    );
    await expect(
      updateTask(tmpDir, board.id, a!.task.id, { dependsOn: [a!.task.id] }),
    ).rejects.toThrow('cannot depend on itself');
    await expect(
      updateTask(tmpDir, board.id, a!.task.id, { dependsOn: [b!.task.id] }),
    ).resolves.toBeTruthy();
    await expect(
      updateTask(tmpDir, board.id, b!.task.id, { dependsOn: [a!.task.id] }),
    ).rejects.toThrow('dependency cycle');
  });

  it('turns ordered task chains into executable dependency order', async () => {
    const board = await createBoard(tmpDir, { title: 'Chain board' });
    const first = await addTask(tmpDir, board.id, { title: 'Design API' });
    const second = await addTask(tmpDir, board.id, { title: 'Implement API' });
    const third = await addTask(tmpDir, board.id, { title: 'Verify API' });

    const chained = await setTaskChain(tmpDir, board.id, {
      taskIds: [first!.task.id, second!.task.id, third!.task.id],
      chainId: 'api-chain',
    });
    expect(chained?.tasks.map((task) => task.chain?.order)).toEqual([0, 1, 2]);
    expect(chained?.tasks[1]?.dependsOn).toContain(first!.task.id);
    expect(chained?.tasks[2]?.dependsOn).toContain(second!.task.id);

    let ready = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(ready.map((result) => result.task.title)).toEqual(['Design API']);

    await updateTask(tmpDir, board.id, first!.task.id, { status: 'completed' });
    ready = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(ready.map((result) => result.task.title)).toEqual(['Implement API']);

    const loadedChain = await getTaskChain(tmpDir, board.id, second!.task.id);
    expect(loadedChain?.chainId).toBe('api-chain');
    expect(loadedChain?.tasks.map((task) => task.title)).toEqual([
      'Design API',
      'Implement API',
      'Verify API',
    ]);
  });

  it('splits and merges tasks while rewiring dependent work', async () => {
    const board = await createBoard(tmpDir, { title: 'Graph board' });
    const parent = await addTask(tmpDir, board.id, { title: 'Build feature' });
    const downstream = await addTask(tmpDir, board.id, {
      title: 'Release feature',
      dependsOn: [parent!.task.id],
    });

    const split = await splitTask(tmpDir, board.id, parent!.task.id, {
      titles: ['Backend slice', 'Frontend slice'],
      chainChildren: true,
      rewireDependents: true,
    });
    expect(split?.parent.childTaskIds).toHaveLength(2);
    expect(split?.children[1]?.dependsOn).toContain(split?.children[0]?.id);

    let loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks.find((task) => task.id === downstream!.task.id)?.dependsOn).toEqual(
      split?.children.map((task) => task.id),
    );

    const merged = await mergeTasks(tmpDir, board.id, {
      taskIds: split!.children.map((task) => task.id),
      title: 'Feature implementation',
    });
    expect(merged?.task.mergedFromTaskIds).toEqual(split?.children.map((task) => task.id));

    loaded = await getBoard(tmpDir, board.id);
    expect(
      loaded?.tasks.filter((task) => split?.children.some((child) => child.id === task.id)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Backend slice', status: 'archived' }),
        expect.objectContaining({ title: 'Frontend slice', status: 'archived' }),
      ]),
    );
    expect(loaded?.tasks.find((task) => task.id === downstream!.task.id)?.dependsOn).toEqual([
      merged!.task.id,
    ]);
  });

  it('tracks goal metrics on tasks', async () => {
    const board = await createBoard(tmpDir, { title: 'Metrics board' });
    const task = await addTask(tmpDir, board.id, { title: 'Improve latency' });

    await addGoalMetricToTask(tmpDir, board.id, task!.task.id, {
      name: 'p95 latency',
      target: 250,
      unit: 'ms',
    });
    let loaded = await getBoard(tmpDir, board.id);
    const metric = loaded?.tasks[0]?.goalMetrics?.[0];
    expect(metric).toMatchObject({ name: 'p95 latency', target: 250, unit: 'ms' });

    await updateGoalMetricOnTask(tmpDir, board.id, task!.task.id, metric!.id, {
      current: 220,
      status: 'met',
    });
    loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.goalMetrics?.[0]).toMatchObject({
      current: 220,
      status: 'met',
    });
  });

  it('imports SDD/AutoPhase task graphs into kanban boards with dependency traceability', async () => {
    const graph: TaskGraph = {
      id: 'graph-1',
      specId: 'spec-1',
      title: 'Graph Import',
      nodes: new Map([
        [
          't1',
          {
            id: 't1',
            title: 'Design',
            description: 'Design the feature',
            type: 'feature',
            priority: 'high',
            status: 'completed',
            createdAt: 1,
            updatedAt: 1,
            completedAt: 2,
            tags: ['api'],
          },
        ],
        [
          't2',
          {
            id: 't2',
            title: 'Implement',
            description: 'Implement the feature',
            type: 'feature',
            priority: 'critical',
            status: 'pending',
            createdAt: 2,
            updatedAt: 2,
            parentId: 't1',
            tags: ['api'],
          },
        ],
      ]),
      edges: [{ id: 'e1', from: 't1', to: 't2', type: 'depends_on' }],
      rootNodes: ['t1'],
      createdAt: 1,
      updatedAt: 2,
    };

    const imported = await createBoardFromTaskGraph(tmpDir, graph, {
      sourceSystem: 'sdd',
      includeCompletedTasks: true,
    });

    expect(imported.board.generatedBy).toBe('sdd:graph-1');
    expect(imported.taskIdMap.get('t1')).toBeTruthy();
    const design = imported.board.tasks.find((task) => task.origin?.taskId === 't1');
    const implement = imported.board.tasks.find((task) => task.origin?.taskId === 't2');
    expect(design).toMatchObject({ title: 'Design', status: 'completed', columnId: 'done' });
    expect(implement?.dependsOn).toEqual([design!.id]);
    expect(implement?.parentTaskId).toBe(design!.id);
    expect(implement?.origin).toMatchObject({
      system: 'sdd',
      graphId: 'graph-1',
      taskId: 't2',
      specId: 'spec-1',
    });
  });

  it('syncs kanban boards with task graphs and exports them back with stable origin ids', async () => {
    const graph: TaskGraph = {
      id: 'graph-sync',
      specId: 'spec-sync',
      title: 'Graph Sync',
      nodes: new Map([
        [
          't1',
          {
            id: 't1',
            title: 'Design',
            description: 'Initial design',
            type: 'feature',
            priority: 'high',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        [
          't2',
          {
            id: 't2',
            title: 'Implement',
            description: 'Initial implementation',
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      ]),
      edges: [{ id: 'e1', from: 't1', to: 't2', type: 'depends_on' }],
      rootNodes: ['t1'],
      createdAt: 1,
      updatedAt: 2,
    };

    const imported = await createBoardFromTaskGraph(tmpDir, graph, {
      sourceSystem: 'sdd',
      includeCompletedTasks: true,
    });
    const t1KanbanId = imported.taskIdMap.get('t1')!;
    await addTask(tmpDir, imported.board.id, {
      title: 'Manual follow-up',
      dependsOn: [t1KanbanId],
      labels: ['manual'],
    });

    const nextGraph: TaskGraph = {
      ...graph,
      updatedAt: 3,
      nodes: new Map([
        [
          't1',
          {
            ...graph.nodes.get('t1')!,
            title: 'Design v2',
            status: 'completed',
            completedAt: 4,
            updatedAt: 4,
          },
        ],
        [
          't3',
          {
            id: 't3',
            title: 'Verify',
            description: 'Verify implementation',
            type: 'test',
            priority: 'critical',
            status: 'pending',
            createdAt: 3,
            updatedAt: 3,
          },
        ],
      ]),
      edges: [{ id: 'e2', from: 't1', to: 't3', type: 'depends_on' }],
      rootNodes: ['t1'],
    };

    const synced = await syncBoardFromTaskGraph(tmpDir, imported.board.id, nextGraph, {
      sourceSystem: 'sdd',
      includeCompletedTasks: true,
    });
    expect(synced?.createdTaskIds).toHaveLength(1);
    expect(synced?.archivedTaskIds).toHaveLength(1);

    const loaded = await getBoard(tmpDir, imported.board.id);
    const t1 = loaded?.tasks.find((task) => task.origin?.taskId === 't1');
    const t2 = loaded?.tasks.find((task) => task.origin?.taskId === 't2');
    const t3 = loaded?.tasks.find((task) => task.origin?.taskId === 't3');
    const manual = loaded?.tasks.find((task) => task.title === 'Manual follow-up');
    expect(t1?.id).toBe(t1KanbanId);
    expect(t1).toMatchObject({ title: 'Design v2', status: 'completed' });
    expect(t2?.status).toBe('archived');
    expect(t3?.dependsOn).toEqual([t1KanbanId]);
    expect(manual?.dependsOn).toEqual([t1KanbanId]);

    const exported = await exportBoardToTaskGraph(tmpDir, imported.board.id, {
      graphId: 'roundtrip',
      specId: 'roundtrip-spec',
    });
    expect(exported?.graph.nodes.has('t1')).toBe(true);
    expect(exported?.graph.nodes.has('t3')).toBe(true);
    expect(exported?.graph.nodes.has('t2')).toBe(false);
    expect(exported?.graph.edges).toContainEqual(
      expect.objectContaining({ from: 't1', to: 't3', type: 'depends_on' }),
    );
  });
});

describe('kanban websocket handler', () => {
  it('creates a board and adds a task through websocket messages', async () => {
    const { ctx, sent } = wsRig();

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.create',
      payload: { title: 'WS board' },
    });

    const created = lastPayload<{ success: true; data: KanbanBoard }>(sent, 'kanban.create');
    expect(created.success).toBe(true);
    expect(created.data.title).toBe('WS board');

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.add',
      payload: {
        boardId: created.data.id.slice(0, 8),
        title: 'Add client store',
        priority: 'high',
      },
    });

    const added = lastPayload<{ success: true; data: { title: string; priority: string } }>(
      sent,
      'kanban.task.add',
    );
    expect(added).toMatchObject({
      success: true,
      data: { title: 'Add client store', priority: 'high' },
    });
  });

  it('copies and transfers tasks between boards through websocket messages', async () => {
    const { ctx, sent } = wsRig();
    const source = await createBoard(tmpDir, { title: 'Source' });
    const target = await createBoard(tmpDir, { title: 'Target' });
    const task = await addTask(tmpDir, source.id, {
      title: 'Move me across boards',
      assignedAgent: 'worker-1',
    });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.duplicate',
      payload: { boardId: source.id, title: 'Source Clone', preserveAssignment: true },
    });
    const duplicated = lastPayload<{ success: true; data: KanbanBoard }>(sent, 'kanban.duplicate');
    expect(duplicated.data.title).toBe('Source Clone');
    expect(duplicated.data.tasks[0]?.assignedAgent).toBe('worker-1');

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.copy',
      payload: { boardId: source.id, taskId: task!.task.id, targetBoardId: target.id },
    });
    const copied = lastPayload<{ success: true; data: KanbanBoard }>(sent, 'kanban.task.copy');
    expect(copied.data.tasks).toHaveLength(1);
    expect(copied.data.tasks[0]?.assignedAgent).toBeUndefined();

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.transfer',
      payload: {
        boardId: source.id,
        taskId: task!.task.id,
        targetBoardId: target.id,
        preserveAssignment: true,
      },
    });
    const transferred = lastPayload<{ success: true; data: KanbanBoard }>(
      sent,
      'kanban.task.transfer',
    );
    expect(transferred.data.tasks).toHaveLength(2);
    expect(transferred.data.tasks.at(-1)?.assignedAgent).toBe('worker-1');
    expect((await getBoard(tmpDir, source.id))?.tasks).toHaveLength(0);
  });

  it('sets chains and splits tasks through websocket messages', async () => {
    const { ctx, sent } = wsRig();
    const board = await createBoard(tmpDir, { title: 'WS graph board' });
    const first = await addTask(tmpDir, board.id, { title: 'First' });
    const second = await addTask(tmpDir, board.id, { title: 'Second' });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.chain',
      payload: { boardId: board.id, taskIds: [first!.task.id, second!.task.id] },
    });
    const chained = lastPayload<{
      success: true;
      data: { board: KanbanBoard; chainId: string; tasks: Array<{ dependsOn?: string[] }> };
    }>(sent, 'kanban.task.chain');
    expect(chained.success).toBe(true);
    expect(chained.data.tasks[1]?.dependsOn).toContain(first!.task.id);

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.split',
      payload: {
        boardId: board.id,
        taskId: first!.task.id,
        childTitles: ['First A', 'First B'],
        chainChildren: true,
      },
    });
    const split = lastPayload<{
      success: true;
      data: {
        board: KanbanBoard;
        children: Array<{ id: string; title: string; dependsOn?: string[] }>;
      };
    }>(sent, 'kanban.task.split');
    expect(split.success).toBe(true);
    expect(split.data.children.map((task) => task.title)).toEqual(['First A', 'First B']);
    expect(split.data.children[1]?.dependsOn).toContain(split.data.children[0]?.id);
  });

  it('claims ready tasks through websocket messages', async () => {
    const { ctx, sent } = wsRig();
    const board = await createBoard(tmpDir, { title: 'WS claim board' });
    const task = await addTask(tmpDir, board.id, { title: 'Claim over WS', status: 'ready' });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.claim',
      payload: { boardId: board.id, agentId: 'ws-agent', assignmentStatus: 'queued' },
    });

    const claimed = lastPayload<{
      success: true;
      data: { board: KanbanBoard; task: { id: string; assignment?: { agentId?: string } } };
    }>(sent, 'kanban.task.claim');
    expect(claimed.success).toBe(true);
    expect(claimed.data.task.id).toBe(task!.task.id);
    expect(claimed.data.task.assignment).toMatchObject({ agentId: 'ws-agent' });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.claim',
      payload: { boardId: board.id, agentId: 'other-agent' },
    });
    const failed = lastPayload<{ success: false; error: string }>(sent, 'kanban.task.claim');
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('No ready');
  });

  it('persists the complete worker contract through websocket assignment', async () => {
    const { ctx, sent } = wsRig();
    const board = await createBoard(tmpDir, { title: 'WS assignment board' });
    const task = await addTask(tmpDir, board.id, { title: 'Configured work' });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.assign',
      payload: {
        boardId: board.id,
        taskId: task!.task.id,
        modelRouting: 'fallback_profile',
        fallbackProfile: 'careful',
        fallbackModels: ['anthropic/backup'],
        skills: ['testing'],
        tools: ['kanban'],
        maxAttempts: 4,
        costCeilingUsd: 1.5,
        retryPolicy: 'exponential',
      },
    });

    const assigned = lastPayload<{
      success: true;
      data: { assignment?: Record<string, unknown> };
    }>(sent, 'kanban.task.assign');
    expect(assigned.data.assignment).toMatchObject({
      modelRouting: 'fallback_profile',
      fallbackProfile: 'careful',
      fallbackModels: ['anthropic/backup'],
      skills: ['testing'],
      tools: ['kanban'],
      maxAttempts: 4,
      costCeilingUsd: 1.5,
      retryPolicy: 'exponential',
    });
  });

  it('exports and syncs task graphs through websocket messages', async () => {
    const { ctx, sent } = wsRig();
    const board = await createBoard(tmpDir, { title: 'WS graph bridge' });
    await addTask(tmpDir, board.id, { title: 'Existing work', status: 'ready' });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.taskgraph.export',
      payload: { boardId: board.id, graphId: 'ws-graph' },
    });
    const exported = lastPayload<{
      success: true;
      data: { board: KanbanBoard; taskGraph: { id: string; nodes: Array<{ title: string }> } };
    }>(sent, 'kanban.taskgraph.export');
    expect(exported.success).toBe(true);
    expect(exported.data.taskGraph).toMatchObject({ id: 'ws-graph' });
    expect(exported.data.taskGraph.nodes.map((node) => node.title)).toEqual(['Existing work']);

    const graph: TaskGraph = {
      id: 'ws-import',
      specId: 'ws-spec',
      title: 'WS Import',
      nodes: new Map([
        [
          'node-a',
          {
            id: 'node-a',
            title: 'Imported work',
            description: '',
            type: 'feature',
            priority: 'critical',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      ]),
      edges: [],
      rootNodes: ['node-a'],
      createdAt: 1,
      updatedAt: 1,
    };

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.taskgraph.sync',
      payload: {
        boardId: board.id,
        taskGraph: serializeTaskGraph(graph),
        sourceSystem: 'sdd',
      },
    });
    const synced = lastPayload<{
      success: true;
      data: { board: KanbanBoard; createdTaskIds: string[] };
    }>(sent, 'kanban.taskgraph.sync');
    expect(synced.success).toBe(true);
    expect(synced.data.createdTaskIds).toHaveLength(1);
    expect(synced.data.board.tasks.find((task) => task.origin?.taskId === 'node-a')).toMatchObject({
      title: 'Imported work',
      priority: 'critical',
    });
  });

  it('dispatches kanban tasks with provider, model, fallback, tools, and capabilities', async () => {
    const dispatched: Array<{ description: string; opts: Record<string, unknown> | undefined }> =
      [];
    let onDone:
      | ((result: {
          status: 'completed' | 'failed';
          result?: string | undefined;
          error?: string | undefined;
        }) => void | Promise<void>)
      | undefined;
    const { ctx, sent } = wsRig();
    ctx.dispatchTask = async (description, opts) => {
      dispatched.push({ description, opts: opts as Record<string, unknown> | undefined });
      onDone = opts?.onDone;
      return 'Spawned subagent kanban-123 for task task-456.';
    };

    const board = await createBoard(tmpDir, { title: 'Dispatch board' });
    const task = await addTask(tmpDir, board.id, { title: 'Run this with an agent' });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.dispatch',
      payload: {
        boardId: board.id,
        taskId: task!.task.id.slice(0, 8),
        agentId: 'runner',
        provider: 'openai',
        model: 'gpt-5',
        fallbackModels: ['anthropic/anthropic-test-model'],
        skills: ['testing'],
        tools: ['kanban', 'bash'],
        allowedCapabilities: ['fs.write'],
      },
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.opts).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
      fallbackModels: ['anthropic/anthropic-test-model'],
      skills: ['testing'],
      tools: ['kanban', 'bash'],
      allowedCapabilities: ['fs.write'],
    });
    expect(dispatched[0]?.description).toContain('Run this with an agent');

    const payload = lastPayload<{ success: true; data: { task: { assignment: unknown } } }>(
      sent,
      'kanban.task.dispatch',
    );
    expect(payload.success).toBe(true);
    expect(payload.data.task.assignment).toMatchObject({
      agentId: 'runner',
      status: 'running',
      subagentId: 'kanban-123',
    });

    await onDone?.({ status: 'completed', result: 'agent finished' });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      agentId: 'runner',
      status: 'completed',
      lastResult: 'agent finished',
    });
  });

  it('returns stable board and task ids when removing tasks through websocket messages', async () => {
    const { ctx, sent } = wsRig();
    const board = await createBoard(tmpDir, { title: 'Remove board' });
    const task = await addTask(tmpDir, board.id, { title: 'Remove me' });

    await handleKanbanMessage(ctx, FAKE_WS, {
      type: 'kanban.task.remove',
      payload: { boardId: board.id.slice(0, 8), taskId: task!.task.id.slice(0, 8) },
    });

    const removed = lastPayload<{
      success: true;
      data: { removed: true; boardId: string; taskId: string; board: KanbanBoard };
    }>(sent, 'kanban.task.remove');
    expect(removed.data).toMatchObject({
      removed: true,
      boardId: board.id,
      taskId: task!.task.id,
    });
    expect(removed.data.board.tasks).toHaveLength(0);
  });
});
