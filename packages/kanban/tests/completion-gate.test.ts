import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateDefinitionOfDone } from '../src/manager/lifecycle.js';
import { readKanbanEvents } from '../src/storage.js';
import type { KanbanBoard, KanbanCheckStatus } from '../src/types.js';
import { resolveGateEnforcement } from '../src/verification/completion-gate.js';
import {
  addCheckToTask,
  addTask,
  assignTask,
  createBoard,
  enforceCompletionGate,
  finalizeTaskCompletion,
  getBoard,
  updateTaskAssignment,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-gate-'));
});

async function boardWithTask(opts: {
  gate?: 'strict' | 'soft' | 'off';
  checkStatus?: KanbanCheckStatus;
  checks?: boolean;
}) {
  const board = await createBoard(tmpDir, {
    title: 'Gate board',
    ...(opts.gate ? { completionGate: { enforcement: opts.gate } } : {}),
  });
  const added = await addTask(tmpDir, board.id, { title: 'Gated task' });
  if (opts.checks !== false) {
    await addCheckToTask(tmpDir, board.id, added!.task.id, {
      description: 'Manually confirmed by reviewer',
      type: 'manual',
      status: opts.checkStatus ?? 'pending',
    });
  }
  await assignTask(tmpDir, board.id, added!.task.id, { agentId: 'worker' });
  await updateTaskAssignment(tmpDir, board.id, added!.task.id, { status: 'completed' });
  return { boardId: board.id, taskId: added!.task.id };
}

describe('resolveGateEnforcement', () => {
  it('defaults legacy boards to soft and managed boards to strict', () => {
    const legacy = { lifecycle: undefined, completionGate: undefined } as unknown as KanbanBoard;
    expect(resolveGateEnforcement(legacy)).toBe('soft');
    const managed = { lifecycle: { mode: 'managed' } } as unknown as KanbanBoard;
    expect(resolveGateEnforcement(managed)).toBe('strict');
  });

  it('honors explicit configuration, except off on managed boards', () => {
    const legacyOff = { completionGate: { enforcement: 'off' } } as unknown as KanbanBoard;
    expect(resolveGateEnforcement(legacyOff)).toBe('off');
    const managedOff = {
      lifecycle: { mode: 'managed' },
      completionGate: { enforcement: 'off' },
    } as unknown as KanbanBoard;
    expect(resolveGateEnforcement(managedOff)).toBe('strict');
    const managedSoft = {
      lifecycle: { mode: 'managed' },
      completionGate: { enforcement: 'soft' },
    } as unknown as KanbanBoard;
    expect(resolveGateEnforcement(managedSoft)).toBe('soft');
  });
});

describe('enforceCompletionGate', () => {
  it('skips entirely when enforcement is off', async () => {
    const { boardId, taskId } = await boardWithTask({ gate: 'off' });
    const gate = await enforceCompletionGate(tmpDir, boardId, taskId);
    expect(gate).toMatchObject({ allowed: true, enforcement: 'off', verdict: 'skipped' });
    expect(gate.report).toBeUndefined();
  });

  it('blocks in strict mode when a criterion is unresolved', async () => {
    const { boardId, taskId } = await boardWithTask({ gate: 'strict', checkStatus: 'pending' });
    const gate = await enforceCompletionGate(tmpDir, boardId, taskId);
    expect(gate.allowed).toBe(false);
    expect(gate.enforcement).toBe('strict');
    expect(gate.report).toBeDefined();
  });

  it('strict mode requires at least one criterion; soft mode does not', async () => {
    const strict = await boardWithTask({ gate: 'strict', checks: false });
    const strictGate = await enforceCompletionGate(tmpDir, strict.boardId, strict.taskId);
    expect(strictGate.allowed).toBe(false);
    expect(strictGate.issues.some((issue) => issue.field === 'successCriteria')).toBe(true);

    const soft = await boardWithTask({ gate: 'soft', checks: false });
    const softGate = await enforceCompletionGate(tmpDir, soft.boardId, soft.taskId);
    expect(softGate.allowed).toBe(true);
    expect(softGate.verdict).toBe('passed');
  });

  it('does not allow a caller override to disable the gate on a managed board', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Managed gate board',
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    const added = await addTask(tmpDir, board.id, {
      title: 'Managed task',
      description: 'Completion gate enforcement test card.',
    });

    const gate = await enforceCompletionGate(tmpDir, board.id, added!.task.id, {
      enforcement: 'off',
    });

    expect(gate.enforcement).toBe('strict');
    expect(gate.verdict).not.toBe('skipped');
    expect(gate.allowed).toBe(false);
  });
});

describe('finalizeTaskCompletion', () => {
  it('completes and emits task.verified when the gate passes', async () => {
    const { boardId, taskId } = await boardWithTask({ gate: 'strict', checkStatus: 'passed' });
    const result = await finalizeTaskCompletion(tmpDir, boardId, taskId);
    expect(result?.gate.allowed).toBe(true);
    expect(result?.task.status).toBe('completed');
    expect(result?.task.completedAt).toBeDefined();
    expect(result?.task.verificationReport?.verdict).toBe('passed');

    const events = await readKanbanEvents(tmpDir, boardId);
    expect(events.some((event) => event.type === 'task.verified')).toBe(true);
    expect(events.some((event) => event.type === 'task.completion.gate_pending')).toBe(true);
  });

  it('parks in review with the report and emits gate_blocked on strict denial', async () => {
    const { boardId, taskId } = await boardWithTask({ gate: 'strict', checkStatus: 'pending' });
    const result = await finalizeTaskCompletion(tmpDir, boardId, taskId);
    expect(result?.gate.allowed).toBe(false);
    expect(result?.task.status).toBe('review');
    expect(result?.task.completedAt).toBeUndefined();
    expect(result?.task.verificationReport).toBeDefined();

    const events = await readKanbanEvents(tmpDir, boardId);
    expect(events.some((event) => event.type === 'task.completion.gate_blocked')).toBe(true);
  });

  it('completes anyway but emits gate_soft_failed on soft failure', async () => {
    const { boardId, taskId } = await boardWithTask({ gate: 'soft', checkStatus: 'failed' });
    const result = await finalizeTaskCompletion(tmpDir, boardId, taskId);
    expect(result?.gate.allowed).toBe(false);
    expect(result?.task.status).toBe('completed');
    expect(result?.task.completedAt).toBeDefined();
    expect(result?.task.verificationReport?.verdict).toBe('failed');

    const events = await readKanbanEvents(tmpDir, boardId);
    expect(events.some((event) => event.type === 'task.completion.gate_soft_failed')).toBe(true);
  });

  it('persists report, refreshed criteria, and status in one revision bump', async () => {
    const { boardId, taskId } = await boardWithTask({ gate: 'soft', checkStatus: 'passed' });
    const before = await getBoard(tmpDir, boardId);
    const result = await finalizeTaskCompletion(tmpDir, boardId, taskId);
    const after = await getBoard(tmpDir, boardId);
    expect((after?.revision ?? 0) - (before?.revision ?? 0)).toBe(1);
    expect(result?.task.successCriteria?.[0]?.checkedAt).toBe(
      result?.task.verificationReport?.completedAt,
    );
  });

  it('returns null for an unknown task', async () => {
    const board = await createBoard(tmpDir, { title: 'Empty' });
    expect(await finalizeTaskCompletion(tmpDir, board.id, 'missing')).toBeNull();
  });
});

describe('validateDefinitionOfDone parity', () => {
  it('matches the managed Done rules for atomic tasks', async () => {
    const board = await createBoard(tmpDir, { title: 'DoD' });
    const added = await addTask(tmpDir, board.id, { title: 'Atomic parent', atomic: true });
    const task = (await getBoard(tmpDir, board.id))!.tasks.find((t) => t.id === added!.task.id)!;
    const issues = validateDefinitionOfDone(task);
    expect(issues.some((issue) => issue.field === 'verificationReport')).toBe(true);
    expect(issues.some((issue) => issue.field === 'successCriteria')).toBe(true);
  });
});
