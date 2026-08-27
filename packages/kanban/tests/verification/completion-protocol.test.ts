/**
 * Tests for verifyTaskCompletion and related helpers.
 *
 * Coverage targets:
 * - verifyTaskCompletion returns a complete result for a task with criteria
 * - handles tasks without success criteria
 * - errors for missing board or task
 * - verifySubtasks: handles atomic tasks with children, existing reports,
 *   nested atomic tasks, and simple children
 * - verifyFileScope: detects expected and unexpected changes
 * - collectAttachments: extracts evidence from test/command/git_diff checks
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KanbanCheck, KanbanVerificationCheckResult } from '../../src/types.js';
import type { VerificationContext } from '../../src/verification/verification-context.js';
import type { VerifierPlugin } from '../../src/verification/verifier-plugin.js';
import { VerifierRegistry } from '../../src/verification/verifier-registry.js';
import { verifyTaskCompletion } from '../helpers/session-manager.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// ── Helper to create a minimal board JSON ────────────────────────────────

async function createMinimalBoard(root: string, taskOverrides?: Record<string, unknown>) {
  // Re-use the createBoard from manager to get proper storage
  const { createBoard, addTask, addCheckToTask } = await import('../helpers/session-manager.js');
  const board = await createBoard(root, { title: 'Test Board' });
  const added = await addTask(root, board.id, {
    title: 'Test task',
    ...(taskOverrides?.atomic !== undefined ? { atomic: taskOverrides.atomic as boolean } : {}),
  });
  if (!added) throw new Error('Failed to add task');
  if (taskOverrides?.successCriteria) {
    for (const check of taskOverrides.successCriteria as KanbanCheck[]) {
      await addCheckToTask(root, board.id, added.task.id, check);
    }
  }
  return { board: added.board, task: added.task, boardId: board.id, taskId: added.task.id };
}

// ── Fake deterministic plugin for testing ─────────────────────────────────

class FakePassPlugin implements VerifierPlugin {
  readonly id = 'fake_pass';
  readonly kind = 'deterministic' as const;
  canHandle(checkType: string): boolean {
    return checkType === 'fake_pass';
  }
  async verify(
    check: KanbanCheck,
    _context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: 'passed',
      evidence: { fake: true },
    };
  }
}

class FakeFailPlugin implements VerifierPlugin {
  readonly id = 'fake_fail';
  readonly kind = 'deterministic' as const;
  canHandle(checkType: string): boolean {
    return checkType === 'fake_fail';
  }
  async verify(
    check: KanbanCheck,
    _context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: 'failed',
      evidence: { fake: false },
      error: 'Intentional failure for test',
    };
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('verifyTaskCompletion', () => {
  it('returns a complete result for a task with passing criteria', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root, {
      successCriteria: [
        { id: 'c1', description: 'Criterion 1', type: 'fake_pass', status: 'pending' },
      ],
    });

    const registry = new VerifierRegistry().register(new FakePassPlugin());
    const result = await verifyTaskCompletion(root, boardId, taskId, { registry, persist: false });

    expect(result.report.verdict).toBe('passed');
    expect(result.report.checks).toHaveLength(1);
    expect(result.report.checks[0]!.status).toBe('passed');
    expect(result.report.taskId).toBe(taskId);
    expect(result.report.boardId).toBe(boardId);
    expect(result.task.id).toBe(taskId);
    expect(result.board.id).toBe(boardId);
  });

  it('returns a failed result when a criterion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-fail-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root, {
      successCriteria: [
        { id: 'c1', description: 'Will fail', type: 'fake_fail', status: 'pending' },
      ],
    });

    const registry = new VerifierRegistry().register(new FakeFailPlugin());
    const result = await verifyTaskCompletion(root, boardId, taskId, { registry, persist: false });

    expect(result.report.verdict).toBe('failed');
    expect(result.report.checks[0]!.status).toBe('failed');
    expect(result.report.checks[0]!.error).toContain('Intentional failure');
  });

  it('handles tasks with no success criteria gracefully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-empty-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root);

    const result = await verifyTaskCompletion(root, boardId, taskId);

    // No criteria means no checks, no snapshot capture needed
    expect(result.report.verdict).toBe('passed');
    expect(result.report.checks).toHaveLength(0);
  });

  it('throws for a missing board', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-noboard-'));
    roots.push(root);

    await expect(verifyTaskCompletion(root, 'non-existent-board', 'task-1')).rejects.toThrow(
      'Board not found',
    );
  });

  it('throws for a missing task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-notask-'));
    roots.push(root);
    const { createBoard } = await import('../helpers/session-manager.js');
    const board = await createBoard(root, { title: 'Test' });

    await expect(verifyTaskCompletion(root, board.id, 'non-existent-task')).rejects.toThrow(
      'Task not found',
    );
  });

  it('uses the default registry when none is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-default-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root, {
      successCriteria: [
        { id: 'c1', description: 'Manual check', type: 'manual', status: 'passed' },
      ],
    });

    // The default registry doesn't handle 'manual', so it becomes 'skipped'
    // But a pre-passed manual check flows through as passed.
    const result = await verifyTaskCompletion(root, boardId, taskId);

    // Manual check with status=passed is passed through
    expect(result.report.checks[0]!.status).toBe('passed');
  });

  it('handles atomic tasks with child tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-atomic-'));
    roots.push(root);
    const { createBoard, addTask, updateTask } = await import('../helpers/session-manager.js');

    const board = await createBoard(root, { title: 'Test' });
    const parent = await addTask(root, board.id, { title: 'Parent', atomic: true });
    if (!parent) throw new Error('Failed to add parent task');
    const child = await addTask(root, board.id, {
      title: 'Child',
      parentTaskId: parent.task.id,
    });
    if (!child) throw new Error('Failed to add child task');
    await updateTask(root, board.id, parent.task.id, {
      childTaskIds: [child.task.id],
    });

    const registry = new VerifierRegistry().register(new FakePassPlugin());
    const result = await verifyTaskCompletion(root, board.id, parent.task.id, {
      registry,
      persist: false,
    });

    // Parent task should be 'passed' since child has no criteria and no report
    expect(result.report.verdict).toBe('passed');
  });

  it('uses existing child verification report when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-child-report-'));
    roots.push(root);
    const { createBoard, addTask, updateTask } = await import('../helpers/session-manager.js');
    const { buildVerificationReport } = await import(
      '../../src/verification/verification-report.js'
    );

    const board = await createBoard(root, { title: 'Test' });
    const parent = await addTask(root, board.id, { title: 'Parent', atomic: true });
    if (!parent) throw new Error('Failed to add parent task');
    const child = await addTask(root, board.id, {
      title: 'Child',
      parentTaskId: parent.task.id,
    });
    if (!child) throw new Error('Failed to add child task');
    await updateTask(root, board.id, parent.task.id, {
      childTaskIds: [child.task.id],
    });

    // Give the child an existing verification report
    const childReport = buildVerificationReport({
      taskId: child.task.id,
      taskTitle: child.task.title,
      boardId: board.id,
      checks: [],
    });
    await updateTask(root, board.id, child.task.id, {
      verificationReport: childReport,
    });

    const registry = new VerifierRegistry().register(new FakePassPlugin());
    const result = await verifyTaskCompletion(root, board.id, parent.task.id, {
      registry,
      persist: false,
    });

    expect(result.report.verdict).toBe('passed');
    expect(result.report.subtasks).toBeDefined();
    expect(result.report.subtasks!.completed).toBe(1);
  });

  // Nothing upstream guarantees `childTaskIds` is acyclic: `splitTask` is safe
  // because it mints fresh ids, but `syncTaskGraphIntoBoard` copies
  // `node.children` straight through and a board file is ordinary project data.
  // A cycle used to recurse forever — and being `async`, it did not even fail
  // fast with a stack overflow, it just re-read the board on every hop.
  it('rejects a cyclic parent/child task graph instead of recursing forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-cycle-'));
    roots.push(root);
    const { createBoard, addTask, updateTask } = await import('../helpers/session-manager.js');

    const board = await createBoard(root, { title: 'Test' });
    const a = await addTask(root, board.id, { title: 'A', atomic: true });
    const b = await addTask(root, board.id, { title: 'B', atomic: true });
    if (!a || !b) throw new Error('Failed to add tasks');
    await updateTask(root, board.id, a.task.id, { childTaskIds: [b.task.id] });
    await updateTask(root, board.id, b.task.id, { childTaskIds: [a.task.id] });

    const registry = new VerifierRegistry().register(new FakePassPlugin());
    await expect(
      verifyTaskCompletion(root, board.id, a.task.id, { registry, persist: false }),
    ).rejects.toThrow(/Cyclic parent\/child task graph/);
  });

  // The guard is scoped to the current descent path, not to the whole run, so a
  // task legitimately reachable through two parents is not mistaken for a cycle.
  it('verifies a task reachable through two parents without reporting a cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-diamond-'));
    roots.push(root);
    const { createBoard, addTask, updateTask } = await import('../helpers/session-manager.js');

    const board = await createBoard(root, { title: 'Test' });
    const top = await addTask(root, board.id, { title: 'Top', atomic: true });
    const left = await addTask(root, board.id, { title: 'Left', atomic: true });
    const right = await addTask(root, board.id, { title: 'Right', atomic: true });
    const shared = await addTask(root, board.id, { title: 'Shared' });
    if (!top || !left || !right || !shared) throw new Error('Failed to add tasks');

    await updateTask(root, board.id, top.task.id, {
      childTaskIds: [left.task.id, right.task.id],
    });
    await updateTask(root, board.id, left.task.id, { childTaskIds: [shared.task.id] });
    await updateTask(root, board.id, right.task.id, { childTaskIds: [shared.task.id] });

    const registry = new VerifierRegistry().register(new FakePassPlugin());
    const result = await verifyTaskCompletion(root, board.id, top.task.id, {
      registry,
      persist: false,
    });
    expect(result.report.subtasks?.children).toHaveLength(2);
  });

  it('handles mix of passed and failed criteria', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-mixed-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root, {
      successCriteria: [
        { id: 'c1', description: 'Pass', type: 'fake_pass', status: 'pending' },
        { id: 'c2', description: 'Fail', type: 'fake_fail', status: 'pending' },
      ],
    });

    const registry = new VerifierRegistry()
      .register(new FakePassPlugin())
      .register(new FakeFailPlugin());
    const result = await verifyTaskCompletion(root, boardId, taskId, { registry, persist: false });

    expect(result.report.verdict).toBe('failed');
    // The checks array should contain both a passed and a failed check
    // (IDs are auto-generated by addCheckToTask)
    expect(result.report.checks).toHaveLength(2);
    const statuses = result.report.checks.map((c) => c.status);
    expect(statuses).toContain('passed');
    expect(statuses).toContain('failed');
  });

  it('updates task success criteria status in the result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-update-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root, {
      successCriteria: [
        { id: 'c1', description: 'Will pass', type: 'fake_pass', status: 'pending' },
      ],
    });

    const registry = new VerifierRegistry().register(new FakePassPlugin());
    const result = await verifyTaskCompletion(root, boardId, taskId, { registry, persist: false });

    expect(result.task.successCriteria).toBeDefined();
    expect(result.task.successCriteria![0]!.status).toBe('passed');
    expect(result.task.successCriteria![0]!.checkedBy).toBe('system');
    expect(result.task.successCriteria![0]!.checkedAt).toBe(result.report.completedAt);
  });

  it('includes expectedFileChanges analysis when task has file expectations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-files-'));
    roots.push(root);
    const { createBoard, addTask } = await import('../helpers/session-manager.js');

    const board = await createBoard(root, { title: 'File scope test' });
    const added = await addTask(root, board.id, {
      title: 'File scope task',
      expectedFileChanges: [{ path: 'src/test.ts', operation: 'modify' }],
    });
    if (!added) throw new Error('Failed to add task');

    const registry = new VerifierRegistry().register(new FakePassPlugin());
    const result = await verifyTaskCompletion(root, board.id, added.task.id, {
      registry,
      persist: false,
    });

    // FileScope should exist even though no actual diff exists
    expect(result.report.fileScope).toBeDefined();
    expect(result.report.fileScope!.expectedChanges).toBe(1);
    expect(result.report.fileScope!.scopeMatches).toBe(false); // no actual changes
  });
});
