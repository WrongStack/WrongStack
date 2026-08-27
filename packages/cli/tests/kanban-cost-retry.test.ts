import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, getBoard } from '@wrongstack/kanban';
import {
  addTask,
  assignTask,
  claimReadyTask,
  updateTaskAssignment,
} from '@wrongstack/kanban/test-support';
import { kanbanTool } from '@wrongstack/tools/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Session that owns the board events these queue tests write. */
const TEST_QUEUE_SESSION_ID = '2026-08-26/sess_01TESTKANBANQUEUE0000000';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-cr-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('Kanban cost ceiling and retry policy (Sprint 2 fields)', () => {
  it('persists cost ceiling and retry policy across claim and worker updates', async () => {
    const board = await createBoard(tmpDir, { title: 'Cost/retry board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Bounded work',
      status: 'ready',
    });

    const assigned = await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
      costCeilingUsd: 1.25,
      retryPolicy: 'exponential',
      maxAttempts: 3,
    });
    expect(assigned?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      costCeilingUsd: 1.25,
      retryPolicy: 'exponential',
    });

    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: task!.task.id,
      agentId: 'worker-econ',
      status: 'running',
    });
    expect(claimed?.task.assignment).toMatchObject({
      costCeilingUsd: 1.25,
      retryPolicy: 'exponential',
      maxAttempts: 3,
      role: 'implementer',
    });

    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'running',
      subagentId: 'sub-econ',
      runTaskId: 'run-econ',
      lastFailureKind: 'tool_timeout',
      costCeilingUsd: 2,
      retryPolicy: 'incremental',
    });

    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'running',
      subagentId: 'sub-econ',
      runTaskId: 'run-econ',
      costCeilingUsd: 2,
      retryPolicy: 'incremental',
      maxAttempts: 3,
      lastFailureKind: 'tool_timeout',
    });
  });

  it('exposes cost ceiling and retry policy through the kanban tool and assignmentForTaskCreate', async () => {
    const board = await createBoard(tmpDir, { title: 'Tool cost/retry board' });
    const createResult = await kanbanTool.execute(
      {
        action: 'add_task',
        boardId: board.id,
        title: 'Tool routed work',
        role: 'implementer',
        provider: 'openai',
        model: 'gpt-5',
        tools: ['bash'],
        allowedCapabilities: ['fs.write'],
        costCeilingUsd: 0.5,
        retryPolicy: 'incremental',
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );

    expect(createResult).toMatchObject({ ok: true });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      costCeilingUsd: 0.5,
      retryPolicy: 'incremental',
      role: 'implementer',
    });
  });
});
