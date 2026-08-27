import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareTasksForWork } from '../src/manager/_internal.js';
import type { KanbanTask } from '../src/types.js';
import {
  addTask,
  assignTask,
  createBoard,
  splitTask,
  transitionTask,
  updateTask,
  updateTaskAssignment,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-phase4-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

const COLS = [
  { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
  { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
  { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
  { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
  { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
];

const policy = {
  mode: 'managed' as const,
  columns: {
    backlog: 'backlog',
    todo: 'todo',
    running: 'in-progress',
    review: 'review',
    done: 'done',
  },
};

function fullDetails() {
  return {
    description: 'A complete task with every required detail.',
    dueDate: '2026-08-01T00:00:00.000Z',
    assignee: 'agent-1',
    labels: ['release'],
    childTaskIds: ['child-1'],
    successCriteria: [
      { id: 'c1', description: 'Pass', type: 'manual' as const, status: 'pending' as const },
    ],
  };
}

async function makeSplitParent(): Promise<{
  boardId: string;
  parentId: string;
  childIds: string[];
}> {
  const board = await createBoard(tmpDir, { title: 'Phase 4', columns: COLS, lifecycle: policy });
  const added = await addTask(tmpDir, board.id, { title: 'Parent', ...fullDetails() });
  const parentId = added!.task.id;

  // Split into 2 children — splitTask sets childTaskIds on the parent.
  const split = await splitTask(tmpDir, board.id, parentId, {
    titles: ['Child A', 'Child B'],
  });
  const childIds = split!.children.map((c) => c.id);

  return { boardId: board.id, parentId, childIds };
}

async function advanceToRunning(boardId: string, taskId: string): Promise<void> {
  await assignTask(tmpDir, boardId, taskId, { agentId: 'agent-1', name: 'worker' });
  await updateTaskAssignment(tmpDir, boardId, taskId, {
    status: 'running',
    leaseId: 'lease-1',
    claimedAt: '2026-07-31T00:00:00.000Z',
    heartbeatAt: '2026-07-31T00:00:00.000Z',
    leaseExpiresAt: '2026-12-31T00:00:00.000Z',
  });
  await transitionTask(tmpDir, boardId, taskId, {
    to: 'running',
    actor: 'agent-1',
    comment: 'Working.',
  });
}

async function advanceToReview(boardId: string, taskId: string): Promise<void> {
  await advanceToRunning(boardId, taskId);
  // Set lastResult so review evidence check passes.
  await updateTaskAssignment(tmpDir, boardId, taskId, { lastResult: 'Work done.' });
  await transitionTask(tmpDir, boardId, taskId, {
    to: 'review',
    actor: 'agent-1',
    comment: 'Done.',
    attachment: { url: `kanban://task/${taskId}/result`, title: 'Result', type: 'file' as const },
  });
}

async function advanceToDone(boardId: string, taskId: string): Promise<void> {
  await advanceToReview(boardId, taskId);
  // Pass all success criteria.
  await updateTask(tmpDir, boardId, taskId, {
    successCriteria: [{ id: 'c1', description: 'Pass', type: 'manual', status: 'passed' as const }],
  });
  await transitionTask(tmpDir, boardId, taskId, {
    to: 'done',
    actor: 'reviewer',
    action: 'Approved',
    comment: 'LGTM',
    attachment: { url: `kanban://task/${taskId}/review`, title: 'Review', type: 'doc' as const },
  });
}

async function fillChildDetailsAndAdvanceToTodo(boardId: string, childId: string): Promise<void> {
  await updateTask(tmpDir, boardId, childId, {
    description: 'Child task with clear scope.',
    assignee: 'agent-1',
    dueDate: '2026-08-01T00:00:00.000Z',
    labels: ['child'],
    childTaskIds: ['grandchild-1'],
    successCriteria: [{ id: 'cc', description: 'Child done', type: 'manual', status: 'pending' }],
  });
  await transitionTask(tmpDir, boardId, childId, {
    to: 'todo',
    actor: 'agent-1',
    comment: 'Child ready.',
  });
}

// ── Parent/child atomic gate ─────────────────────────────────────────

describe('Phase 4: parent/child atomic gate', () => {
  it('blocks parent Done when children are not completed', async () => {
    const { boardId, parentId } = await makeSplitParent();

    // Advance parent to todo, then running → review.
    await transitionTask(tmpDir, boardId, parentId, { to: 'todo', actor: 'a', comment: 'c' });
    await advanceToReview(boardId, parentId);

    // Pass criteria so the only remaining gate is the parent-child check.
    await updateTask(tmpDir, boardId, parentId, {
      successCriteria: [
        { id: 'c1', description: 'Pass', type: 'manual', status: 'passed' as const },
      ],
    });

    // Parent cannot reach Done — children are not completed.
    await expect(
      transitionTask(tmpDir, boardId, parentId, {
        to: 'done',
        actor: 'reviewer',
        action: 'Approved',
        comment: 'LGTM',
        attachment: { url: 'kanban://review', title: 'Review', type: 'doc' as const },
      }),
    ).rejects.toThrow('child task');
  });

  it('allows parent Done after all children are completed', async () => {
    const { boardId, parentId, childIds } = await makeSplitParent();

    // Fill children and complete them first.
    for (const childId of childIds!) {
      await fillChildDetailsAndAdvanceToTodo(boardId, childId);
      await advanceToDone(boardId, childId);
    }

    // Now advance parent through to Done.
    await transitionTask(tmpDir, boardId, parentId, { to: 'todo', actor: 'a', comment: 'c' });
    await advanceToReview(boardId, parentId);
    await updateTask(tmpDir, boardId, parentId, {
      successCriteria: [
        { id: 'c1', description: 'Pass', type: 'manual', status: 'passed' as const },
      ],
    });
    // Should succeed — all children are done.
    await transitionTask(tmpDir, boardId, parentId, {
      to: 'done',
      actor: 'reviewer',
      action: 'Approved',
      comment: 'LGTM',
      attachment: { url: 'kanban://parent-review', title: 'Review', type: 'doc' as const },
    });
  });
});

// ── Child-before-parent dispatch ordering ────────────────────────────

describe('Phase 4: child-before-parent dispatch ordering', () => {
  it('sorts child tasks before parent tasks at same priority', () => {
    const child: KanbanTask = {
      id: 'child-1',
      title: 'Child',
      parentTaskId: 'parent-1',
      columnId: 'todo',
      order: 0,
      priority: 'high',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const parent: KanbanTask = {
      id: 'parent-1',
      title: 'Parent',
      childTaskIds: ['child-1'],
      columnId: 'todo',
      order: 0,
      priority: 'high',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    // Child sorts first.
    expect(compareTasksForWork(child, parent)).toBe(-1);
    expect(compareTasksForWork(parent, child)).toBe(1);
  });

  it('does not reorder when neither is a parent/child', () => {
    const a: KanbanTask = {
      id: 'a',
      title: 'A',
      columnId: 'todo',
      order: 0,
      priority: 'critical',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const b: KanbanTask = {
      id: 'b',
      title: 'B',
      columnId: 'todo',
      order: 1,
      priority: 'medium',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    // Priority dominates — 'a' (critical) before 'b' (medium).
    expect(compareTasksForWork(a, b)).toBeLessThan(0);
  });
});
