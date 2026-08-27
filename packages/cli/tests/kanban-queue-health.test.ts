import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, getBoard, getKanbanQueueHealth } from '@wrongstack/kanban';
import {
  addDependency,
  addTask,
  claimReadyTask,
  updateTaskAssignment,
} from '@wrongstack/kanban/test-support';
import { kanbanTool } from '@wrongstack/tools/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Session that owns the board events these queue tests write. */
const TEST_QUEUE_SESSION_ID = '2026-08-26/sess_01TESTKANBANQUEUE0000000';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-qh-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('Kanban queue health (Sprint 2 helper)', () => {
  it('produces counts and signal buckets that match board state and event log', async () => {
    const board = await createBoard(tmpDir, { title: 'Health board' });
    const blocker = await addTask(tmpDir, board.id, { title: 'Blocker', status: 'pending' });
    const blockedReady = await addTask(tmpDir, board.id, {
      title: 'Waiting on blocker',
      status: 'ready',
    });
    await addDependency(tmpDir, board.id, blockedReady!.task.id, blocker!.task.id);
    const runnable = await addTask(tmpDir, board.id, { title: 'Runnable', status: 'ready' });
    const staleCandidate = await addTask(tmpDir, board.id, {
      title: 'Stale candidate',
      status: 'ready',
    });

    const claimedRun = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: runnable!.task.id,
      agentId: 'worker-r',
      status: 'running',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(claimedRun).not.toBeNull();
    await updateTaskAssignment(tmpDir, board.id, runnable!.task.id, {
      status: 'running',
      subagentId: 'sub-r',
      runTaskId: 'run-r',
    });

    const claimedStale = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: staleCandidate!.task.id,
      agentId: 'worker-s',
      status: 'running',
      leaseExpiresAt: '2024-01-01T00:00:00.000Z',
    });
    expect(claimedStale).not.toBeNull();

    const health = await getKanbanQueueHealth(tmpDir, {
      boardId: board.id,
      now: '2030-01-01T00:00:00.000Z',
      heartbeatIntervalMs: 60_000,
    });

    expect(health.counts.pending).toBe(1);
    expect(health.counts.running).toBe(2);
    expect(health.counts.ready).toBe(1);
    expect(health.dependencyBlocked.count).toBe(1);
    expect(health.dependencyBlocked.tasks[0]?.task.title).toBe('Waiting on blocker');
    expect(health.staleAssignments.count).toBe(2);
    expect(
      health.staleAssignments.tasks.map((entry) => entry.task.assignment?.agentId).sort(),
    ).toEqual(expect.arrayContaining(['worker-r', 'worker-s']));
    expect(health.heartbeatDue.count).toBe(2);
    expect(health.lastDispatchedAt).toBeTruthy();
    expect(health.lastStaleRecoveredAt).toBeUndefined();

    const future = await getKanbanQueueHealth(tmpDir, {
      boardId: board.id,
      now: '2099-06-01T00:00:00.000Z',
    });
    expect(future.staleAssignments.count).toBe(2);
    expect(future.heartbeatDue.count).toBe(2);
    expect(future.failedRetryable.count).toBe(0);

    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks).toHaveLength(4);
  });

  it('exposes queue_health through the kanban tool action and keeps dependencyBlocked as a subset of ready', async () => {
    const board = await createBoard(tmpDir, { title: 'Tool action board' });
    const blocker = await addTask(tmpDir, board.id, { title: 'Blocker', status: 'pending' });
    const blockedReady = await addTask(tmpDir, board.id, {
      title: 'Waiting on blocker',
      status: 'ready',
    });
    await addDependency(tmpDir, board.id, blockedReady!.task.id, blocker!.task.id);
    const freeReady = await addTask(tmpDir, board.id, {
      title: 'Free ready',
      status: 'ready',
    });

    const toolResult = await kanbanTool.execute(
      {
        action: 'queue_health',
        boardId: board.id,
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );

    expect(toolResult).toMatchObject({ ok: true });
    const health = (
      toolResult as {
        queueHealth?: {
          counts: { pending: number; ready: number };
          dependencyBlocked: { count: number; tasks: unknown[] };
        };
      }
    ).queueHealth;
    expect(health).toBeDefined();
    expect(health?.counts.pending).toBe(1);
    expect(health?.counts.ready).toBe(2);
    expect(health?.dependencyBlocked.count).toBe(1);
    // The dependencyBlocked bucket must be a subset of counts.ready tasks.
    const blockedIds = new Set(
      (health!.dependencyBlocked.tasks as Array<{ task: { id: string } }>).map(
        (entry) => entry.task.id,
      ),
    );
    expect(blockedIds.has(blockedReady!.task.id)).toBe(true);
    expect(blockedIds.has(freeReady!.task.id)).toBe(false);
  });
});
