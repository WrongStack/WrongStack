import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addDependency,
  addTask,
  assignTask,
  claimReadyTask,
  createBoard,
  getBoard,
  getKanbanQueueHealth,
  heartbeatTaskAssignment,
  listKanbanEvents,
  listReadyTasks,
  makeKanbanQueueTool,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  type SubagentConfig,
  type TaskResult,
  type TaskSpec,
  updateTaskAssignment,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../../tools/src/kanban.js';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-s2-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

/**
 * Sprint 2 reliable-queue focused coverage.
 *
 * Consolidates the four source files:
 *   kanban-reliable-queue.test.ts   (Sprint 1 lifecycle)
 *   kanban-queue-health.test.ts     (queue_health helper and tool action)
 *   kanban-recovery-router.test.ts  (auto mode policy decisions)
 *   kanban-cost-retry.test.ts       (costCeilingUsd / retryPolicy)
 *
 * Each scenario uses a fresh board so failure-mode tests never interact with
 * healthy-claim state.
 */
// ─────────────────────────────────────────────────────────────────────────
// Sprint 1 lifecycle: lease fields, heartbeat, recovery, events, dispatch
// ─────────────────────────────────────────────────────────────────────────

describe('Sprint 2 reliable queue (consolidated)', () => {
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

    const toolHeartbeat = await kanbanTool.execute(
      {
        action: 'heartbeat_assignment',
        boardId: board.id,
        taskId: claimed!.task.id,
        heartbeatAt: '2026-07-07T00:04:00.000Z',
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(toolHeartbeat).toMatchObject({ ok: true });
  });

  it('recovers expired queued / running assignments through the three explicit modes', async () => {
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
    expect(retried?.tasks[0]).toMatchObject({ status: 'ready', columnId: 'todo' });
    expect(retried?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(retried?.tasks[0]?.assignment?.leaseId).toBeUndefined();

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
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(released).toMatchObject({ ok: true, recoveredTasks: [{ status: 'ready' }] });

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
  });

  it('does not recover assignments with a fresh lease or no lease metadata', async () => {
    const board = await createBoard(tmpDir, { title: 'No-op recovery board' });
    await addTask(tmpDir, board.id, { title: 'Fresh lease work', status: 'ready' });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      agentId: 'worker-fresh',
      status: 'running',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    const unused = await createBoard(tmpDir, { title: 'Empty board' });
    expect(await recoverStaleTaskAssignments(tmpDir, unused.id, { mode: 'retry' })).toBeNull();
  });

  it('records an append-only event chain for the full lifecycle', async () => {
    const board = await createBoard(tmpDir, { title: 'Lifecycle event board' });
    const added = await addTask(tmpDir, board.id, { title: 'Lifecycle events', status: 'ready' });
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
    expect(events.map((e) => e.type)).toEqual([
      'task.claimed',
      'task.assignment.running',
      'task.assignment.heartbeat',
      'task.assignment.completed',
    ]);
  });

  it('bridges recovery into the append-only event chain', async () => {
    const board = await createBoard(tmpDir, { title: 'Recovery event board' });
    const added = await addTask(tmpDir, board.id, { title: 'Recovered work', status: 'ready' });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-rel',
      status: 'running',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    await releaseTaskClaim(tmpDir, board.id, added!.task.id, { reason: 'manual release', status: 'blocked' });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-rel-2',
      status: 'running',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    // Third release omits status so the task returns to `ready` (no deps)
    await releaseTaskClaim(tmpDir, board.id, added!.task.id, { reason: 'reset for re-claim' });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-rel-3',
      status: 'running',
      leaseExpiresAt: '1999-01-01T00:00:00.000Z',
    });
    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'fail',
      now: '2099-02-01T00:00:00.000Z',
      reason: 'worker vanished',
    });
    const events = await listKanbanEvents(tmpDir, board.id);
    expect(events.map((e) => e.type)).toContain('task.stale_recovered');
    expect(events.map((e) => e.type)).toContain('task.released');
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
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(created).toMatchObject({ ok: true });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      role: 'implementer',
    });
    const claimed = await kanbanTool.execute(
      {
        action: 'claim_task',
        boardId: board.id,
        agentId: 'worker-tool',
        status: 'running',
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(claimed).toMatchObject({ ok: true, message: 'Task claimed.' });
  });

  it('seeds lease metadata in the Director queue dispatcher prompt and assignment', async () => {
    const board = await createBoard(tmpDir, { title: 'Director lease board' });
    const added = await addTask(tmpDir, board.id, {
      title: 'Dispatch via kanban_queue',
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
    const fakeDirector = {
      spawn: async (config: SubagentConfig) => {
        spawns.push(config);
        return 'sub-lease';
      },
      assign: async (spec: TaskSpec) => {
        assignments.push(spec);
        return 'fleet-task-lease';
      },
      awaitTasks: async (): Promise<TaskResult[]> => [
        {
          subagentId: 'sub-lease',
          taskId: 'fleet-task-lease',
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
      { boardId: board.id, heartbeatIntervalMs: 30_000, leaseTtlMs: 120_000, awaitCompletion: true },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ ok: true, count: 1 });
    const prompt = assignments[0]?.description ?? '';
    expect(prompt).toContain('Lease contract');
    expect(prompt).toContain('heartbeat_assignment');
    expect(prompt).toContain('recover_stale');
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment?.leaseId).toBeTruthy();
    expect(loaded?.tasks[0]?.assignment?.leaseExpiresAt).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sprint 2: queue-health helper and tool action
  // ───────────────────────────────────────────────────────────────────────

  it('queue_health: produces counts and signal buckets that match board state and event log', async () => {
    const board = await createBoard(tmpDir, { title: 'Health board' });
    const blocker = await addTask(tmpDir, board.id, { title: 'Blocker', status: 'pending' });
    const blockedReady = await addTask(tmpDir, board.id, {
      title: 'Waiting on blocker',
      status: 'ready',
    });
    await addDependency(tmpDir, board.id, blockedReady!.task.id, blocker!.task.id);
    const runnable = await addTask(tmpDir, board.id, { title: 'Runnable', status: 'ready' });
    const staleCandidate = await addTask(tmpDir, board.id, { title: 'Stale', status: 'ready' });

    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: runnable!.task.id,
      agentId: 'worker-r',
      status: 'running',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    await updateTaskAssignment(tmpDir, board.id, runnable!.task.id, {
      status: 'running',
      subagentId: 'sub-r',
      runTaskId: 'run-r',
    });
    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: staleCandidate!.task.id,
      agentId: 'worker-s',
      status: 'running',
      leaseExpiresAt: '2024-01-01T00:00:00.000Z',
    });

    const health = await getKanbanQueueHealth(tmpDir, {
      boardId: board.id,
      now: '2030-01-01T00:00:00.000Z',
    });
    expect(health.counts.pending).toBe(1);
    expect(health.counts.running).toBe(2);
    expect(health.counts.ready).toBe(1);
    expect(health.dependencyBlocked.count).toBe(1);
    expect(health.staleAssignments.count).toBe(2);
    expect(health.heartbeatDue.count).toBe(2);
    expect(health.failedRetryable.count).toBe(0);
  });

  it('queue_health: tool action exposes dependencyBlocked as a subset of ready', async () => {
    const board = await createBoard(tmpDir, { title: 'Tool action board' });
    const blocker = await addTask(tmpDir, board.id, { title: 'Blocker', status: 'pending' });
    const blockedReady = await addTask(tmpDir, board.id, {
      title: 'Waiting on blocker',
      status: 'ready',
    });
    await addDependency(tmpDir, board.id, blockedReady!.task.id, blocker!.task.id);
    await addTask(tmpDir, board.id, { title: 'Free ready', status: 'ready' });

    const toolResult = await kanbanTool.execute(
      { action: 'queue_health', boardId: board.id },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(toolResult).toMatchObject({ ok: true });
    const health = (toolResult as { queueHealth?: { counts: { ready: number }; dependencyBlocked: { count: number; tasks: unknown[] } } }).queueHealth;
    expect(health).toBeDefined();
    expect(health?.dependencyBlocked.count).toBeGreaterThan(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sprint 2: cost ceiling and retry policy
  // ───────────────────────────────────────────────────────────────────────

  it('cost/retry: persists cost ceiling and retry policy across claim and worker updates', async () => {
    const board = await createBoard(tmpDir, { title: 'Cost/retry board' });
    const task = await addTask(tmpDir, board.id, { title: 'Bounded work', status: 'ready' });
    const assigned = await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
      costCeilingUsd: 1.25,
      retryPolicy: 'exponential',
      maxAttempts: 3,
    });
    expect(assigned?.tasks[0]?.assignment).toMatchObject({
      costCeilingUsd: 1.25,
      retryPolicy: 'exponential',
    });
    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: task!.task.id,
      agentId: 'worker-econ',
      status: 'running',
    });
    expect(claimed?.task.assignment).toMatchObject({
      costCeilingUsd: 1.25,
      retryPolicy: 'exponential',
    });
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'running',
      subagentId: 'sub-econ',
      runTaskId: 'run-econ',
      costCeilingUsd: 2,
      retryPolicy: 'incremental',
      lastFailureKind: 'tool_timeout',
    });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'running',
      costCeilingUsd: 2,
      retryPolicy: 'incremental',
      lastFailureKind: 'tool_timeout',
    });
  });

  it('cost/retry: tool surface carries costCeilingUsd and retryPolicy', async () => {
    const board = await createBoard(tmpDir, { title: 'Tool cost/retry board' });
    const created = await kanbanTool.execute(
      {
        action: 'add_task',
        boardId: board.id,
        title: 'Tool routed work',
        role: 'implementer',
        provider: 'openai',
        model: 'gpt-5',
        tools: ['bash'],
        allowedCapabilities: ['fs.write'],
        costCeilingUsd: 0.5,
        retryPolicy: 'incremental',
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(created).toMatchObject({ ok: true });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toMatchObject({
      status: 'assigned',
      costCeilingUsd: 0.5,
      retryPolicy: 'incremental',
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Sprint 2: recovery router (auto mode policy decisions)
  // ───────────────────────────────────────────────────────────────────────

  async function setupStale() {
    const board = await createBoard(tmpDir, { title: 'Router board' });
    const task = await addTask(tmpDir, board.id, { title: 'Stale candidate', status: 'ready' });
    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: task!.task.id,
      agentId: 'worker-r',
      status: 'running',
      leaseExpiresAt: '2024-01-01T00:00:00.000Z',
    });
    expect(claimed).not.toBeNull();
    return { board, task: task!.task };
  }

  it('router: explicit retry mode (default back-compat)', async () => {
    const { board, task } = await setupStale();
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
      now: '2030-01-01T00:00:00.000Z',
    });
    expect(result?.tasks[0]).toMatchObject({ status: 'ready' });
    expect(result?.tasks[0]?.assignment).toMatchObject({ status: 'assigned' });
  });

  it('router: auto mode fails when retryPolicy is "off"', async () => {
    const { board, task } = await setupStale();
    await updateTaskAssignment(tmpDir, board.id, task.id, { status: 'running', retryPolicy: 'off' });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
    });
    expect(result?.tasks[0]).toMatchObject({ status: 'failed' });
  });

  it('router: auto mode fails when policy says fail-on-cost and costCeilingUsd is set', async () => {
    const { board, task } = await setupStale();
    await updateTaskAssignment(tmpDir, board.id, task.id, { status: 'running', costCeilingUsd: 0.5 });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
      policy: { failWhenCostCeilingSet: true },
    });
    expect(result?.tasks[0]).toMatchObject({ status: 'failed' });
  });

  it('router: auto mode releases when policy says release-on-failure-kind', async () => {
    const { board, task } = await setupStale();
    await updateTaskAssignment(tmpDir, board.id, task.id, { status: 'running', lastFailureKind: 'tool_timeout' });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
      policy: { releaseOnFailureKinds: ['tool_timeout'] },
    });
    expect(result?.tasks[0]).toMatchObject({ status: 'ready' });
    expect(result?.tasks[0]?.assignment).toBeUndefined();
  });

  it('router: auto mode falls back to retry when no policy rule matches', async () => {
    const { board, task } = await setupStale();
    await updateTaskAssignment(tmpDir, board.id, task.id, { status: 'running', attempt: 2, maxAttempts: 5 });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2030-01-01T00:00:00.000Z',
      policy: { releaseOnFailureKinds: ['provider_outage'] },
    });
    expect(result?.tasks[0]).toMatchObject({ status: 'ready' });
    expect(result?.tasks[0]?.assignment).toMatchObject({ status: 'assigned', attempt: 3 });
  });

  it('router: per-task note includes the resolved mode and original reason', async () => {
    const { board } = await setupStale();
    await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      now: '2030-01-01T00:00:00.000Z',
      reason: 'worker-cancel',
    });
    const loaded = await getBoard(tmpDir, board.id);
    const note = loaded?.tasks[0]?.notes?.find((n) =>
      n.content.includes('worker-cancel'),
    );
    expect(note).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Sprint 3 — Cost/Retry lifecycle propagation
  // ---------------------------------------------------------------------------

  it('S3: preserves durable retryPolicy and costCeilingUsd through release and re-claim', async () => {
    const board = await createBoard(tmpDir, { title: 'S3 lifecycle board' });
    const added = await addTask(tmpDir, board.id, { title: 'Policy carrier', status: 'ready' });
    await assignTask(tmpDir, board.id, added!.task.id, {
      role: 'implementer',
      retryPolicy: 'exponential',
      costCeilingUsd: 5,
      maxAttempts: 3,
    });

    let loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.retryPolicy).toBe('exponential');
    expect(loaded?.tasks[0]?.costCeilingUsd).toBe(5);

    await releaseTaskClaim(tmpDir, board.id, added!.task.id, { reason: 'test release', status: 'ready' });
    loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment).toBeUndefined();
    expect(loaded?.tasks[0]?.retryPolicy).toBe('exponential');
    expect(loaded?.tasks[0]?.costCeilingUsd).toBe(5);

    await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-s3',
      status: 'running',
    });
    loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.retryPolicy).toBe('exponential');
    expect(loaded?.tasks[0]?.costCeilingUsd).toBe(5);
  });

  it('S3: creates durable task fields from assignment in add_task via the tool', async () => {
    const board = await createBoard(tmpDir, { title: 'S3 tool board' });
    const result = await kanbanTool.execute(
      {
        action: 'add_task',
        boardId: board.id,
        title: 'Tool policy work',
        role: 'implementer',
        retryPolicy: 'incremental',
        costCeilingUsd: 2.5,
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ ok: true });
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.retryPolicy).toBe('incremental');
    expect(loaded?.tasks[0]?.costCeilingUsd).toBe(2.5);
    expect(loaded?.tasks[0]?.assignment?.status).toBe('assigned');
    expect(loaded?.tasks[0]?.assignment?.retryPolicy).toBe('incremental');
  });

  it('S3: fleet prompt includes retry policy block', async () => {
    const board = await createBoard(tmpDir, { title: 'S3 prompt board' });
    const task = await addTask(tmpDir, board.id, { title: 'Prompt check', status: 'ready' });
    await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      retryPolicy: 'exponential',
      costCeilingUsd: 7,
      maxAttempts: 3,
      provider: 'openai',
      model: 'gpt-5',
    });

    const spawns: SubagentConfig[] = [];
    const assignments: TaskSpec[] = [];
    const fakeDirector = {
      getRemainingBudgetUsd: () => undefined,
      spawn: async (config: SubagentConfig) => {
        spawns.push(config);
        return 'sub-s3p';
      },
      assign: async (spec: TaskSpec) => {
        assignments.push(spec);
        return 'fleet-task-s3p';
      },
      awaitTasks: async (_taskIds: string[]): Promise<TaskResult[]> => [
        {
          subagentId: 'sub-s3p',
          taskId: 'fleet-task-s3p',
          status: 'success',
          result: 'ok',
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        },
      ],
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);
    await tool.execute(
      { boardId: board.id, awaitCompletion: true },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(assignments[0]?.description).toContain('Retry policy:');
    expect(assignments[0]?.description).toContain('retryPolicy: exponential');
    expect(assignments[0]?.description).toContain('maxAttempts: 3');
    expect(assignments[0]?.description).toContain('costCeilingUsd: 7');
  });

  it('S3: director dispatch seeds maxCostUsd on spawned config', async () => {
    const board = await createBoard(tmpDir, { title: 'S3 cc board' });
    const task = await addTask(tmpDir, board.id, { title: 'Cost capped', status: 'ready' });
    await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      costCeilingUsd: 3,
      provider: 'openai',
      model: 'gpt-5',
    });

    const spawns: SubagentConfig[] = [];
    const assignments: TaskSpec[] = [];
    const fakeDirector = {
      getRemainingBudgetUsd: () => 10,
      spawn: async (config: SubagentConfig) => {
        spawns.push(config);
        return 'sub-cc';
      },
      assign: async (spec: TaskSpec) => {
        assignments.push(spec);
        return 'fleet-task-cc';
      },
      awaitTasks: async (_taskIds: string[]): Promise<TaskResult[]> => [
        {
          subagentId: 'sub-cc',
          taskId: 'fleet-task-cc',
          status: 'success',
          result: 'ok',
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        },
      ],
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);
    await tool.execute(
      { boardId: board.id, awaitCompletion: true },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    expect(spawns[0]?.maxCostUsd).toBe(3);
  });

  it('S3: budget gate skips dispatch when remaining budget is less than costCeilingUsd', async () => {
    const board = await createBoard(tmpDir, { title: 'S3 budget board' });
    const task = await addTask(tmpDir, board.id, { title: 'Over budget', status: 'ready' });
    await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      costCeilingUsd: 999,
      provider: 'openai',
      model: 'gpt-5',
    });

    const fakeDirector = {
      getRemainingBudgetUsd: () => 1,
      spawn: async () => { throw new Error('should not spawn'); },
      assign: async () => { throw new Error('should not assign'); },
      awaitTasks: async (_taskIds: string[]): Promise<TaskResult[]> => [],
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);
    const result = await tool.execute(
      { boardId: board.id },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );
    // The dispatch should complete but the task should be marked failed with a budget error.
    expect(result).toMatchObject({ ok: false, count: 0 });
    expect(result.errors).toBeDefined();
    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.tasks[0]?.assignment?.status).toBe('failed');
    expect(loaded?.tasks[0]?.assignment?.error).toContain('exceeds remaining budget');
  });

  it('S3: recover_stale auto mode reads assignment retryPolicy (off -> fail)', async () => {
    const board = await createBoard(tmpDir, { title: 'S3 retryPolicy board' });
    const added = await addTask(tmpDir, board.id, { title: 'Retry off', status: 'ready' });
    const claimed = await claimReadyTask(tmpDir, {
      boardId: board.id,
      taskId: added!.task.id,
      agentId: 'worker-rp',
      status: 'running',
      leaseExpiresAt: '1999-01-01T00:00:00.000Z',
      retryPolicy: 'off',
      maxAttempts: 5,
    });
    expect(claimed).not.toBeNull();

    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'auto',
      now: '2099-02-01T00:00:00.000Z',
    });
    expect(result?.tasks[0]).toMatchObject({ status: 'failed' });
    expect(result?.tasks[0]?.assignment).toMatchObject({ status: 'failed' });
  });
});
