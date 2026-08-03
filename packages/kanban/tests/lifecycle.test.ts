import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanTask } from '../src/types.js';
import {
  KANBAN_AGENT_STAGES,
  KanbanLifecycleError,
  adoptManagedLifecycle,
  createManagedLifecyclePolicy,
  initializeManagedTaskLifecycle,
  lifecycleStageForColumn,
  repairManagedTaskProjection,
  validateManagedLifecyclePolicy,
  validateManagedTaskTransition,
} from '../src/manager/lifecycle.js';
import {
  addTask,
  createBoard,
  getBoard,
  transitionTask,
  updateTask,
  updateTaskAssignment,
} from '../src/manager.js';
import { writeBoard } from '../src/storage.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-life-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

function nowIso(): string {
  return '2026-07-17T00:00:00.000Z';
}

function emptyBoard(columns: KanbanBoard['columns']): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Test',
    columns,
    tasks: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 1,
  };
}

const COLS = [
  { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
  { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
  { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
  { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
  { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
];

const policy = createManagedLifecyclePolicy();
const managedBoard = () => ({ ...emptyBoard(COLS), lifecycle: policy });

function card(overrides: Partial<KanbanTask> & { id: string }): KanbanTask {
  return {
    title: overrides.id,
    columnId: overrides.columnId ?? 'backlog',
    order: overrides.order ?? 0,
    priority: overrides.priority ?? 'medium',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? nowIso(),
    updatedAt: overrides.updatedAt ?? nowIso(),
    ...overrides,
  };
}

// ── createManagedLifecyclePolicy ─────────────────────────────────────

describe('createManagedLifecyclePolicy', () => {
  it('applies partial column overrides while keeping defaults for the rest', () => {
    const custom = createManagedLifecyclePolicy({ running: 'wip', done: 'ship' });
    expect(custom.columns).toEqual({
      backlog: 'backlog',
      todo: 'todo',
      running: 'wip',
      review: 'review',
      done: 'ship',
    });
    expect(custom.mode).toBe('managed');
  });
});

// ── lifecycleStageForColumn ──────────────────────────────────────────

describe('lifecycleStageForColumn', () => {
  it('returns null for a legacy (non-managed) board', () => {
    expect(lifecycleStageForColumn(emptyBoard(COLS), 'backlog')).toBeNull();
  });
  it('returns the stage whose column matches', () => {
    const stage = lifecycleStageForColumn(managedBoard(), 'in-progress');
    expect(stage).toBe('running');
  });
  it('returns null when the column is not a lifecycle column', () => {
    expect(lifecycleStageForColumn(managedBoard(), 'nope')).toBeNull();
  });
});

// ── adoptManagedLifecycle ───────────────────────────────────────────

describe('adoptManagedLifecycle', () => {
  it('atomically adopts current columns without moving legacy cards', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Legacy',
      columns: COLS,
      tasks: [
        { title: 'Queued', columnId: 'todo', status: 'pending' },
        { title: 'Active', columnId: 'in-progress', status: 'in_progress' },
        { title: 'Shipped', columnId: 'done', status: 'archived' },
      ],
    });
    const originalColumns = board.tasks.map((task) => task.columnId);

    const adopted = await adoptManagedLifecycle(tmpDir, board.id, {
      columns: policy.columns,
      actor: 'migration-agent',
      comment: 'Adopt existing project stages without moving cards.',
    });

    expect(adopted?.lifecycle).toMatchObject({
      mode: 'managed',
      columns: policy.columns,
      adoptedBy: 'migration-agent',
      adoptionComment: 'Adopt existing project stages without moving cards.',
    });
    expect(adopted?.lifecycle?.adoptedAt).toBe(adopted?.updatedAt);
    expect(adopted?.tasks.map((task) => task.columnId)).toEqual(originalColumns);
    expect(adopted?.tasks.map((task) => task.status)).toEqual(['ready', 'in_progress', 'completed']);
    expect(adopted?.tasks.map((task) => task.lifecycle?.currentStage)).toEqual([
      'todo',
      'running',
      'done',
    ]);
    expect(adopted?.tasks.every((task) => task.lifecycle?.history[0]?.action === 'Managed lifecycle adopted')).toBe(true);
    expect(adopted?.tasks.every((task) => task.updatedAt === task.lifecycle?.stageEnteredAt)).toBe(true);
  });

  it('persists adoption audit metadata on a taskless board', async () => {
    const board = await createBoard(tmpDir, { title: 'Empty legacy', columns: COLS });

    const adopted = await adoptManagedLifecycle(tmpDir, board.id, {
      columns: policy.columns,
      actor: 'migration-agent',
      comment: 'Adopt an empty legacy board.',
    });

    expect(adopted?.tasks).toEqual([]);
    expect(adopted?.lifecycle).toMatchObject({
      mode: 'managed',
      adoptedBy: 'migration-agent',
      adoptionComment: 'Adopt an empty legacy board.',
    });
    expect(adopted?.lifecycle?.adoptedAt).toBe(adopted?.updatedAt);
  });

  it('rejects an unmapped legacy column without mutating the board', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Legacy',
      columns: [...COLS, { id: 'extra', title: 'Extra', order: 5, wipLimit: 0 }],
      tasks: [{ title: 'Unmapped', columnId: 'extra' }],
    });

    await expect(
      adoptManagedLifecycle(tmpDir, board.id, {
        columns: policy.columns,
        actor: 'migration-agent',
        comment: 'Invalid migration.',
      }),
    ).rejects.toThrow(/Unmapped legacy columns: extra/);

    const unchanged = await getBoard(tmpDir, board.id);
    expect(unchanged?.lifecycle).toBeUndefined();
    expect(unchanged?.tasks[0]?.columnId).toBe('extra');
    expect(unchanged?.tasks.every((task) => task.lifecycle === undefined)).toBe(true);
  });

  it('skips tasks that already have lifecycle metadata during first adoption — same mapping', async () => {
    const at = nowIso();
    const board = await createBoard(tmpDir, {
      title: 'Partial lifecycle',
      columns: COLS,
      tasks: [
        { title: 'Fresh', columnId: 'todo', status: 'pending' },
        { title: 'Has-lifecycle', columnId: 'in-progress', status: 'in_progress' },
      ],
    });

    // Manually set lifecycle on one task before adoption. The board itself
    // does NOT have a managed lifecycle (simulates a partial migration or
    // externally imported task with stale lifecycle metadata).
    board.tasks[1]!.lifecycle = {
      currentStage: 'running',
      stageEnteredAt: at,
      history: [{ to: 'running', at, actor: 'pre-adoption', action: 'Pre-adoption init.' }],
    };
    await writeBoard(tmpDir, board);

    const adopted = await adoptManagedLifecycle(tmpDir, board.id, {
      columns: policy.columns,
      actor: 'migration-agent',
      comment: 'Adopt board with one pre-lifecycled task.',
    });

    // The task with pre-existing lifecycle kept it unchanged (skip path)
    expect(adopted!.tasks[1]?.lifecycle?.currentStage).toBe('running');
    expect(adopted!.tasks[1]?.lifecycle?.stageEnteredAt).toBe(at);
    expect(adopted!.tasks[1]?.lifecycle?.history).toHaveLength(1);

    // The fresh task got lifecycle initialized
    expect(adopted!.tasks[0]?.lifecycle?.currentStage).toBe('todo');
  });

  it('rejects adoption when a task has pre-existing lifecycle that mismatches its column', async () => {
    const at = nowIso();
    const board = await createBoard(tmpDir, {
      title: 'Staged mismatch',
      columns: COLS,
      tasks: [{ title: 'Mis-staged', columnId: 'backlog', status: 'pending' }],
    });

    // Give the task lifecycle metadata that says 'done', but the task sits
    // in 'backlog' column. Under default mapping backlog→backlog, the
    // expected stage for the backlog column is 'backlog' — but the task
    // claims it is 'done'. This must be caught by the skip-path consistency
    // check at lifecycle.ts:152-166.
    board.tasks[0]!.lifecycle = {
      currentStage: 'done',
      stageEnteredAt: at,
      history: [{ to: 'done', at, actor: 'pre-adoption', action: 'Pre-adoption init.' }],
    };
    await writeBoard(tmpDir, board);

    await expect(
      adoptManagedLifecycle(tmpDir, board.id, {
        columns: policy.columns,
        actor: 'migration-agent',
        comment: 'Adopt with mismatched lifecycle.',
      }),
    ).rejects.toThrow(KanbanLifecycleError);

    // Board unchanged
    const unchanged = await getBoard(tmpDir, board.id);
    expect(unchanged?.lifecycle).toBeUndefined();
    expect(unchanged?.tasks[0]?.lifecycle?.currentStage).toBe('done');
  });
});

// ── repairManagedTaskProjection ─────────────────────────────────────

describe('repairManagedTaskProjection', () => {
  it('restores column/status from authoritative lifecycle history and records the repair', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Managed drift',
      columns: COLS,
      lifecycle: policy,
    });
    const added = await addTask(tmpDir, board.id, { title: 'Drifted', description: 'Drift repair test card.' });
    await updateTask(tmpDir, board.id, added!.task.id, {
      description: 'Drift repair test.',
      dueDate: '2026-08-01T00:00:00.000Z',
      assignee: 'agent-1',
      labels: ['repair'],
      childTaskIds: ['child-1'],
      successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'passed' }],
    });
    await transitionTask(tmpDir, board.id, added!.task.id, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Planned.',
    });
    const drifted = await getBoard(tmpDir, board.id);
    const task = drifted!.tasks.find((candidate) => candidate.id === added!.task.id)!;
    const stageEnteredAt = task.lifecycle!.stageEnteredAt;
    task.columnId = 'done';
    task.status = 'completed';
    await updateTask(tmpDir, board.id, task.id, { verificationReport: null });
    // updateTask correctly refuses managed projection edits, so introduce drift
    // through the universal finalizer seam that this repair API is designed to recover.
    const boardPath = path.join(tmpDir, '.wrongstack', 'kanbans', `${board.id}.json`);
    const raw = JSON.parse(await fs.readFile(boardPath, 'utf8')) as KanbanBoard;
    const rawTask = raw.tasks.find((candidate) => candidate.id === task.id)!;
    rawTask.columnId = 'done';
    rawTask.status = 'completed';
    await fs.writeFile(boardPath, JSON.stringify(raw, null, 2));

    const repaired = await repairManagedTaskProjection(tmpDir, board.id, task.id, {
      actor: 'repair-agent',
      comment: 'Restore projection from lifecycle history.',
    });

    expect(repaired?.task).toMatchObject({ columnId: 'todo', status: 'ready' });
    expect(repaired?.task.lifecycle?.currentStage).toBe('todo');
    expect(repaired?.task.lifecycle?.stageEnteredAt).toBe(stageEnteredAt);
    expect(repaired?.task.updatedAt).not.toBe(stageEnteredAt);
    expect(repaired?.task.lifecycle?.history.at(-1)?.at).toBe(repaired?.task.updatedAt);
    expect(repaired?.task.lifecycle?.history.at(-1)).toMatchObject({
      from: 'todo',
      to: 'todo',
      actor: 'repair-agent',
      action: 'Managed projection repaired',
    });
  });
});

// ── validateManagedLifecyclePolicy ───────────────────────────────────

describe('validateManagedLifecyclePolicy', () => {
  it('returns no issues for a valid managed board', () => {
    expect(validateManagedLifecyclePolicy(managedBoard())).toEqual([]);
  });
  it('returns no issues for a legacy board', () => {
    expect(validateManagedLifecyclePolicy(emptyBoard(COLS))).toEqual([]);
  });
  it('flags when configured columns are not distinct', () => {
    const b = managedBoard();
    b.lifecycle = { mode: 'managed', columns: { backlog: 'backlog', todo: 'backlog', running: 'in-progress', review: 'review', done: 'done' } };
    const issues = validateManagedLifecyclePolicy(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('managed-policy-invalid');
    expect(issues[0]!.message).toContain('distinct');
  });
  it('flags when configured columns do not exist on the board', () => {
    const b = managedBoard();
    b.lifecycle = { mode: 'managed', columns: { backlog: 'ghost', todo: 'todo', running: 'in-progress', review: 'review', done: 'done' } };
    const issues = validateManagedLifecyclePolicy(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('ghost');
  });
});

// ── initializeManagedTaskLifecycle ───────────────────────────────────

describe('initializeManagedTaskLifecycle', () => {
  it('is a no-op on a legacy board', () => {
    const b = emptyBoard(COLS);
    const t = card({ id: 't1' });
    expect(() => initializeManagedTaskLifecycle(b, t)).not.toThrow();
    expect(t.lifecycle).toBeUndefined();
  });
  it('throws KanbanLifecycleError when the managed policy itself is invalid', () => {
    const b = managedBoard();
    b.lifecycle = { mode: 'managed', columns: { backlog: 'backlog', todo: 'backlog', running: 'in-progress', review: 'review', done: 'done' } };
    expect(() => initializeManagedTaskLifecycle(b, card({ id: 't1' }))).toThrow(KanbanLifecycleError);
  });
  it('throws transition-skipped when the card is created outside Backlog', () => {
    const b = managedBoard();
    const t = card({ id: 't1', columnId: 'todo' });
    let caught: KanbanLifecycleError | undefined;
    try {
      initializeManagedTaskLifecycle(b, t);
    } catch (err) {
      caught = err as KanbanLifecycleError;
    }
    expect(caught).toBeInstanceOf(KanbanLifecycleError);
    expect(caught!.issues[0]!.code).toBe('transition-skipped');
  });
  it('initializes a backlog card with stage and history', () => {
    const b = managedBoard();
    const t = card({ id: 't1', columnId: 'backlog', createdAt: '2026-07-17T00:00:00.000Z' });
    initializeManagedTaskLifecycle(b, t);
    expect(t.lifecycle?.currentStage).toBe('backlog');
    expect(t.status).toBe('pending');
    expect(t.lifecycle?.history[0]).toMatchObject({ to: 'backlog', actor: 'kanban-agent' });
  });
});

// ── validateManagedTaskTransition ────────────────────────────────────

describe('validateManagedTaskTransition', () => {
  it('requires a managed board (rejects legacy)', () => {
    const b = emptyBoard(COLS);
    const t = card({ id: 't1' });
    const issues = validateManagedTaskTransition(b, t, { to: 'todo', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'managed-policy-invalid' && i.message.includes('managed board'))).toBe(true);
  });
  it('propagates managed policy issues', () => {
    const b = managedBoard();
    b.lifecycle = { mode: 'managed', columns: { backlog: 'backlog', todo: 'backlog', running: 'in-progress', review: 'review', done: 'done' } };
    const t = card({ id: 't1' });
    const issues = validateManagedTaskTransition(b, t, { to: 'todo', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'managed-policy-invalid')).toBe(true);
  });
  it('flags a column whose stage is not in the managed lifecycle', () => {
    // Add a custom column that is not one of the 5 lifecycle columns; card sits there.
    const cols = [...COLS, { id: 'extra', title: 'Extra', order: 5, wipLimit: 0 }];
    const b = { ...emptyBoard(cols), lifecycle: policy };
    const t = card({ id: 't1', columnId: 'extra', lifecycle: { currentStage: 'todo', stageEnteredAt: nowIso(), history: [] } });
    const issues = validateManagedTaskTransition(b, t, { to: 'todo', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'stage-mismatch' && i.message.includes('outside the managed lifecycle'))).toBe(true);
  });
  it('flags a stage mismatch between lifecycle.currentStage and the column', () => {
    const b = managedBoard();
    // Column is 'todo' (stage: todo) but lifecycle says 'running'
    const t = card({ id: 't1', columnId: 'todo', lifecycle: { currentStage: 'running', stageEnteredAt: nowIso(), history: [] } });
    const issues = validateManagedTaskTransition(b, t, { to: 'todo', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'stage-mismatch' && i.message.includes('lifecycle says'))).toBe(true);
  });
  it('rejects an already-done card transitioning anywhere', () => {
    const b = managedBoard();
    const t = card({
      id: 't1',
      columnId: 'done',
      status: 'completed',
      lifecycle: { currentStage: 'done', stageEnteredAt: nowIso(), history: [] },
    });
    const issues = validateManagedTaskTransition(b, t, { to: 'review', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'transition-skipped' && i.message.includes('one stage at a time'))).toBe(true);
  });
  it('demands review evidence when advancing to review', () => {
    const b = managedBoard();
    const t = card({ id: 't1', columnId: 'in-progress', lifecycle: { currentStage: 'running', stageEnteredAt: nowIso(), history: [] } });
    const issues = validateManagedTaskTransition(b, t, { to: 'review', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'review-evidence-missing')).toBe(true);
  });
});

// ── End-to-end transition flows for full validation paths ─────────────

describe('end-to-end managed lifecycle validation paths', () => {
  async function managedBoardWithCard() {
    const board = await createBoard(tmpDir, {
      title: 'Managed',
      lifecycle: {
        mode: 'managed',
        columns: { backlog: 'backlog', todo: 'todo', running: 'in-progress', review: 'review', done: 'done' },
      },
    });
    const created = await addTask(tmpDir, board.id, { title: 'Card', description: 'Test card for lifecycle validation.' });
    return { board, cardId: created!.task.id };
  }

  const fullDetails = () => ({
    description: 'A complete card with every required detail.',
    dueDate: '2026-08-01T00:00:00.000Z',
    assignee: 'agent-1',
    labels: ['release'],
    childTaskIds: ['child-1'],
    successCriteria: [{ id: 'c1', description: 'All green', type: 'manual' as const, status: 'pending' as const }],
    assignment: {
      status: 'running' as const,
      agentId: 'agent-1',
      leaseId: 'lease-1',
      claimedAt: '2026-07-17T00:00:00.000Z',
      heartbeatAt: '2026-07-17T00:00:00.000Z',
      leaseExpiresAt: '2026-07-18T00:00:00.000Z',
    },
  });

  it('requires every required detail when moving forward (each detail rule fires)', async () => {
    const { board } = await managedBoardWithCard();
    const added = await addTask(tmpDir, board.id, { title: 'bare card', description: 'A bare card missing most required details.' });
    // Description is present, so the first missing detail is assignee
    await expect(
      transitionTask(tmpDir, board.id, added!.task.id, { to: 'todo', actor: 'agent', comment: 'go' }),
    ).rejects.toThrow('Assign an owner');
  });

  it('progresses a fully-detailed card through todo -> running -> review with evidence', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, fullDetails());

    await transitionTask(tmpDir, board.id, cardId, { to: 'todo', actor: 'agent-1', comment: 'Planned.' });
    await transitionTask(tmpDir, board.id, cardId, { to: 'running', actor: 'agent-1', comment: 'Working.' });
    // Review requires a persisted implementation result (assignment.lastResult)
    // AND an evidence attachment — set the result via assignment update first.
    await updateTaskAssignment(tmpDir, board.id, cardId, {
      status: 'completed',
      lastResult: 'Implementation complete; all tests green.',
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'review',
      actor: 'agent-1',
      comment: 'Done.',
      attachment: { url: 'artifact://build', type: 'file' },
    });
  });

  it('rejects review transition with an attachment whose URL is blank', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, fullDetails());
    await transitionTask(tmpDir, board.id, cardId, { to: 'todo', actor: 'agent-1', comment: 'Planned.' });
    await transitionTask(tmpDir, board.id, cardId, { to: 'running', actor: 'agent-1', comment: 'Working.' });
    await updateTaskAssignment(tmpDir, board.id, cardId, {
      status: 'completed',
      lastResult: 'Implementation complete; all tests green.',
    });
    // Empty/whitespace URL is treated as missing evidence → Review rejected.
    await expect(
      transitionTask(tmpDir, board.id, cardId, {
        to: 'review',
        actor: 'agent-1',
        comment: 'Done.',
        attachment: { url: '   ', type: 'file' },
      }),
    ).rejects.toThrow('Review requires a persisted implementation result and evidence attachment');
  });

  it('rejects review transition with no attachment at all', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, fullDetails());
    await transitionTask(tmpDir, board.id, cardId, { to: 'todo', actor: 'agent-1', comment: 'Planned.' });
    await transitionTask(tmpDir, board.id, cardId, { to: 'running', actor: 'agent-1', comment: 'Working.' });
    await updateTaskAssignment(tmpDir, board.id, cardId, {
      status: 'completed',
      lastResult: 'Implementation complete; all tests green.',
    });
    await expect(
      transitionTask(tmpDir, board.id, cardId, {
        to: 'review',
        actor: 'agent-1',
        comment: 'Done.',
        // attachment intentionally omitted
      }),
    ).rejects.toThrow('Review requires a persisted implementation result and evidence attachment');
  });

  it('rejects done transition with a blank-URL attachment even with reviewer action text', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, {
      ...fullDetails(),
      successCriteria: [
        { id: 'c1', description: 'All green', type: 'manual', status: 'passed' },
      ],
    });
    await transitionTask(tmpDir, board.id, cardId, { to: 'todo', actor: 'agent-1', comment: 'Planned.' });
    await transitionTask(tmpDir, board.id, cardId, { to: 'running', actor: 'agent-1', comment: 'Working.' });
    await updateTaskAssignment(tmpDir, board.id, cardId, {
      status: 'completed',
      lastResult: 'Implementation complete; all tests green.',
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'review',
      actor: 'agent-1',
      comment: 'Done.',
      attachment: { url: 'artifact://build', type: 'file' },
    });
    // Blank URL must not satisfy the Done evidence guard.
    await expect(
      transitionTask(tmpDir, board.id, cardId, {
        to: 'done',
        actor: 'reviewer-1',
        comment: 'Ship it.',
        action: 'approved',
        attachment: { url: '', type: 'url' },
      }),
    ).rejects.toThrow('Done requires reviewer action text and a persisted review attachment');
  });

  it('rejects a direct lifecycle mutation via updateTask on a managed board', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await expect(
      updateTask(tmpDir, board.id, cardId, {
        lifecycle: { currentStage: 'done', stageEnteredAt: nowIso(), history: [] } as never,
      }),
    ).rejects.toThrow('immutable outside transitionTask');
  });
});

// ── Finite decomposition: atomic leaves vs composite parents ────────

describe('finite managed decomposition', () => {
  async function managedBoardWithCard() {
    const board = await createBoard(tmpDir, {
      title: 'Managed',
      lifecycle: {
        mode: 'managed',
        columns: { backlog: 'backlog', todo: 'todo', running: 'in-progress', review: 'review', done: 'done' },
      },
    });
    const created = await addTask(tmpDir, board.id, { title: 'Leaf', description: 'Atomic leaf card.' });
    return { board, cardId: created!.task.id };
  }

  const leafDetails = () => ({
    description: 'A fully specified atomic leaf.',
    dueDate: '2026-08-01T00:00:00.000Z',
    assignee: 'agent-1',
    labels: ['leaf'],
    successCriteria: [{ id: 'c1', description: 'All green', type: 'manual' as const, status: 'pending' as const }],
  });

  it('allows a childless atomic leaf to progress from Backlog to Todo', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, leafDetails());
    // Must not throw — no childTaskIds, but task.atomic is not true.
    await transitionTask(tmpDir, board.id, cardId, { to: 'todo', actor: 'agent-1', comment: 'Planned.' });
  });

  it('rejects a composite parent (atomic=true) without children from progressing', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, { ...leafDetails(), atomic: true });
    await expect(
      transitionTask(tmpDir, board.id, cardId, { to: 'todo', actor: 'agent-1', comment: 'Planned.' }),
    ).rejects.toThrow('Break the work into at least one persisted subtask');
  });

  it('composite parent with children still cannot reach Done without verification report', async () => {
    const { board, cardId } = await managedBoardWithCard();
    // Add a child task
    const child = await addTask(tmpDir, board.id, { title: 'Child', description: 'Child task.' });
    await updateTask(tmpDir, board.id, cardId, {
      ...leafDetails(),
      atomic: true,
      childTaskIds: [child!.task.id],
      successCriteria: [{ id: 'c1', description: 'All green', type: 'manual' as const, status: 'passed' as const }],
    });
    // Parent can progress to Todo (has children).
    await transitionTask(tmpDir, board.id, cardId, { to: 'todo', actor: 'agent-1', comment: 'Planned.' });
    // But cannot reach Done because the atomic parent lacks a verification report.
    // The parent-child completion gate is independently covered by phase4-parent-child.test.ts.
    // First move to running, review, then try done.
    await updateTask(tmpDir, board.id, cardId, {
      assignment: {
        status: 'running' as const,
        agentId: 'agent-1',
        leaseId: 'lease-1',
        claimedAt: '2026-07-17T00:00:00.000Z',
        heartbeatAt: '2026-07-17T00:00:00.000Z',
        leaseExpiresAt: '2026-07-18T00:00:00.000Z',
      },
    });
    await transitionTask(tmpDir, board.id, cardId, { to: 'running', actor: 'agent-1', comment: 'Working.' });
    await updateTaskAssignment(tmpDir, board.id, cardId, { status: 'completed', lastResult: 'Done.' });
    await transitionTask(tmpDir, board.id, cardId, { to: 'review', actor: 'agent-1', comment: 'Review.', attachment: { url: 'artifact://x', type: 'file' } });
    await expect(
      transitionTask(tmpDir, board.id, cardId, { to: 'done', actor: 'reviewer', comment: 'Approve', action: 'approved', attachment: { url: 'artifact://y', type: 'doc' } }),
    ).rejects.toThrow('Atomic tasks require a completed verification report');
  });
});

// ── KANBAN_AGENT_STAGES sanity ───────────────────────────────────────

describe('KANBAN_AGENT_STAGES', () => {
  it('lists the five canonical stages in order', () => {
    expect([...KANBAN_AGENT_STAGES]).toEqual(['backlog', 'todo', 'running', 'review', 'done']);
  });
});
