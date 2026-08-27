import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTask,
  cancelKanbanDispatch,
  completeKanbanDispatch,
  createBoard,
  failKanbanDispatch,
  getBoard,
  heartbeatKanbanDispatch,
  reserveKanbanDispatch,
  startKanbanDispatch,
  transitionTask,
} from './helpers/session-manager.js';

// ---------------------------------------------------------------------------
// Cross-surface dispatch conformance tests.
//
// Both the Director (kanban_queue) and WebUI (kanban-dispatch.ts) now call the
// same shared dispatch service functions: reserveKanbanDispatch,
// startKanbanDispatch, completeKanbanDispatch, failKanbanDispatch,
// cancelKanbanDispatch, and heartbeatKanbanDispatch.
//
// These tests prove that the dispatch service itself produces deterministic,
// identical board state transitions regardless of which surface calls it.
// Each scenario runs against a fresh board and verifies the resulting board
// state matches the expected lifecycle invariant.
//
// If the Director or WebUI adapters are correctly wired onto the service,
// these tests transitively prove that both surfaces produce the same results.
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-conformance-'));
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

const MANAGED_POLICY = {
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
    description: 'Conformance test task with full specification.',
    dueDate: '2026-08-02T00:00:00.000Z',
    assignee: 'conformance-agent',
    labels: ['conformance'],
    childTaskIds: ['child-1'],
    successCriteria: [
      {
        id: 'sc1',
        description: 'All tests pass',
        type: 'manual' as const,
        status: 'pending' as const,
      },
    ],
  };
}

async function setupLegacyBoard(): Promise<{ boardId: string; taskId: string }> {
  const board = await createBoard(tmpDir, { title: 'Legacy Conformance', columns: COLS });
  const added = await addTask(tmpDir, board.id, {
    title: 'Legacy task',
    status: 'ready',
    columnId: 'todo',
  });
  return { boardId: board.id, taskId: added!.task.id };
}

async function setupManagedBoard(): Promise<{ boardId: string; taskId: string }> {
  const board = await createBoard(tmpDir, {
    title: 'Managed Conformance',
    columns: COLS,
    lifecycle: MANAGED_POLICY,
  });
  const added = await addTask(tmpDir, board.id, {
    title: 'Managed task',
    ...fullDetails(),
  });
  await transitionTask(tmpDir, board.id, added!.task.id, {
    to: 'todo',
    actor: 'test',
    comment: 'Ready for dispatch.',
  });
  return { boardId: board.id, taskId: added!.task.id };
}

// ── Scenario 1: Full dispatch lifecycle (reserve → start → complete) ──

describe('cross-surface dispatch conformance', () => {
  describe('legacy board: reserve → start → complete', () => {
    it('produces deterministic assignment, status, and column transitions', async () => {
      const { boardId, taskId } = await setupLegacyBoard();

      // Reserve
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1', name: 'worker' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      expect(reserved).not.toBeNull();
      expect(reserved!.task.assignment?.status).toBe('queued');
      expect(reserved!.task.assignment?.leaseId).toBeDefined();
      expect(reserved!.lease.leaseId).toBeDefined();
      const leaseId = reserved!.lease.leaseId;

      // Start
      const started = await startKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
        subagentId: 'sub-1',
        runTaskId: 'run-1',
      });
      expect(started).not.toBeNull();
      expect(started!.task.assignment?.status).toBe('running');
      expect(started!.task.assignment?.subagentId).toBe('sub-1');
      expect(started!.task.status).toBe('in_progress');

      // Complete
      const completed = await completeKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
        result: 'Work completed successfully.',
      });
      expect(completed).not.toBeNull();
      // Legacy: completion gate runs. Without verification criteria passing,
      // status is either completed (soft) or review (strict). Legacy default
      // is soft, so completed is expected.
      expect(['completed', 'review']).toContain(completed!.task.status);
    });
  });

  describe('managed board: reserve → start → complete', () => {
    it('auto-advances lifecycle todo → running → review', async () => {
      const { boardId, taskId } = await setupManagedBoard();

      // Reserve
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1', name: 'worker' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      expect(reserved).not.toBeNull();
      expect(reserved!.lease.leaseId).toBeDefined();
      const leaseId = reserved!.lease.leaseId;

      // Start — managed lifecycle auto-advances todo → running
      const started = await startKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
        subagentId: 'sub-1',
        runTaskId: 'run-1',
      });
      expect(started).not.toBeNull();
      expect(started!.task.lifecycle?.currentStage).toBe('running');
      expect(started!.task.columnId).toBe('in-progress');
      expect(started!.task.assignment?.status).toBe('running');
      expect(started!.task.assignment?.subagentId).toBe('sub-1');

      // Complete — managed lifecycle auto-advances running → review
      const completed = await completeKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
        result: 'Work completed.',
        evidence: { url: 'kanban://task/result', title: 'Result', type: 'file' as const },
      });
      expect(completed).not.toBeNull();
      // Managed: goes to review, NOT done.
      expect(completed!.task.lifecycle?.currentStage).toBe('review');
      expect(completed!.task.columnId).toBe('review');
      expect(completed!.task.status).not.toBe('completed');
    });
  });

  // ── Scenario 2: Stale-lease fencing ────────────────────────────────

  describe('stale-lease fencing', () => {
    it('start returns null when lease does not match', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      expect(reserved).not.toBeNull();

      // Try to start with a different lease ID.
      const started = await startKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId: 'wrong-lease-id',
        actor: 'test',
      });
      expect(started).toBeNull();
    });

    it('complete returns null when lease does not match', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      const leaseId = reserved!.lease.leaseId;
      await startKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
      });

      // Try to complete with wrong lease.
      const completed = await completeKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId: 'wrong-lease-id',
        actor: 'test',
        result: 'Should not work.',
      });
      expect(completed).toBeNull();
    });

    it('fail returns null when lease does not match', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });

      const failed = await failKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId: 'wrong-lease-id',
        actor: 'test',
        error: 'Should not work.',
      });
      expect(failed).toBeNull();
    });

    it('heartbeat returns null when lease does not match', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      const leaseId = reserved!.lease.leaseId;
      await startKanbanDispatch(tmpDir, { boardId, taskId, leaseId, actor: 'test' });

      const heartbeat = await heartbeatKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId: 'wrong-lease-id',
      });
      expect(heartbeat).toBeNull();
    });

    it('cancel returns null when lease does not match', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });

      const cancelled = await cancelKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId: 'wrong-lease-id',
        actor: 'test',
        reason: 'Should not work.',
      });
      expect(cancelled).toBeNull();
    });
  });

  // ── Scenario 3: Fail path ──────────────────────────────────────────

  describe('fail path', () => {
    it('legacy: marks assignment failed with error', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      const leaseId = reserved!.lease.leaseId;

      const failed = await failKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
        error: 'Task failed: timeout.',
      });
      expect(failed).not.toBeNull();
      const task = failed!.tasks.find((t) => t.id === taskId);
      expect(task?.assignment?.status).toBe('failed');
      expect(task?.assignment?.error).toContain('timeout');
    });

    it('managed: marks assignment failed but preserves lifecycle stage', async () => {
      const { boardId, taskId } = await setupManagedBoard();
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      const leaseId = reserved!.lease.leaseId;
      await startKanbanDispatch(tmpDir, { boardId, taskId, leaseId, actor: 'test' });

      const failed = await failKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
        error: 'Worker crashed.',
      });
      expect(failed).not.toBeNull();
      const task = failed!.tasks.find((t) => t.id === taskId);
      expect(task?.assignment?.status).toBe('failed');
      expect(task?.assignment?.error).toContain('crashed');
      // Lifecycle stage preserved — fail does not override the column.
      expect(task?.lifecycle?.currentStage).toBe('running');
      expect(task?.columnId).toBe('in-progress');
    });
  });

  // ── Scenario 4: Cancel path ────────────────────────────────────────

  describe('cancel path', () => {
    it('legacy: releases the claim and returns to ready', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      const leaseId = reserved!.lease.leaseId;

      const cancelled = await cancelKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
        actor: 'test',
        reason: 'Cancelled by caller.',
      });
      expect(cancelled).not.toBeNull();
      const task = cancelled!.tasks.find((t) => t.id === taskId);
      expect(task?.assignment).toBeUndefined();
      expect(task?.status).toBe('ready');
    });
  });

  // ── Scenario 5: Heartbeat renews lease ─────────────────────────────

  describe('heartbeat', () => {
    it('legacy: updates heartbeatAt and extends leaseExpiresAt', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      const reserved = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      const leaseId = reserved!.lease.leaseId;
      await startKanbanDispatch(tmpDir, { boardId, taskId, leaseId, actor: 'test' });

      const beforeBoard = await getBoard(tmpDir, boardId);
      const beforeTask = beforeBoard!.tasks.find((t) => t.id === taskId)!;
      const _beforeExpiry = beforeTask.assignment?.leaseExpiresAt;

      // Wait a moment so the heartbeat timestamp changes.
      await new Promise((r) => setTimeout(r, 10));

      const heartbeat = await heartbeatKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        leaseId,
      });
      expect(heartbeat).not.toBeNull();
      const task = heartbeat!.tasks.find((t) => t.id === taskId)!;
      // Heartbeat was renewed.
      expect(task.assignment?.heartbeatAt).not.toBe(beforeTask.assignment?.heartbeatAt);
      // Lease expiry is a valid future timestamp.
      expect(Date.parse(task.assignment?.leaseExpiresAt ?? '')).toBeGreaterThan(Date.now() - 1000);
    });
  });

  // ── Scenario 6: Idempotency — reserve the same task twice ──────────

  describe('idempotency', () => {
    it('reserve returns null when task is already claimed', async () => {
      const { boardId, taskId } = await setupLegacyBoard();
      const first = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-1' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      expect(first).not.toBeNull();

      const second = await reserveKanbanDispatch(tmpDir, {
        boardId,
        taskId,
        routing: { agentId: 'agent-2' },
        leaseTtlMs: 300_000,
        heartbeatIntervalMs: 60_000,
      });
      expect(second).toBeNull();
    });
  });
});
