import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeKanbanQueueTool } from '@wrongstack/core/coordination';
import type { SubagentConfig, TaskResult, TaskSpec } from '@wrongstack/core/types';
import { createBoard, getBoard, listKanbanEvents, listReadyTasks } from '@wrongstack/kanban';
import {
  addTask,
  assignTask,
  claimReadyTask,
  heartbeatTaskAssignment,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  updateTaskAssignment,
} from '@wrongstack/kanban/test-support';
import { wireKanbanPorts } from '@wrongstack/runtime';
import { kanbanTool } from '@wrongstack/tools/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Session that owns the board events these queue tests write. */
const TEST_QUEUE_SESSION_ID = '2026-08-26/sess_01TESTKANBANQUEUE0000000';

wireKanbanPorts();

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-relq-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

/**
 * Sprint 1 "reliable queue" contract coverage.
 *
 * This focused suite walks Kanban through its new orchestration primitives
 * in a single continuous lifecycle per scenario, verifying both manager-level
 * state and the public `kanban` tool surface:
 *
 *   1. Lease field normalization on claim (backward-compatible).
 *   2. Heartbeat refresh without disturbing owner/result/error fields.
 *   3. Stale claim recovery (retry / release / fail) plus per-mode notes.
 *   4. Append-only event emission for claim / running / heartbeat /
 *      completed / released / stale_recovered transitions.
 *   5. `kanban_queue` Director dispatch seeding lease metadata and emitting
 *      a prompt that wires the worker into the same contract.
 *
 * Scenarios use fresh boards per `it` so failed-task mode never interacts with
 * healthy-claim state.
 */

describe('Kanban reliable queue semantics (Sprint 1 focused package)', () => {
  it('seeds and preserves assignment lease metadata through claim and running transitions', async () => {
    const board = await createBoard(tmpDir, { title: 'Lease preservation board' });
    const added = await addTask(tmpDir, board.id, {
      title: 'Preserve lease fields',
      status: 'ready',
    });
    await assignTask(tmpDir, board.id, added!.task.id, {
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      leaseId: 'lease-original',
      claimedAt: '2026-07-07T00:00:00.000Z',
      heartbeatAt: '2026-07-07T00:01:00.000Z',
      leaseExpiresAt: '2026-07-07T00:05:00.000Z',
      attempt: 2,
      maxAttempts: 3,
    });

    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-1',
    });

    expect(claimed?.task.assignment).toMatchObject({
      status: 'queued',
      agentId: 'worker-1',
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      leaseId: 'lease-original',
      claimedAt: '2026-07-07T00:00:00.000Z',
      heartbeatAt: '2026-07-07T00:01:00.000Z',
      leaseExpiresAt: '2026-07-07T00:05:00.000Z',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(claimed?.task.status).toBe('ready');

    await updateTaskAssignment(tmpDir, board.id, claimed!.task.id, {
      status: 'running',
      subagentId: 'sub-1',
      runTaskId: 'run-1',
    });

    const ready = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(ready.find((entry) => entry.task.id === claimed!.task.id)).toBeUndefined();
  });

  it('keeps heartbeat semantics narrow: ownership and results survive a lease refresh', async () => {
    const board = await createBoard(tmpDir, { title: 'Heartbeat isolation board' });
    const added = await addTask(tmpDir, board.id, {
      title: 'Long-running work',
      status: 'ready',
    });
    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-hb',
      status: 'running',
      leaseId: 'lease-hb',
      leaseExpiresAt: '2026-07-07T00:05:00.000Z',
    });
    await updateTaskAssignment(tmpDir, board.id, claimed!.task.id, {
      status: 'running',
      subagentId: 'sub-hb',
      runTaskId: 'run-hb',
      lastResult: 'progress-so-far',
    });

    const refreshed = await heartbeatTaskAssignment(tmpDir, board.id, claimed!.task.id, {
      heartbeatAt: '2026-07-07T00:03:00.000Z',
      leaseExpiresAt: '2026-07-07T00:08:00.000Z',
    });

    expect(refreshed?.tasks[0]).toMatchObject({
      status: 'in_progress',
      columnId: 'in-progress',
    });
    expect(refreshed?.tasks[0]?.assignment).toMatchObject({
      agentId: 'worker-hb',
      subagentId: 'sub-hb',
      runTaskId: 'run-hb',
      lastResult: 'progress-so-far',
      leaseId: 'lease-hb',
      heartbeatAt: '2026-07-07T00:03:00.000Z',
      leaseExpiresAt: '2026-07-07T00:08:00.000Z',
    });
    expect(refreshed?.tasks[0]?.assignment?.error).toBeUndefined();

    const toolResult = await kanbanTool.execute(
      {
        action: 'heartbeat_assignment',
        boardId: board.id,
        taskId: claimed!.task.id,
        heartbeatAt: '2026-07-07T00:04:00.000Z',
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );
    expect(toolResult).toMatchObject({ ok: true });

    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      agentId: 'worker-hb',
      subagentId: 'sub-hb',
      runTaskId: 'run-hb',
      lastResult: 'progress-so-far',
      heartbeatAt: '2026-07-07T00:04:00.000Z',
      leaseExpiresAt: '2026-07-07T00:08:00.000Z',
    });
  });

  it('recovers expired queued and running assignments through the three modes', async () => {
    const retryBoard = await createBoard(tmpDir, { title: 'Retry recovery board' });
    const retryTask = await addTask(tmpDir, retryBoard.id, {
      title: 'Retry stale work',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: retryBoard.id,
      taskId: retryTask!.task.id,
      agentId: 'worker-retry',
      status: 'running',
      leaseId: 'lease-retry',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
      attempt: 1,
      maxAttempts: 3,
    });

    const retried = await recoverStaleTaskAssignments(tmpDir, retryBoard.id, {
      mode: 'retry',
      now: '2026-07-07T00:02:00.000Z',
      reason: 'worker heartbeat expired',
    });
    expect(retried?.tasks).toHaveLength(1);
    expect(retried?.tasks[0]).toMatchObject({ status: 'ready', columnId: 'todo' });
    expect(retried?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(retried?.tasks[0]?.assignment?.leaseId).toBeUndefined();
    expect(retried?.tasks[0]?.assignment?.subagentId).toBeUndefined();
    expect(retried?.tasks[0]?.notes?.[0]?.content).toContain('worker heartbeat expired');

    const releaseBoard = await createBoard(tmpDir, { title: 'Release recovery board' });
    const releaseTask = await addTask(tmpDir, releaseBoard.id, {
      title: 'Release stale work',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: releaseBoard.id,
      taskId: releaseTask!.task.id,
      agentId: 'worker-release',
      status: 'running',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
    });

    const released = await kanbanTool.execute(
      {
        action: 'recover_stale',
        boardId: releaseBoard.id,
        recoveryMode: 'release',
        recoveryNow: '2026-07-07T00:02:00.000Z',
        releaseReason: 'worker unavailable',
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );
    expect(released).toMatchObject({ ok: true, recoveredTasks: [{ status: 'ready' }] });
    const releasedLoaded = await getBoard(tmpDir, releaseBoard.id);
    expect(releasedLoaded?.tasks[0]?.assignment).toBeUndefined();
    expect(releasedLoaded?.tasks[0]?.notes?.[0]?.content).toContain('worker unavailable');

    const failBoard = await createBoard(tmpDir, { title: 'Fail recovery board' });
    const failTask = await addTask(tmpDir, failBoard.id, {
      title: 'Fail stale work',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: failBoard.id,
      taskId: failTask!.task.id,
      agentId: 'worker-fail',
      status: 'running',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
    });

    const failed = await recoverStaleTaskAssignments(tmpDir, failBoard.id, {
      mode: 'fail',
      now: '2026-07-07T00:02:00.000Z',
      reason: 'worker lost',
    });
    expect(failed?.tasks[0]).toMatchObject({ status: 'failed', columnId: 'review' });
    expect(failed?.tasks[0]?.assignment).toMatchObject({
      status: 'failed',
      error: 'worker lost',
    });
  });

  it('does not recover assignments that have a fresh lease or no lease metadata', async () => {
    const board = await createBoard(tmpDir, { title: 'No-op recovery board' });
    const fresh = await addTask(tmpDir, board.id, {
      title: 'Fresh lease work',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: fresh!.task.id,
      agentId: 'worker-fresh',
      status: 'running',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });

    const unusedBoard = await createBoard(tmpDir, { title: 'Empty board' });
    const noRecovery = await recoverStaleTaskAssignments(tmpDir, unusedBoard.id, {
      mode: 'retry',
      now: '2026-07-07T00:02:00.000Z',
    });

    expect(noRecovery).toBeNull();
    const unchangedFresh = await getBoard(tmpDir, board.id);
    expect(unchangedFresh?.tasks[0]?.status).toBe('in_progress');
    expect(unchangedFresh?.tasks[0]?.assignment).toMatchObject({
      status: 'running',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  it('records an append-only event chain for the full lifecycle', async () => {
    const board = await createBoard(tmpDir, { title: 'Lifecycle event board' });
    const added = await addTask(tmpDir, board.id, {
      title: 'Lifecycle events',
      status: 'ready',
    });

    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-evt',
      status: 'running',
      leaseExpiresAt: '2026-07-07T00:01:00.000Z',
    });
    await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
      status: 'running',
      subagentId: 'sub-evt',
      runTaskId: 'run-evt',
    });
    await heartbeatTaskAssignment(tmpDir, board.id, added!.task.id, {
      heartbeatAt: '2026-07-07T00:00:30.000Z',
    });
    await updateTaskAssignment(tmpDir, board.id, added!.task.id, {
      status: 'completed',
      lastResult: 'ok',
    });

    const events = await listKanbanEvents(tmpDir, board.id);

    expect(events.map((event) => event.type)).toEqual([
      'task.created',
      'task.claimed',
      'task.assignment.running',
      'task.assignment.heartbeat',
      'task.assignment.completed',
      'task.completion.gate_pending',
    ]);

    const completedEvent = events.find((event) => event.type === 'task.assignment.completed');
    expect(completedEvent?.taskId).toBe(added!.task.id);
    expect(completedEvent?.actor).toBe('worker-evt');
    expect(completedEvent?.subagentId).toBe('sub-evt');
    expect(completedEvent?.runTaskId).toBe('run-evt');

    const toolEvents = await kanbanTool.execute(
      {
        action: 'events',
        boardId: board.id,
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );
    expect(toolEvents).toMatchObject({ ok: true });
    expect(toolEvents?.events?.length).toBe(events.length);
  });

  it('bridges recovery into the same append-only event chain', async () => {
    const board = await createBoard(tmpDir, { title: 'Recovery event board' });
    const added = await addTask(tmpDir, board.id, {
      title: 'Released stale',
      status: 'ready',
    });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-rel',
      status: 'running',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });

    await releaseTaskClaim(tmpDir, board.id, added!.task.id, {
      reason: 'manual release',
      status: 'blocked',
    });

    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-rel-2',
      status: 'running',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });

    // Force the recovery to observe the second claim as stale by passing a
    // checkedAt beyond its leaseExpiresAt. This avoids depending on real wall
    // time inside the test environment.
    const staleLease = '1999-01-01T00:00:00.000Z';
    await releaseTaskClaim(tmpDir, board.id, added!.task.id, { reason: 'reset for re-claim' });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-rel-3',
      status: 'running',
      leaseExpiresAt: staleLease,
    });

    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'fail',
      now: '2099-02-01T00:00:00.000Z',
      reason: 'worker vanished',
    });

    const events = await listKanbanEvents(tmpDir, board.id);
    expect(events.map((event) => event.type)).toContain('task.stale_recovered');
    expect(events.map((event) => event.type)).toContain('task.released');
    const stale = events.find((event) => event.type === 'task.stale_recovered');
    expect(stale?.note).toContain('worker vanished');
  });

  it('keeps the kanban tool surface contract-compatible with the manager APIs', async () => {
    const board = await createBoard(tmpDir, { title: 'Tool bridge board' });
    const created = await kanbanTool.execute(
      {
        action: 'add_task',
        boardId: board.id,
        title: 'Routed task from tool',
        role: 'implementer',
        provider: 'openai',
        model: 'gpt-5',
        tools: ['bash'],
        allowedCapabilities: ['fs.write'],
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );
    expect(created).toMatchObject({ ok: true });

    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
    });

    const claimed = await kanbanTool.execute(
      {
        action: 'claim_task',
        boardId: board.id,
        agentId: 'worker-tool',
        status: 'running' as never,
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );
    expect(claimed).toMatchObject({ ok: true, message: 'Task claimed.' });

    const recovered = await kanbanTool.execute(
      {
        action: 'recover_stale',
        boardId: board.id,
        recoveryMode: 'release',
        // No expired leases exist; call should return ok with empty list.
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );
    expect(recovered).toMatchObject({ ok: true, recoveredTasks: [] });
  });

  it('seeds lease metadata in the Director queue dispatcher prompt and assignment', async () => {
    const board = await createBoard(tmpDir, { title: 'Director lease board' });
    const added = await addTask(tmpDir, board.id, {
      title: 'Dispatch via kanban_queue',
      description: 'Wire lease and heartbeat instructions.',
      status: 'ready',
      priority: 'high',
    });
    await assignTask(tmpDir, board.id, added!.task.id, {
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
    });

    const spawns: SubagentConfig[] = [];
    const assignments: TaskSpec[] = [];
    let assignedRunTaskId = '';
    const fakeDirector = {
      spawn: async (config: SubagentConfig) => {
        spawns.push(config);
        return 'sub-lease-1';
      },
      assign: async (spec: TaskSpec) => {
        assignments.push(spec);
        assignedRunTaskId = spec.id;
        return spec.id;
      },
      awaitTasks: async (): Promise<TaskResult[]> => [
        {
          subagentId: 'sub-lease-1',
          taskId: assignedRunTaskId,
          status: 'success',
          result: 'lease wired',
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        },
      ],
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);

    const result = await tool.execute(
      {
        boardId: board.id,
        heartbeatIntervalMs: 30_000,
        leaseTtlMs: 120_000,
        awaitCompletion: true,
      },
      { projectRoot: tmpDir, eventSessionId: () => TEST_QUEUE_SESSION_ID } as never,
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({ ok: true, count: 1 });
    const prompt = assignments[0]?.description ?? '';
    expect(prompt).toContain('Lease contract');
    expect(prompt).toContain('leaseExpiresAt:');
    expect(prompt).toContain('expected heartbeatIntervalMs: 30000');
    expect(prompt).toContain('expected leaseTtlMs: 120000');
    expect(prompt).toContain('heartbeat_assignment');
    expect(prompt).toContain('recover_stale');

    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'completed',
      subagentId: 'sub-lease-1',
      runTaskId: assignedRunTaskId,
      lastResult: 'lease wired',
    });
    expect(loaded?.tasks[0]?.assignment?.leaseId).toBeTruthy();
    expect(loaded?.tasks[0]?.assignment?.leaseExpiresAt).toBeTruthy();

    const events = await listKanbanEvents(tmpDir, board.id);
    expect(events.map((event) => event.type)).toEqual([
      'task.created',
      'task.assigned',
      'task.claimed',
      'task.assignment.running',
      'task.assignment.completed',
      'task.completion.gate_pending',
      'task.verified',
    ]);
    expect(spawns[0]?.tools).toEqual(['bash', 'kanban']);
  });
});

// Local helper removed: the recovery-event scenario calls
// releaseTaskClaim and claimReadyTask inline above.
