import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, getBoard } from '@wrongstack/kanban';
import {
  addTask,
  claimReadyTask,
  recoverStaleTaskAssignments,
  updateTaskAssignment,
} from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-rt-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

async function setupReady() {
  const board = await createBoard(tmpDir, { title: 'Router board' });
  const task = await addTask(tmpDir, board.id, {
    title: 'Stale candidate',
    status: 'ready',
  });
  const claimed = await claimReadyTask(tmpDir, {
    boardId: board.id,
    taskId: task!.task.id,
    agentId: 'worker-r',
    status: 'running',
    leaseExpiresAt: '2024-01-01T00:00:00.000Z',
  });
  expect(claimed).not.toBeNull();
  return { board, task: task!.task };
}

describe('Kanban recovery router (Sprint 2 auto mode)', () => {
  it('honors explicit retry mode (default back-compat)', async () => {
    const { board } = await setupReady();

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
      now: '2030-01-01T00:00:00.000Z',
    });

    expect(result?.tasks).toHaveLength(1);
    expect(result?.tasks[0]).toMatchObject({ status: 'ready' });
    expect(result?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      attempt: 1,
    });
  });

  it('in auto mode, fails when retryPolicy is "off"', async () => {
    const { board, task } = await setupReady();
    await updateTaskAssignment(tmpDir, board.id, task.id, {
      status: 'running',
      retryPolicy: 'off',
    });

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
    });

    expect(result?.tasks[0]).toMatchObject({ status: 'failed' });
    expect(result?.tasks[0]?.assignment).toMatchObject({ status: 'failed' });
  });

  it('in auto mode, fails when the policy asks for fail-on-cost and a cost ceiling is set', async () => {
    const { board, task } = await setupReady();
    await updateTaskAssignment(tmpDir, board.id, task.id, {
      status: 'running',
      costCeilingUsd: 0.5,
    });

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
      policy: { failWhenCostCeilingSet: true },
    });

    expect(result?.tasks[0]).toMatchObject({ status: 'failed' });
    expect(result?.tasks[0]?.assignment?.error).toContain('Stale assignment recovered');
  });

  it('in auto mode, releases when the policy asks for release-on-failure-kind', async () => {
    const { board, task } = await setupReady();
    await updateTaskAssignment(tmpDir, board.id, task.id, {
      status: 'running',
      lastFailureKind: 'tool_timeout',
    });

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
      policy: { releaseOnFailureKinds: ['tool_timeout'] },
    });

    expect(result?.tasks[0]).toMatchObject({ status: 'ready' });
    expect(result?.tasks[0]?.assignment).toBeUndefined();
  });

  it('falls back to retry in auto mode when no policy rule matches', async () => {
    const { board, task } = await setupReady();
    await updateTaskAssignment(tmpDir, board.id, task.id, {
      status: 'running',
      attempt: 2,
      maxAttempts: 5,
    });

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
      policy: { releaseOnFailureKinds: ['provider_outage'] },
    });

    expect(result?.tasks[0]).toMatchObject({ status: 'ready' });
    expect(result?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      attempt: 3,
    });
  });

  it('keeps per-task notes with the resolved mode and original reason', async () => {
    const { board } = await setupReady();

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      now: '2030-01-01T00:00:00.000Z',
      reason: 'worker-cancel',
    });

    const loaded = await getBoard(tmpDir, board.id);
    const note = loaded?.tasks[0]?.notes?.find((entry) =>
      entry.content.includes('Stale assignment recovered (release): worker-cancel'),
    );
    expect(note).toBeTruthy();
  });
});
