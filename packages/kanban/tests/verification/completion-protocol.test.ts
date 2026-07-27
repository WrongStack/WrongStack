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
import { verifyTaskCompletion } from '../../src/verification/completion-protocol.js';
import { createDefaultRegistry } from '../../src/verification/plugins/index.js';
import { VerifierRegistry } from '../../src/verification/verifier-registry.js';
import type {
  KanbanCheck,
  KanbanVerificationCheckResult,
} from '../../src/types.js';
import type { VerificationContext } from '../../src/verification/verification-context.js';
import type { VerifierPlugin } from '../../src/verification/verifier-plugin.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// ── Helper to create a minimal board JSON ────────────────────────────────

async function createMinimalBoard(
  root: string,
  boardId: string,
  taskOverrides?: Record<string, unknown>,
) {
  const now = '2026-07-26T00:00:00.000Z';
  const taskId = 'task-1';
  // Re-use the createBoard from manager to get proper storage
  const { createBoard, addTask, addCheckToTask } = await import('../../src/manager.js');
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
    const { boardId, taskId } = await createMinimalBoard(root, 'b1', {
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
    const { boardId, taskId } = await createMinimalBoard(root, 'b1', {
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
    const { boardId, taskId } = await createMinimalBoard(root, 'b1');

    const result = await verifyTaskCompletion(root, boardId, taskId);

    // No criteria means no checks, no snapshot capture needed
    expect(result.report.verdict).toBe('passed');
    expect(result.report.checks).toHaveLength(0);
  });

  it('throws for a missing board', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-noboard-'));
    roots.push(root);

    await expect(
      verifyTaskCompletion(root, 'non-existent-board', 'task-1'),
    ).rejects.toThrow('Board not found');
  });

  it('throws for a missing task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-notask-'));
    roots.push(root);
    const { createBoard } = await import('../../src/manager.js');
    const board = await createBoard(root, { title: 'Test' });

    await expect(
      verifyTaskCompletion(root, board.id, 'non-existent-task'),
    ).rejects.toThrow('Task not found');
  });

  it('uses the default registry when none is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-default-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root, 'b1', {
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
    const { createBoard, addTask, updateTask } = await import('../../src/manager.js');

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
    const { createBoard, addTask, updateTask } = await import('../../src/manager.js');
    const { buildVerificationReport } = await import('../../src/verification/verification-report.js');

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

  it('handles mix of passed and failed criteria', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kanban-verify-mixed-'));
    roots.push(root);
    const { boardId, taskId } = await createMinimalBoard(root, 'b1', {
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
    const { boardId, taskId } = await createMinimalBoard(root, 'b1', {
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
    const { createBoard, addTask } = await import('../../src/manager.js');

    const board = await createBoard(root, { title: 'File scope test' });
    const added = await addTask(root, board.id, {
      title: 'File scope task',
      expectedFileChanges: [
        { path: 'src/test.ts', operation: 'modify' },
      ],
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
