import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// New-seam helpers exported via the directory convention (per memory
// `01KZTS94JCBZFAQG2HT39K8A7W`): tests import the same path the slash
// command uses (`@wrongstack/kanban/manager/lifecycle`) so a build-profile
// regression would fail tests rather than just runtime.
import { preflightManagedTransition, validateTickChecks } from '../src/manager/lifecycle/index.js';
import {
  adoptManagedLifecycle,
  createManagedLifecyclePolicy,
  initializeManagedTaskLifecycle,
  KANBAN_AGENT_STAGES,
  KanbanLifecycleError,
  lifecycleStageForColumn,
  repairManagedTaskProjection,
  validateManagedLifecyclePolicy,
  validateManagedTaskTransition,
} from '../src/manager/lifecycle.js';
import { writeBoard } from '../src/storage.js';
import type {
  KanbanBoard,
  KanbanCheck,
  KanbanTask,
  KanbanVerificationReport,
} from '../src/types.js';
import {
  addTask,
  createBoard,
  getBoard,
  mergeTasks,
  transitionTask,
  updateTask,
  updateTaskAssignment,
} from './helpers/session-manager.js';

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
    expect(adopted?.tasks.map((task) => task.status)).toEqual([
      'ready',
      'in_progress',
      'completed',
    ]);
    expect(adopted?.tasks.map((task) => task.lifecycle?.currentStage)).toEqual([
      'todo',
      'running',
      'done',
    ]);
    expect(
      adopted?.tasks.every(
        (task) => task.lifecycle?.history[0]?.action === 'Managed lifecycle adopted',
      ),
    ).toBe(true);
    expect(adopted?.tasks.every((task) => task.updatedAt === task.lifecycle?.stageEnteredAt)).toBe(
      true,
    );
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
    const added = await addTask(tmpDir, board.id, {
      title: 'Drifted',
      description: 'Drift repair test card.',
    });
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

// ── managed merge tombstones ─────────────────────────────────────────

/**
 * `mergeTasks` used to write `status = 'archived'` onto its source cards by
 * hand. On a managed board that produced a card whose status no longer
 * matched `STATUS_BY_STAGE[stage]`, which meant every later `updateTask`
 * threw (the card was uneditable) while `repairManagedTaskProjection`
 * silently reset the status and returned the merged-away card to the board.
 */
describe('managed merge tombstones', () => {
  async function mergedManagedBoard(): Promise<{
    boardId: string;
    sourceId: string;
    mergedId: string;
  }> {
    const board = await createBoard(tmpDir, {
      title: 'Managed merge',
      columns: COLS,
      lifecycle: policy,
    });
    const first = await addTask(tmpDir, board.id, {
      title: 'A',
      description: 'First source card.',
    });
    const second = await addTask(tmpDir, board.id, {
      title: 'B',
      description: 'Second source card.',
    });
    const merged = await mergeTasks(tmpDir, board.id, {
      taskIds: [first!.task.id, second!.task.id],
      title: 'Merged',
      description: 'Merged card.',
    });
    return { boardId: board.id, sourceId: first!.task.id, mergedId: merged!.task.id };
  }

  async function storedTask(boardId: string, taskId: string): Promise<KanbanTask> {
    const stored = await getBoard(tmpDir, boardId);
    return stored!.tasks.find((candidate) => candidate.id === taskId)!;
  }

  it('archives the source card where it stood and records the merge in its ledger', async () => {
    const { boardId, sourceId, mergedId } = await mergedManagedBoard();
    const source = await storedTask(boardId, sourceId);

    expect(source.status).toBe('archived');
    expect(source.mergedIntoTaskId).toBe(mergedId);
    // Stage and column stay in agreement, so `currentManagedStage` keeps
    // working on the tombstone rather than throwing stage-mismatch.
    expect(source.columnId).toBe('backlog');
    expect(source.lifecycle?.currentStage).toBe('backlog');
    expect(source.lifecycle?.history.at(-1)).toMatchObject({
      from: 'backlog',
      to: 'backlog',
      action: 'Card archived',
      comment: `Merged into ${mergedId}`,
    });
  });

  it('leaves the archived card editable instead of wedging it', async () => {
    const { boardId, sourceId } = await mergedManagedBoard();
    await updateTask(tmpDir, boardId, sourceId, { labels: ['superseded'] });
    const source = await storedTask(boardId, sourceId);
    expect(source.labels).toEqual(['superseded']);
    expect(source.status).toBe('archived');
  });

  it('still refuses to move or revive the archived card by patch', async () => {
    const { boardId, sourceId } = await mergedManagedBoard();
    await expect(updateTask(tmpDir, boardId, sourceId, { status: 'ready' })).rejects.toThrow(
      /archived/,
    );
    await expect(updateTask(tmpDir, boardId, sourceId, { columnId: 'todo' })).rejects.toThrow(
      /archived/,
    );
    expect((await storedTask(boardId, sourceId)).status).toBe('archived');
  });

  it('refuses to revive the archived card through projection repair', async () => {
    const { boardId, sourceId } = await mergedManagedBoard();
    await expect(
      repairManagedTaskProjection(tmpDir, boardId, sourceId, {
        actor: 'repair-agent',
        comment: 'Attempt to revive a merged-away card.',
      }),
    ).rejects.toThrow(/archived/);
    expect((await storedTask(boardId, sourceId)).status).toBe('archived');
  });

  it('refuses to transition the archived card back into play', async () => {
    const { boardId, sourceId } = await mergedManagedBoard();
    await expect(
      transitionTask(tmpDir, boardId, sourceId, {
        to: 'todo',
        actor: 'agent-1',
        comment: 'Try to restart merged-away work.',
      }),
    ).rejects.toThrow(/archived/);
    expect((await storedTask(boardId, sourceId)).status).toBe('archived');
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
    b.lifecycle = {
      mode: 'managed',
      columns: {
        backlog: 'backlog',
        todo: 'backlog',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    };
    const issues = validateManagedLifecyclePolicy(b);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('managed-policy-invalid');
    expect(issues[0]!.message).toContain('distinct');
  });
  it('flags when configured columns do not exist on the board', () => {
    const b = managedBoard();
    b.lifecycle = {
      mode: 'managed',
      columns: {
        backlog: 'ghost',
        todo: 'todo',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    };
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
    b.lifecycle = {
      mode: 'managed',
      columns: {
        backlog: 'backlog',
        todo: 'backlog',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    };
    expect(() => initializeManagedTaskLifecycle(b, card({ id: 't1' }))).toThrow(
      KanbanLifecycleError,
    );
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
    expect(
      issues.some(
        (i) => i.code === 'managed-policy-invalid' && i.message.includes('managed board'),
      ),
    ).toBe(true);
  });
  it('propagates managed policy issues', () => {
    const b = managedBoard();
    b.lifecycle = {
      mode: 'managed',
      columns: {
        backlog: 'backlog',
        todo: 'backlog',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    };
    const t = card({ id: 't1' });
    const issues = validateManagedTaskTransition(b, t, { to: 'todo', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'managed-policy-invalid')).toBe(true);
  });
  it('flags a column whose stage is not in the managed lifecycle', () => {
    // Add a custom column that is not one of the 5 lifecycle columns; card sits there.
    const cols = [...COLS, { id: 'extra', title: 'Extra', order: 5, wipLimit: 0 }];
    const b = { ...emptyBoard(cols), lifecycle: policy };
    const t = card({
      id: 't1',
      columnId: 'extra',
      lifecycle: { currentStage: 'todo', stageEnteredAt: nowIso(), history: [] },
    });
    const issues = validateManagedTaskTransition(b, t, { to: 'todo', actor: 'a', comment: 'c' });
    expect(
      issues.some(
        (i) => i.code === 'stage-mismatch' && i.message.includes('outside the managed lifecycle'),
      ),
    ).toBe(true);
  });
  it('flags a stage mismatch between lifecycle.currentStage and the column', () => {
    const b = managedBoard();
    // Column is 'todo' (stage: todo) but lifecycle says 'running'
    const t = card({
      id: 't1',
      columnId: 'todo',
      lifecycle: { currentStage: 'running', stageEnteredAt: nowIso(), history: [] },
    });
    const issues = validateManagedTaskTransition(b, t, { to: 'todo', actor: 'a', comment: 'c' });
    expect(
      issues.some((i) => i.code === 'stage-mismatch' && i.message.includes('lifecycle says')),
    ).toBe(true);
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
    expect(
      issues.some(
        (i) => i.code === 'transition-skipped' && i.message.includes('one stage at a time'),
      ),
    ).toBe(true);
  });
  it('demands review evidence when advancing to review', () => {
    const b = managedBoard();
    const t = card({
      id: 't1',
      columnId: 'in-progress',
      lifecycle: { currentStage: 'running', stageEnteredAt: nowIso(), history: [] },
    });
    const issues = validateManagedTaskTransition(b, t, { to: 'review', actor: 'a', comment: 'c' });
    expect(issues.some((i) => i.code === 'review-evidence-missing')).toBe(true);
  });
  it('blocks every Running transition until dependencies exist and are completed', () => {
    const dependency = card({ id: 'dep-1', status: 'in_progress' });
    const task = card({
      id: 'task-1',
      columnId: 'todo',
      status: 'ready',
      dependsOn: ['dep-1', 'missing-dep'],
      lifecycle: { currentStage: 'todo', stageEnteredAt: nowIso(), history: [] },
      description: 'Detailed work.',
      assignee: 'agent-1',
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['test'],
      successCriteria: [
        { id: 'check-1', description: 'Passes', type: 'manual', status: 'pending' },
      ],
      assignment: {
        status: 'running',
        leaseId: 'lease-1',
        claimedAt: nowIso(),
        heartbeatAt: nowIso(),
        leaseExpiresAt: '2026-08-11T00:00:00.000Z',
      },
    });
    const board = managedBoard();
    board.tasks = [dependency, task];

    const issues = validateManagedTaskTransition(board, task, {
      to: 'running',
      actor: 'agent-1',
      comment: 'Start.',
    });

    expect(issues.find((issue) => issue.code === 'dependency-incomplete')?.message).toContain(
      'dep-1 (in_progress)',
    );
    expect(issues.find((issue) => issue.code === 'dependency-incomplete')?.message).toContain(
      'missing-dep (missing)',
    );

    dependency.status = 'completed';
    task.dependsOn = ['dep-1'];
    expect(
      validateManagedTaskTransition(board, task, {
        to: 'running',
        actor: 'agent-1',
        comment: 'Start.',
      }).some((issue) => issue.code === 'dependency-incomplete'),
    ).toBe(false);
  });

  it('blocks todo→running when the running column is at its WIP limit', () => {
    // wipLimit is defined on columns and the default "In Progress" ships with
    // wipLimit: 5, but nothing enforced it — the UI showed [3/5] while 7 cards
    // could pile up. A forward transition into an at-limit column must refuse.
    const cols = COLS.map((c) => (c.id === 'in-progress' ? { ...c, wipLimit: 1 } : c));
    const b = { ...emptyBoard(cols), lifecycle: policy };
    // One card already occupying the running column.
    const occupant = card({
      id: 'occupant',
      columnId: 'in-progress',
      lifecycle: { currentStage: 'running', stageEnteredAt: nowIso(), history: [] },
    });
    // The card being moved is currently in todo.
    const mover = card({
      id: 'mover',
      columnId: 'todo',
      lifecycle: { currentStage: 'todo', stageEnteredAt: nowIso(), history: [] },
    });
    b.tasks = [occupant, mover];
    const issues = validateManagedTaskTransition(b, mover, {
      to: 'running',
      actor: 'agent',
      comment: 'Start.',
    });
    expect(issues.some((i) => i.code === 'wip-limit-exceeded')).toBe(true);
  });

  it('allows todo→running when the running column has room under its WIP limit', () => {
    const cols = COLS.map((c) => (c.id === 'in-progress' ? { ...c, wipLimit: 2 } : c));
    const b = { ...emptyBoard(cols), lifecycle: policy };
    const occupant = card({
      id: 'occupant',
      columnId: 'in-progress',
      lifecycle: { currentStage: 'running', stageEnteredAt: nowIso(), history: [] },
    });
    const mover = card({
      id: 'mover',
      columnId: 'todo',
      lifecycle: { currentStage: 'todo', stageEnteredAt: nowIso(), history: [] },
    });
    b.tasks = [occupant, mover];
    const issues = validateManagedTaskTransition(b, mover, {
      to: 'running',
      actor: 'agent',
      comment: 'Start.',
    });
    expect(issues.some((i) => i.code === 'wip-limit-exceeded')).toBe(false);
  });

  it('treats wipLimit 0 as unlimited (never blocks)', () => {
    // All default columns ship with wipLimit: 0 (Backlog/Todo/Review/Done).
    // That must mean unlimited, not "zero cards allowed".
    const cols = COLS.map((c) => (c.id === 'in-progress' ? { ...c, wipLimit: 0 } : c));
    const b = { ...emptyBoard(cols), lifecycle: policy };
    // Pile many cards into running.
    b.tasks = Array.from({ length: 10 }, (_, i) =>
      card({
        id: `occ-${i}`,
        columnId: 'in-progress',
        lifecycle: { currentStage: 'running', stageEnteredAt: nowIso(), history: [] },
      }),
    );
    const mover = card({
      id: 'mover',
      columnId: 'todo',
      lifecycle: { currentStage: 'todo', stageEnteredAt: nowIso(), history: [] },
    });
    b.tasks.push(mover);
    const issues = validateManagedTaskTransition(b, mover, {
      to: 'running',
      actor: 'agent',
      comment: 'Start.',
    });
    expect(issues.some((i) => i.code === 'wip-limit-exceeded')).toBe(false);
  });
});

// ── End-to-end transition flows for full validation paths ─────────────

describe('end-to-end managed lifecycle validation paths', () => {
  async function managedBoardWithCard() {
    const board = await createBoard(tmpDir, {
      title: 'Managed',
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
    const created = await addTask(tmpDir, board.id, {
      title: 'Card',
      description: 'Test card for lifecycle validation.',
    });
    return { board, cardId: created!.task.id };
  }

  const fullDetails = () => ({
    description: 'A complete card with every required detail.',
    dueDate: '2026-08-01T00:00:00.000Z',
    assignee: 'agent-1',
    labels: ['release'],
    childTaskIds: ['child-1'],
    successCriteria: [
      { id: 'c1', description: 'All green', type: 'manual' as const, status: 'pending' as const },
    ],
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
    const added = await addTask(tmpDir, board.id, {
      title: 'bare card',
      description: 'A bare card missing most required details.',
    });
    // Description is present, so the first missing detail is assignee
    await expect(
      transitionTask(tmpDir, board.id, added!.task.id, {
        to: 'todo',
        actor: 'agent',
        comment: 'go',
      }),
    ).rejects.toThrow('Assign an owner');
  });

  it('progresses a fully-detailed card through todo -> running -> review with evidence', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, fullDetails());

    await transitionTask(tmpDir, board.id, cardId, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Planned.',
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'running',
      actor: 'agent-1',
      comment: 'Working.',
    });
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

  it('allows review with a blank evidence URL (the artifact is optional)', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, fullDetails());
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Planned.',
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'running',
      actor: 'agent-1',
      comment: 'Working.',
    });
    await updateTaskAssignment(tmpDir, board.id, cardId, {
      status: 'completed',
      lastResult: 'Implementation complete; all tests green.',
    });
    // An evidence URL is optional: real work often has no artifact to link,
    // and requiring one turned Review into a dead end.
    const moved = await transitionTask(tmpDir, board.id, cardId, {
      to: 'review',
      actor: 'agent-1',
      comment: 'Done.',
      attachment: { url: '   ', type: 'file' },
    });
    expect(moved?.task.lifecycle?.currentStage).toBe('review');
  });

  it('allows review with no attachment at all', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, fullDetails());
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Planned.',
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'running',
      actor: 'agent-1',
      comment: 'Working.',
    });
    await updateTaskAssignment(tmpDir, board.id, cardId, {
      status: 'completed',
      lastResult: 'Implementation complete; all tests green.',
    });
    const moved = await transitionTask(tmpDir, board.id, cardId, {
      to: 'review',
      actor: 'agent-1',
      comment: 'Done.',
      // attachment intentionally omitted
    });
    expect(moved?.task.lifecycle?.currentStage).toBe('review');
  });

  it('requires reviewer action text for done, but not an attachment URL', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, {
      ...fullDetails(),
      successCriteria: [{ id: 'c1', description: 'All green', type: 'manual', status: 'passed' }],
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Planned.',
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'running',
      actor: 'agent-1',
      comment: 'Working.',
    });
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
    // Reviewer action text is still required — it is the audit value, and it
    // costs one field. The attachment URL is not.
    const done = await transitionTask(tmpDir, board.id, cardId, {
      to: 'done',
      actor: 'reviewer-1',
      comment: 'Ship it.',
      action: 'approved',
      attachment: { url: '', type: 'url' },
    });
    expect(done?.task.lifecycle?.currentStage).toBe('done');
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
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    const created = await addTask(tmpDir, board.id, {
      title: 'Leaf',
      description: 'Atomic leaf card.',
    });
    return { board, cardId: created!.task.id };
  }

  const leafDetails = () => ({
    description: 'A fully specified atomic leaf.',
    dueDate: '2026-08-01T00:00:00.000Z',
    assignee: 'agent-1',
    labels: ['leaf'],
    successCriteria: [
      { id: 'c1', description: 'All green', type: 'manual' as const, status: 'pending' as const },
    ],
  });

  it('allows a childless atomic leaf to progress from Backlog to Todo', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, leafDetails());
    // Must not throw — no childTaskIds, but task.atomic is not true.
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Planned.',
    });
  });

  it('rejects a composite parent (atomic=true) without children from progressing', async () => {
    const { board, cardId } = await managedBoardWithCard();
    await updateTask(tmpDir, board.id, cardId, { ...leafDetails(), atomic: true });
    await expect(
      transitionTask(tmpDir, board.id, cardId, {
        to: 'todo',
        actor: 'agent-1',
        comment: 'Planned.',
      }),
      // The refusal must also name BOTH ways out: create the children, or
      // declare the card a leaf again. Naming only the first left a parent
      // whose children had been deleted with nothing it could do.
    ).rejects.toThrow(/composite parent but has no children[\s\S]*atomic: false/);
  });

  it('composite parent with children still cannot reach Done without verification report', async () => {
    const { board, cardId } = await managedBoardWithCard();
    // Add a child task
    const child = await addTask(tmpDir, board.id, { title: 'Child', description: 'Child task.' });
    await updateTask(tmpDir, board.id, cardId, {
      ...leafDetails(),
      atomic: true,
      childTaskIds: [child!.task.id],
      successCriteria: [
        { id: 'c1', description: 'All green', type: 'manual' as const, status: 'passed' as const },
      ],
    });
    // Parent can progress to Todo (has children).
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Planned.',
    });
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
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'running',
      actor: 'agent-1',
      comment: 'Working.',
    });
    await updateTaskAssignment(tmpDir, board.id, cardId, {
      status: 'completed',
      lastResult: 'Done.',
    });
    await transitionTask(tmpDir, board.id, cardId, {
      to: 'review',
      actor: 'agent-1',
      comment: 'Review.',
      attachment: { url: 'artifact://x', type: 'file' },
    });
    await expect(
      transitionTask(tmpDir, board.id, cardId, {
        to: 'done',
        actor: 'reviewer',
        comment: 'Approve',
        action: 'approved',
        attachment: { url: 'artifact://y', type: 'doc' },
      }),
    ).rejects.toThrow('Atomic tasks require a completed verification report');
  });
});

// ── KANBAN_AGENT_STAGES sanity ───────────────────────────────────────

describe('KANBAN_AGENT_STAGES', () => {
  it('lists the five canonical stages in order', () => {
    expect([...KANBAN_AGENT_STAGES]).toEqual(['backlog', 'todo', 'running', 'review', 'done']);
  });
});

describe('transitionTask patch smuggling', () => {
  // The input type Omit<>s columnId/status/lifecycle from the transition
  // patch, but over IPC the patch arrives as plain JSON — a single call
  // used to smuggle a stage jump past the ownership/evidence guards and
  // REPLACE the audit ledger with a caller-supplied history array.
  it.each(['columnId', 'status', 'lifecycle'])(
    'rejects a transition patch carrying %s',
    async (field) => {
      const board = await createBoard(tmpDir, {
        title: `Smuggle ${field}`,
        columns: COLS,
        lifecycle: policy,
      });
      const added = await addTask(tmpDir, board.id, {
        title: 'Guarded',
        description: 'Patch smuggling test card.',
      });
      const smuggled =
        field === 'lifecycle'
          ? { lifecycle: { currentStage: 'done', stageEnteredAt: 'x', history: [] } }
          : field === 'status'
            ? { status: 'completed' }
            : { columnId: 'done' };
      await expect(
        transitionTask(tmpDir, board.id, added!.task.id, {
          to: 'todo',
          actor: 'agent-1',
          comment: 'Planned.',
          patch: smuggled as never,
        }),
      ).rejects.toThrow('Transition patch may not set');
      // Benign patch fields still flow through the same call once the
      // todo-stage gates (owner, due date, …) are satisfied.
      await updateTask(tmpDir, board.id, added!.task.id, {
        assignee: 'agent-1',
        dueDate: '2026-09-01T00:00:00.000Z',
        labels: ['guarded'],
        successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'pending' }],
      });
      const ok = await transitionTask(tmpDir, board.id, added!.task.id, {
        to: 'todo',
        actor: 'agent-1',
        comment: 'Planned.',
        patch: { labels: ['ok'] } as never,
      });
      expect(ok).not.toBeNull();
    },
  );
});

// ── Done-gate drift fixes (memory 01KZTS94JCBZFAQG2HT39K8A7W) ─────────
//
// The Done gate now accepts verifier coverage via coveredCheckIds, refuses
// Done on stale or fingerprint-mismatching reports, and applies tickChecks
// to an effective task snapshot before evaluation. Preflight mirrors the
// live gate's optional-attachment contract and refuses only the channels
// the live gate actually requires. These tests pin the new seam so the
// drift cannot return without breaking the suite.

const tickCheckInputBoard = () => {
  const b = managedBoard();
  const task = card({
    id: 'tick-target',
    columnId: 'done',
    status: 'in_progress',
    successCriteria: [
      { id: 'check-manual', description: 'manual review', type: 'manual', status: 'pending' },
      {
        id: 'check-command',
        description: 'run tests',
        type: 'command',
        status: 'pending',
        notes: 'true',
      },
    ],
    assignment: {
      status: 'completed',
      agentId: 'agent-1',
      lastResult: 'all green; verifier reported tests passed',
    },
  });
  b.tasks.push(task);
  return { b, task };
};

/**
 * Verifier snapshot for the tick-checks fixtures.
 *
 * The reported checks are DERIVED from the card's criteria at call time, because
 * `validateDefinitionOfDone` only honours `coveredCheckIds` when every current
 * criterion is covered by a report entry with a matching `description`+`type`
 * fingerprint. Hand-written report literals silently broke that fingerprint and
 * turned every "verifier settles the criteria" test into a no-op that asserted
 * the refusal path instead. Pass `statusOverrides` to vary a single reported
 * check; pass `fingerprint` to deliberately desync a report entry from the card.
 */
const tickCheckReport = (
  task: KanbanTask,
  board: KanbanBoard,
  options: {
    statusOverrides?: Record<string, KanbanVerificationReport['checks'][number]['status']>;
    fingerprint?: Record<string, { description?: string; type?: KanbanCheck['type'] }>;
  } = {},
): KanbanVerificationReport => {
  const criteria = task.successCriteria ?? [];
  return {
    taskId: task.id,
    taskTitle: task.title,
    boardId: board.id,
    verdict: 'passed',
    startedAt: '2026-08-11T23:59:00.000Z',
    completedAt: '2026-08-12T00:00:00.000Z',
    coveredCheckIds: criteria.map((check) => check.id),
    checks: criteria.map((check) => ({
      checkId: check.id,
      description: options.fingerprint?.[check.id]?.description ?? check.description,
      type: options.fingerprint?.[check.id]?.type ?? check.type,
      status: options.statusOverrides?.[check.id] ?? 'passed',
      evidence: {},
    })),
    markdownSummary: 'verifier run',
    attachments: [],
  };
};

describe('validateTickChecks', () => {
  it('returns tickChecks-unknown-id when a checkId is not on the task', () => {
    const { task } = tickCheckInputBoard();
    const issues = validateTickChecks(task, [
      { checkId: 'check-manual', checkStatus: 'passed' },
      { checkId: 'does-not-exist', checkStatus: 'passed' },
    ]);
    expect(issues.map((i) => i.code)).toContain('tickChecks-unknown-id');
  });

  it('returns acceptance-criteria-incomplete when target is non-manual', () => {
    const { task } = tickCheckInputBoard();
    const issues = validateTickChecks(task, [{ checkId: 'check-command', checkStatus: 'passed' }]);
    expect(issues.map((i) => i.code)).toContain('acceptance-criteria-incomplete');
  });

  it('returns no issues for valid manual flips', () => {
    const { task } = tickCheckInputBoard();
    const issues = validateTickChecks(task, [{ checkId: 'check-manual', checkStatus: 'passed' }]);
    expect(issues).toEqual([]);
  });
});

describe('preflightManagedTransition (Done) — tickChecks seam', () => {
  it('returns no issues for valid manual flips paired with a passing verification report', () => {
    const { b, task } = tickCheckInputBoard();
    // The canonical tickChecks case: the verifier settled the command
    // criterion, the agent ticks the manual one it owns. Neither channel
    // alone clears the gate — together they must.
    task.verificationReport = tickCheckReport(task, b);
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'manual override',
      tickChecks: [{ checkId: 'check-manual', checkStatus: 'passed' }],
    });
    expect(issues).toEqual([]);
  });

  it('effective-snapshot keeps verificationReport so ticks do not suspend verifier coverage', () => {
    const { b, task } = tickCheckInputBoard();
    // The report's own per-check status is NOT what the gate reads — it reads
    // the card's criteria plus the report's coverage/verdict/fingerprint. So a
    // report entry that says `failed` for the criterion the agent is ticking
    // must not block, while the SAME report still settles `check-command`.
    // Dropping the report on any tick would make this card unreachable: no
    // tick can flip a command criterion, so Done would be impossible.
    task.verificationReport = tickCheckReport(task, b, {
      statusOverrides: { 'check-manual': 'failed' },
    });
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'agent takes responsibility',
      tickChecks: [{ checkId: 'check-manual', checkStatus: 'passed' }],
    });
    expect(issues).toEqual([]);
  });

  it('applies tickChecks.checkStatus verbatim — a tick of `failed` refuses Done', () => {
    const { b, task } = tickCheckInputBoard();
    // Guards the snapshot against hardcoding 'passed': a fully-covering
    // passing report is present, so the ONLY thing that can refuse Done here
    // is the agent's own `failed` tick landing on the criterion.
    task.verificationReport = tickCheckReport(task, b);
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'manual review did not hold',
      tickChecks: [{ checkId: 'check-manual', checkStatus: 'failed' }],
    });
    expect(issues.map((i) => i.code)).toContain('acceptance-criteria-incomplete');
    expect(issues[0]?.message).toContain('manual review');
  });

  it('refuses Done when assignment.lastResult is missing (only blocking channel)', () => {
    const { b, task } = tickCheckInputBoard();
    task.assignment = undefined;
    task.successCriteria = []; // strip so the only blocker is lastResult.
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'no real result yet',
    });
    expect(issues.map((i) => i.code)).toContain('review-evidence-missing');
  });

  it('does NOT block on missing optional attachment (mirrors live gate)', () => {
    const { b, task } = tickCheckInputBoard();
    task.successCriteria = [
      { id: 'check-manual', description: 'm', type: 'manual', status: 'passed' },
    ];
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'no attachment',
    });
    expect(issues).toEqual([]);
  });

  it('allows Done when the verificationReport verdict=passed AND coveredCheckIds ⊇ current criteria', () => {
    const { b, task } = tickCheckInputBoard();
    // Both criteria are still `pending` on the card — the verifier's coverage
    // is what settles them, with no update_check round-trip.
    task.verificationReport = tickCheckReport(task, b);
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'verifier covered everything',
    });
    expect(issues.filter((i) => i.code === 'acceptance-criteria-incomplete')).toEqual([]);
  });

  it('refuses Done when verdict=passed but a covered criterion is failed on the card', () => {
    const { b, task } = tickCheckInputBoard();
    task.successCriteria = [
      { id: 'check-manual', description: 'm', type: 'manual', status: 'failed' },
      { id: 'check-command', description: 'c', type: 'command', status: 'passed', notes: 'true' },
    ];
    // Coverage, verdict and fingerprints all line up; the live `failed` on the
    // card is the only thing left, and it must still win over the report.
    task.verificationReport = tickCheckReport(task, b);
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'a failed criterion outranks a passing report',
    });
    expect(issues.map((i) => i.code)).toContain('acceptance-criteria-incomplete');
  });

  it('refuses Done when a covered criterion was edited after the report (fingerprint mismatch)', () => {
    const { b, task } = tickCheckInputBoard();
    // Same ids, same passing verdict, full coverage — but the criterion's
    // description has moved on since the verifier ran, so the report no longer
    // describes the card and may not settle it.
    task.verificationReport = tickCheckReport(task, b, {
      fingerprint: { 'check-command': { description: 'run the OLD tests' } },
    });
    const issues = preflightManagedTransition(b, task, {
      to: 'done',
      actor: 'agent-1',
      comment: 'stale report must not settle a rewritten criterion',
    });
    expect(issues.map((i) => i.code)).toContain('acceptance-criteria-incomplete');
  });
});
