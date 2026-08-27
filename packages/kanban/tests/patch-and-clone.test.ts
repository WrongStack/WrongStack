import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTaskPatch,
  buildAssignment,
  cloneTaskForBoard,
  createTaskObject,
} from '../src/manager/_internal.js';
import type { TaskGraph } from '../src/types/task-graph.js';
import type { KanbanBoard } from '../src/types.js';
import {
  addDependency,
  assignTask,
  createBoard,
  createBoardFromTaskGraph,
  duplicateBoard,
  exportBoardToTaskGraph,
  getBoard,
  getTask,
  mergeTasks,
  recordTaskActivity,
  searchKanban,
  setTaskChain,
  splitTask,
  transferTaskToBoard,
  updateTaskAssignment,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-patch-'));
});

function nowIso(): string {
  return '2026-07-17T00:00:00.000Z';
}

function emptyBoard(): KanbanBoard {
  return {
    id: 'board-1',
    title: 'Test',
    columns: [
      { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
      { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
      { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
      { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
      { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
      { id: 'blocked', title: 'Blocked', order: 5, wipLimit: 0 },
    ],
    tasks: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 1,
  };
}

// ── applyTaskPatch field coverage ────────────────────────────────────

describe('applyTaskPatch field handlers', () => {
  function taskOnBoard(): { board: KanbanBoard; task: KanbanBoard['tasks'][number] } {
    const board = emptyBoard();
    const task = createTaskObject(board, { title: 'Patchable', columnId: 'backlog' });
    board.tasks.push(task);
    return { board, task };
  }

  it('updates type, description, priority, estimatedHours, actualHours, labels', () => {
    const { board, task } = taskOnBoard();
    applyTaskPatch(board, task, {
      type: 'bugfix',
      description: 'new desc',
      priority: 'critical',
      estimatedHours: 8,
      actualHours: 4,
      labels: ['urgent', 'backend'],
    });
    expect(task.type).toBe('bugfix');
    expect(task.description).toBe('new desc');
    expect(task.priority).toBe('critical');
    expect(task.estimatedHours).toBe(8);
    expect(task.actualHours).toBe(4);
    expect(task.labels).toEqual(['urgent', 'backend']);
  });

  it('changes status without changing column (status sync path)', () => {
    const { board, task } = taskOnBoard();
    applyTaskPatch(board, task, { status: 'completed' });
    expect(task.status).toBe('completed');
    // Column should have synced to 'done'
    expect(task.columnId).toBe('done');
  });

  it('clears nullable fields (assignedAgent, assignee, assignment, origin, retryPolicy, costCeiling, lifecycle)', () => {
    const { board, task } = taskOnBoard();
    // Set fields first
    applyTaskPatch(board, task, {
      assignedAgent: 'bot',
      assignee: 'ada',
      assignment: { status: 'running' },
      origin: { system: 'test' },
      retryPolicy: 'exponential',
      costCeilingUsd: 10,
      parentTaskId: 'p1',
      mergedIntoTaskId: 'm1',
    });
    // Now null them out
    applyTaskPatch(board, task, {
      assignedAgent: null,
      assignee: null,
      assignment: null,
      origin: null,
      retryPolicy: null,
      costCeilingUsd: null,
      parentTaskId: null,
      mergedIntoTaskId: null,
    });
    expect(task.assignedAgent).toBeUndefined();
    expect(task.assignee).toBeUndefined();
    expect(task.assignment).toBeUndefined();
    expect(task.origin).toBeUndefined();
    expect(task.retryPolicy).toBeUndefined();
    expect(task.costCeilingUsd).toBeUndefined();
    expect(task.parentTaskId).toBeUndefined();
    expect(task.mergedIntoTaskId).toBeUndefined();
  });

  it('updates childTaskIds and mergedFromTaskIds, emptying them when blank', () => {
    const { board, task } = taskOnBoard();
    applyTaskPatch(board, task, { childTaskIds: ['c1', 'c2'], mergedFromTaskIds: ['m1'] });
    expect(task.childTaskIds).toEqual(['c1', 'c2']);
    expect(task.mergedFromTaskIds).toEqual(['m1']);
    // Empty arrays delete the field
    applyTaskPatch(board, task, { childTaskIds: [], mergedFromTaskIds: [] });
    expect(task.childTaskIds).toBeUndefined();
    expect(task.mergedFromTaskIds).toBeUndefined();
  });

  it('updates successCriteria, goalMetrics, and links arrays', () => {
    const { board, task } = taskOnBoard();
    applyTaskPatch(board, task, {
      successCriteria: [{ id: 'c1', description: 'Must pass', type: 'test', status: 'pending' }],
      goalMetrics: [{ id: 'g1', name: 'Speed', status: 'pending' }],
      links: [{ url: 'https://x.com', type: 'url' }],
    });
    expect(task.successCriteria).toHaveLength(1);
    expect(task.goalMetrics).toHaveLength(1);
    expect(task.links).toHaveLength(1);
  });

  it('sets and clears lifecycle history', () => {
    const { board, task } = taskOnBoard();
    const life = {
      currentStage: 'backlog' as const,
      stageEnteredAt: nowIso(),
      history: [{ to: 'backlog' as const, at: nowIso(), actor: 'a' }],
    };
    applyTaskPatch(board, task, { lifecycle: life });
    expect(task.lifecycle?.history).toHaveLength(1);
    applyTaskPatch(board, task, { lifecycle: null });
    expect(task.lifecycle).toBeUndefined();
  });

  it('moves to a new column with explicit order (shouldReorder path)', () => {
    const board = emptyBoard();
    const t1 = createTaskObject(board, { title: 'T1', columnId: 'backlog' });
    const t2 = createTaskObject(board, { title: 'T2', columnId: 'backlog' });
    board.tasks.push(t1, t2);
    applyTaskPatch(board, t1, { columnId: 'done' });
    expect(t1.columnId).toBe('done');
    // Remaining backlog task order should be normalized
    expect(board.tasks.find((t) => t.id === t2.id)!.order).toBe(0);
  });

  it('syncs column for status when no explicit columnId is given', () => {
    const { board, task } = taskOnBoard();
    applyTaskPatch(board, task, { status: 'in_progress' });
    expect(task.columnId).toBe('in-progress');
  });

  it('sets dueDate and clears it with null', () => {
    const { board, task } = taskOnBoard();
    applyTaskPatch(board, task, { dueDate: '2026-08-01' });
    expect(task.dueDate).toBe('2026-08-01');
    applyTaskPatch(board, task, { dueDate: null });
    expect(task.dueDate).toBeUndefined();
  });

  it('sets atomic, expectedFileChanges, and verificationReport', () => {
    const { board, task } = taskOnBoard();
    applyTaskPatch(board, task, {
      atomic: true,
      expectedFileChanges: [{ path: 'src/main.ts', operation: 'modify' }],
      verificationReport: {
        taskId: task.id,
        taskTitle: task.title,
        boardId: board.id,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        verdict: 'passed',
        checks: [],
        markdownSummary: 'All checks passed.',
        attachments: [],
      },
    });
    expect(task.atomic).toBe(true);
    expect(task.expectedFileChanges).toHaveLength(1);
    expect(task.expectedFileChanges![0]!.path).toBe('src/main.ts');
    expect(task.verificationReport).toBeDefined();
    expect(task.verificationReport!.verdict).toBe('passed');

    // Clear with null
    applyTaskPatch(board, task, {
      atomic: null,
      expectedFileChanges: null,
      verificationReport: null,
    });
    expect(task.atomic).toBeUndefined();
    expect(task.expectedFileChanges).toBeUndefined();
    expect(task.verificationReport).toBeUndefined();
  });

  it('ignores verificationReport:null on managed boards (immutable audit trail)', () => {
    // A verification report is an immutable snapshot of a completed run. On a
    // managed board, deleting it via a generic patch would erase the evidence
    // a reviewer needs. The null/delete request is ignored on managed boards;
    // legacy boards (the test above) still clear it.
    const board = emptyBoard();
    board.lifecycle = {
      mode: 'managed',
      columns: {
        backlog: 'backlog',
        todo: 'todo',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    };
    const task = createTaskObject(board, { title: 'Managed', columnId: 'backlog' });
    board.tasks.push(task);

    // Seed a report.
    applyTaskPatch(board, task, {
      verificationReport: {
        taskId: task.id,
        taskTitle: task.title,
        boardId: board.id,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        verdict: 'passed',
        checks: [],
        markdownSummary: 'All checks passed.',
        attachments: [],
      },
    });
    expect(task.verificationReport).toBeDefined();

    // Attempt to delete via null — ignored on managed board.
    applyTaskPatch(board, task, { verificationReport: null });
    expect(task.verificationReport).toBeDefined();
    expect(task.verificationReport!.verdict).toBe('passed');

    // A fresh re-verification still overwrites (not a deletion).
    applyTaskPatch(board, task, {
      verificationReport: {
        taskId: task.id,
        taskTitle: task.title,
        boardId: board.id,
        startedAt: '2026-01-02T00:00:00Z',
        completedAt: '2026-01-02T00:01:00Z',
        verdict: 'failed',
        checks: [],
        markdownSummary: 'Re-run failed.',
        attachments: [],
      },
    });
    expect(task.verificationReport!.verdict).toBe('failed');
  });
});

// ── buildAssignment ──────────────────────────────────────────────────

describe('buildAssignment', () => {
  it('builds an assignment with all optional fields', () => {
    const a = buildAssignment({
      agentId: 'bot',
      name: 'Worker',
      role: 'executor',
      provider: 'anthropic',
      model: 'opus',
      modelRouting: 'session',
      fallbackProfile: 'careful',
      fallbackModels: ['sonnet'],
      skills: ['testing'],
      tools: ['read'],
      allowedCapabilities: ['x'],
      leaseId: 'l1',
      claimedAt: nowIso(),
      heartbeatAt: nowIso(),
      leaseExpiresAt: nowIso(),
      attempt: 1,
      maxAttempts: 3,
      costCeilingUsd: 5,
      retryPolicy: 'incremental',
      lastFailureKind: 'timeout',
      status: 'running',
    });
    expect(a.status).toBe('running');
    expect(a.agentId).toBe('bot');
    expect(a.fallbackModels).toEqual(['sonnet']);
    expect(a.lastFailureKind).toBe('timeout');
  });

  it('defaults status to assigned when omitted', () => {
    expect(buildAssignment({}).status).toBe('assigned');
  });
});

// ── cloneTaskForBoard field preservation ─────────────────────────────

describe('cloneTaskForBoard field cloning', () => {
  it('preserves notes, links, goalMetrics, lifecycle, and origin on clone', () => {
    const board = emptyBoard();
    const source = createTaskObject(board, {
      title: 'Source',
      columnId: 'backlog',
      labels: ['x'],
      notes: [{ id: 'n1', author: 'a', content: 'c', createdAt: nowIso() }],
      links: [{ url: 'u', type: 'url' }],
      goalMetrics: [{ id: 'g1', name: 'Speed', status: 'pending' }],
      successCriteria: [{ id: 's1', description: 'd', type: 'manual', status: 'pending' }],
      origin: { system: 'test', graphId: 'g' },
      estimatedHours: 3,
      actualHours: 1,
      retryPolicy: 'exponential',
      costCeilingUsd: 2,
      description: 'desc',
      dueDate: '2026-08-01',
      atomic: true,
      expectedFileChanges: [{ path: 'src/main.ts', operation: 'modify' }],
    });
    // createTaskObject doesn't accept lifecycle, so set it directly on the source.
    source.lifecycle = {
      currentStage: 'backlog',
      stageEnteredAt: nowIso(),
      history: [{ to: 'backlog', at: nowIso(), actor: 'a' }],
    };
    // verificationReport is set after creation to test clone propagation
    source.verificationReport = {
      taskId: source.id,
      taskTitle: source.title,
      boardId: board.id,
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      verdict: 'passed',
      checks: [],
      markdownSummary: 'All checks passed.',
      attachments: [],
    };
    const cloned = cloneTaskForBoard(board, source, {
      preserveAssignment: true,
      preserveDependencies: true,
    });
    expect(cloned.notes).toHaveLength(1);
    expect(cloned.notes![0]!.id).not.toBe('n1'); // new id
    expect(cloned.links).toHaveLength(1);
    expect(cloned.goalMetrics).toHaveLength(1);
    expect(cloned.goalMetrics![0]!.id).not.toBe('g1'); // new id
    expect(cloned.successCriteria).toHaveLength(1);
    expect(cloned.successCriteria![0]!.id).not.toBe('s1'); // new id
    expect(cloned.lifecycle?.history).toHaveLength(1);
    expect(cloned.origin?.system).toBe('test');
    expect(cloned.estimatedHours).toBe(3);
    expect(cloned.labels).toEqual(['x']);
    expect(cloned.id).not.toBe(source.id);
    // New verification fields propagate
    expect(cloned.atomic).toBe(true);
    expect(cloned.expectedFileChanges).toHaveLength(1);
    expect(cloned.expectedFileChanges![0]!.path).toBe('src/main.ts');
    expect(cloned.verificationReport).toBeDefined();
    expect(cloned.verificationReport!.verdict).toBe('passed');
  });

  it('preserves assignment when requested', () => {
    const board = emptyBoard();
    const source = createTaskObject(board, {
      title: 'Source',
      columnId: 'backlog',
      assignedAgent: 'bot',
      assignee: 'ada',
      assignment: { status: 'running' },
    });
    const cloned = cloneTaskForBoard(board, source, { preserveAssignment: true });
    expect(cloned.assignedAgent).toBe('bot');
    expect(cloned.assignee).toBe('ada');
    expect(cloned.assignment?.status).toBe('running');
  });

  it('drops assignment when not requested', () => {
    const board = emptyBoard();
    const source = createTaskObject(board, {
      title: 'Source',
      columnId: 'backlog',
      assignedAgent: 'bot',
    });
    const cloned = cloneTaskForBoard(board, source, { preserveAssignment: false });
    expect(cloned.assignedAgent).toBeUndefined();
  });
});

// ── End-to-end async paths for storage/dependencies/tasks gaps ────────

describe('async edge coverage', () => {
  it('addDependency returns null for unknown task or dependency', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'T' }] });
    const t = b.tasks[0]!;
    expect(await addDependency(tmpDir, b.id, t.id, 'nope')).toBeNull();
    expect(await addDependency(tmpDir, b.id, 'nope', t.id)).toBeNull();
  });

  it('splitTask throws when column does not exist', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'P' }] });
    await expect(
      splitTask(tmpDir, b.id, b.tasks[0]!.id, { titles: ['C'], columnId: 'ghost' }),
    ).rejects.toThrow('Column not found');
  });

  it('mergeTasks throws when fewer than two tasks are given', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'Only' }] });
    await expect(
      mergeTasks(tmpDir, b.id, { taskIds: [b.tasks[0]!.id], title: 'M' }),
    ).rejects.toThrow('at least two tasks');
  });

  it('mergeTasks throws when target column does not exist', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'A' }, { title: 'B' }] });
    await expect(
      mergeTasks(tmpDir, b.id, {
        taskIds: [b.tasks[0]!.id, b.tasks[1]!.id],
        title: 'M',
        targetColumnId: 'ghost',
      }),
    ).rejects.toThrow('Column not found');
  });

  it('mergeTasks keeps source tasks open when closeSourceTasks is false', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'A' }, { title: 'B' }] });
    const result = await mergeTasks(tmpDir, b.id, {
      taskIds: [b.tasks[0]!.id, b.tasks[1]!.id],
      title: 'Merged',
      closeSourceTasks: false,
    });
    const stored = await getBoard(tmpDir, b.id);
    const source = stored!.tasks.find((t) => t.id === result!.sourceTasks[0]!.id)!;
    expect(source.status).not.toBe('archived');
  });

  it('recordTaskActivity throws for a blank summary', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'T' }] });
    await expect(
      recordTaskActivity(tmpDir, b.id, b.tasks[0]!.id, { kind: 'decision', summary: '  ' }),
    ).rejects.toThrow('summary');
  });

  it('updateTaskAssignment clears error on non-error status transitions', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'T' }] });
    const t = b.tasks[0]!;
    await assignTask(tmpDir, b.id, t.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, b.id, t.id, { status: 'failed', error: 'boom' });
    expect((await getTask(tmpDir, b.id, t.id))?.assignment?.error).toBe('boom');
    // Transition to completed clears error
    await updateTaskAssignment(tmpDir, b.id, t.id, { status: 'completed' });
    expect((await getTask(tmpDir, b.id, t.id))?.assignment?.error).toBeUndefined();
  });

  it('updateTaskAssignment cancelled clears error', async () => {
    const b = await createBoard(tmpDir, { title: 'X', tasks: [{ title: 'T' }] });
    const t = b.tasks[0]!;
    await assignTask(tmpDir, b.id, t.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, b.id, t.id, { status: 'failed', error: 'x' });
    await updateTaskAssignment(tmpDir, b.id, t.id, { status: 'cancelled' });
    expect((await getTask(tmpDir, b.id, t.id))?.assignment?.error).toBeUndefined();
  });

  it('searchKanban filters by label and chainId', async () => {
    const b = await createBoard(tmpDir, {
      title: 'X',
      tasks: [{ title: 'A', labels: ['red'] }, { title: 'B' }],
    });
    const aId = b.tasks[0]!.id;
    const bId = b.tasks[1]!.id;
    await setTaskChain(tmpDir, b.id, { taskIds: [aId, bId], chainId: 'ch1' });
    const byLabel = await searchKanban(tmpDir, { label: 'red' });
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0]!.task.title).toBe('A');
    const byChain = await searchKanban(tmpDir, { chainId: 'ch1' });
    expect(byChain).toHaveLength(2);
  });

  it('exportBoardToTaskGraph preserves origin task ids when asked', async () => {
    const g: TaskGraph = {
      id: 'g1',
      specId: 's1',
      title: 'G',
      nodes: new Map([
        [
          'node-x',
          {
            id: 'node-x',
            title: 'From graph',
            description: '',
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      ]),
      edges: [],
      rootNodes: ['node-x'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const { board } = await createBoardFromTaskGraph(tmpDir, g);
    const exported = await exportBoardToTaskGraph(tmpDir, board.id, {
      preserveOriginTaskIds: true,
    });
    expect(exported!.graph.nodes.has('node-x')).toBe(true);
  });

  it('transferTaskToBoard returns null when source task is missing', async () => {
    const b1 = await createBoard(tmpDir, { title: 'B1' });
    const b2 = await createBoard(tmpDir, { title: 'B2' });
    expect(await transferTaskToBoard(tmpDir, b1.id, 'nope', b2.id)).toBeNull();
  });

  it('duplicateBoard with a managed source resets copied lifecycle', async () => {
    const managed = {
      mode: 'managed' as const,
      columns: {
        backlog: 'backlog',
        todo: 'todo',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    };
    const b = await createBoard(tmpDir, {
      title: 'M',
      lifecycle: managed,
      tasks: [
        {
          title: 'Card',
          description: 'd',
          dueDate: '2026-08-01',
          assignee: 'a',
          labels: ['x'],
          childTaskIds: ['c1'],
          successCriteria: [{ id: 'c1', description: 'c', type: 'manual', status: 'pending' }],
        },
      ],
    });
    const dup = await duplicateBoard(tmpDir, b.id);
    const card = dup!.tasks[0]!;
    expect(card.columnId).toBe('backlog');
    expect(card.lifecycle?.currentStage).toBe('backlog');
    expect(card.status).toBe('pending');
  });
});
