import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard, createManagedLifecyclePolicy, getBoard } from '@wrongstack/kanban';
import {
  addCheckToTask,
  addTask,
  assignTask,
  transitionTask,
  updateTask,
} from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

/** Session that owns the board events these tests write. */
const TEST_CONTEXT_SESSION_ID = '2026-08-26/sess_01TESTTOOLSCONTEXT0000000';

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

  const ctx = () =>
    ({ eventSessionId: () => TEST_CONTEXT_SESSION_ID, projectRoot: dir }) as unknown as Context;

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

  it('managed assignment completion auto-accepts passed criteria without graph repair', async () => {
    const columns = [
      { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
      { id: 'todo', title: 'Todo', order: 1, wipLimit: 0 },
      { id: 'in-progress', title: 'Running', order: 2, wipLimit: 0 },
      { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
      { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
    ];
    const board = await createBoard(dir, {
      title: 'Managed completion board',
      columns,
      lifecycle: createManagedLifecyclePolicy(),
    });
    const added = await addTask(dir, board.id, {
      title: 'Managed task',
      description: 'Managed assignment completion regression.',
    });
    await updateTask(dir, board.id, added!.task.id, {
      description: 'Managed assignment completion regression.',
      dueDate: '2026-08-01T00:00:00.000Z',
      assignee: 'worker',
      labels: ['managed'],
      childTaskIds: ['child-1'],
      successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'passed' }],
    });
    await assignTask(dir, board.id, added!.task.id, {
      status: 'running',
      agentId: 'worker',
      leaseId: 'lease-1',
      claimedAt: '2026-07-26T00:00:00.000Z',
      heartbeatAt: '2026-07-26T00:00:00.000Z',
      leaseExpiresAt: '2026-07-27T00:00:00.000Z',
    });
    await transitionTask(dir, board.id, added!.task.id, {
      to: 'todo',
      actor: 'worker',
      comment: 'Planned.',
    });
    await transitionTask(dir, board.id, added!.task.id, {
      to: 'running',
      actor: 'worker',
      comment: 'Started.',
    });

    const result = await kanbanTool.execute(
      {
        action: 'mark_assignment',
        boardId: board.id,
        taskId: added!.task.id,
        assignmentStatus: 'completed',
        expectedLeaseId: 'lease-1',
        lastResult: 'Implementation passed.',
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    // Managed lifecycle auto-transition advances Running → Review, verifies
    // the executable criterion, and auto-accepts Review → Done. Contract Map
    // findings are audit metadata and cannot hold this lifecycle open.
    expect(result.gate).toBeUndefined();
    const after = await getBoard(dir, board.id);
    expect(after?.tasks[0]).toMatchObject({
      columnId: 'done',
      status: 'completed',
      lifecycle: { currentStage: 'done' },
      assignment: { status: 'completed', lastResult: 'Implementation passed.' },
    });
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

  // WS-023: `gateEnforcement` is a model-settable enum and `'off'` used to be
  // one of its values, so the agent whose work the gate checks could create or
  // update a board with the gate disabled — self-attestation with an extra
  // step. Tightening stays available; switching it off is a human decision
  // made through board config.
  it('ignores a gate-disabling request from the agent-facing tool', async () => {
    const created = await kanbanTool.execute(
      {
        action: 'create_board',
        title: 'Ungated attempt',
        gateEnforcement: 'off' as never,
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(created.ok).toBe(true);
    // No completionGate written at all — the board falls back to its default
    // rather than recording the agent's choice to skip verification.
    expect(created.board?.completionGate).toBeUndefined();

    const updated = await kanbanTool.execute(
      {
        action: 'update_board',
        boardId: created.board!.id,
        gateEnforcement: 'off' as never,
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(updated.ok).toBe(true);
    expect(updated.board?.completionGate).toBeUndefined();
  });

  it('still lets the agent tighten its own gate', async () => {
    const created = await kanbanTool.execute(
      { action: 'create_board', title: 'Self-tightened', gateEnforcement: 'strict' },
      ctx(),
      { signal: newSignal() },
    );
    expect(created.board?.completionGate).toEqual({ enforcement: 'strict' });
  });

  it('does not advertise "off" in the tool schema', () => {
    const properties = (
      kanbanTool.inputSchema as { properties?: Record<string, { enum?: string[] }> }
    ).properties;
    expect(properties?.['gateEnforcement']?.enum).toEqual(['strict', 'soft']);
  });
});
