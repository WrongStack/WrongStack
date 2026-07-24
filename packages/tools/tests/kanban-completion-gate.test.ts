import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { addCheckToTask, addTask, createBoard, getBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

describe('kanban tool — universal completion gate', () => {
  let dir: string;

  beforeEach(async () => {
    delete process.env.WRONGSTACK_KANBAN_GATE;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-gate-'));
  });

  afterEach(async () => {
    delete process.env.WRONGSTACK_KANBAN_GATE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ projectRoot: dir }) as unknown as Context;

  async function seedTask(opts: {
    gate?: 'strict' | 'soft' | 'off';
    checkStatus?: 'pending' | 'passed' | 'failed';
  }) {
    const board = await createBoard(dir, {
      title: 'Tool gate board',
      ...(opts.gate ? { completionGate: { enforcement: opts.gate } } : {}),
    });
    const added = await addTask(dir, board.id, { title: 'Gated tool task' });
    if (opts.checkStatus) {
      await addCheckToTask(dir, board.id, added!.task.id, {
        description: 'Reviewer confirmed the change',
        type: 'manual',
        status: opts.checkStatus,
      });
    }
    return { boardId: board.id, taskId: added!.task.id };
  }

  it('mark_assignment completed finalizes through the gate and reports it', async () => {
    const { boardId, taskId } = await seedTask({ gate: 'soft', checkStatus: 'passed' });
    const result = await kanbanTool.execute(
      { action: 'mark_assignment', boardId, taskId, assignmentStatus: 'completed' },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(true);
    expect(result.gate).toMatchObject({ enforcement: 'soft', allowed: true, verdict: 'passed' });
    expect(result.task?.status).toBe('completed');
    expect(result.task?.verificationReport?.verdict).toBe('passed');
    expect(result.message).toContain('Completion gate passed');
  });

  it('strict gate parks the task in review with actionable issues', async () => {
    const { boardId, taskId } = await seedTask({ gate: 'strict', checkStatus: 'pending' });
    const result = await kanbanTool.execute(
      { action: 'mark_assignment', boardId, taskId, assignmentStatus: 'completed' },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.gate?.allowed).toBe(false);
    expect(result.gate?.enforcement).toBe('strict');
    expect(result.task?.status).toBe('review');
    expect(result.message).toContain('BLOCKED');
    expect((result.gate?.issues ?? []).length).toBeGreaterThan(0);
  });

  it('gate off completes directly without a verification run', async () => {
    const { boardId, taskId } = await seedTask({ gate: 'off' });
    const result = await kanbanTool.execute(
      { action: 'mark_assignment', boardId, taskId, assignmentStatus: 'completed' },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(true);
    const board = await getBoard(dir, boardId);
    const task = board?.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe('completed');
    expect(task?.verificationReport).toBeUndefined();
  });

  it('WRONGSTACK_KANBAN_GATE applies only when the board has no explicit policy', async () => {
    process.env.WRONGSTACK_KANBAN_GATE = 'strict';
    const { boardId, taskId } = await seedTask({ checkStatus: 'pending' });
    const result = await kanbanTool.execute(
      { action: 'mark_assignment', boardId, taskId, assignmentStatus: 'completed' },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.gate?.enforcement).toBe('strict');
    expect(result.task?.status).toBe('review');

    // Explicit board policy wins over the env fallback.
    const explicit = await seedTask({ gate: 'soft', checkStatus: 'pending' });
    const softResult = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId: explicit.boardId,
        taskId: explicit.taskId,
        assignmentStatus: 'completed',
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(softResult.gate?.enforcement).toBe('soft');
    expect(softResult.task?.status).toBe('completed');
  });

  it('create_board accepts atomicity and gate policy fields', async () => {
    const created = await kanbanTool.execute(
      {
        action: 'create_board',
        title: 'Policy board',
        atomicityMode: 'enforce',
        atomicityDecomposition: 'propose',
        gateEnforcement: 'strict',
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(created.ok).toBe(true);
    expect(created.board?.atomicity).toEqual({ mode: 'enforce', decomposition: 'propose' });
    expect(created.board?.completionGate).toEqual({ enforcement: 'strict' });
  });
});
