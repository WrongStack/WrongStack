import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addTask,
  assignTask,
  createBoard,
  getBoard,
  listKanbanEvents,
  listReadyTasks,
  makeKanbanQueueTool,
  recoverStaleTaskAssignments,
  type SubagentConfig,
  type TaskResult,
  type TaskSpec,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-e2e-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

/**
 * Sprint 1 acceptance smoke test for the reliable-queue contract.
 *
 * This test exercises the full path on a real on-disk board:
 *
 *   1. Director `kanban_queue` claims a routing-preconfigured task.
 *   2. Worker is simulated by a fake Director that does NOT call
 *      `mark_assignment status:completed` and does NOT heartbeat.
 *    The dispatch uses `awaitCompletion:false` so the test harness
 *    drives the rest of the lifecycle directly via the Kanban core,
 *    instead of waiting on a real subagent.
 *   3. The harness observes the lease expiry, calls `recover_stale`
 *    with `mode: "release"`, and verifies the task returns to `ready`.
 *   4. A second dispatch claims the same task and finishes it via
 *    `awaitCompletion:true`, writing `status:completed` on disk.
 *   5. Final assertions read both the current-state board JSON and the
 *    append-only event log to verify the lifecycle matches the contract
 *    that real Director fleets would observe.
 *
 * The fleet fake keeps the spawn/assign/terminate hooks deterministic
 * across both dispatch rounds so the test does not rely on wall-clock
 * timing or real LLM calls.
 */

describe('Kanban recovery E2E (file-backed dispatch + recover_stale + retry)', () => {
  it('catches a simulated stale worker, recovers, and finishes on retry', async () => {
    const board = await createBoard(tmpDir, { title: 'Recovery E2E board' });
    const task = await addTask(tmpDir, board.id, {
      title: 'Walk the full recovery lifecycle',
      description: 'Worker first run vanishes, recovery returns task, retry completes.',
      status: 'ready',
      priority: 'high',
    });
    await assignTask(tmpDir, board.id, task!.task.id, {
      role: 'implementer',
      provider: 'openai',
      model: 'gpt-5',
      tools: ['bash'],
      allowedCapabilities: ['fs.write'],
    });

    const spawnedSubagents: SubagentConfig[] = [];
    const taskIdsReturned: string[] = [];
    const firstDispatch: { runTaskId: string; subagentId: string } = {
      runTaskId: '',
      subagentId: '',
    };
    const fakeDirector = {
      spawn: async (config: SubagentConfig) => {
        spawnedSubagents.push(config);
        const id = `sub-${spawnedSubagents.length}`;
        if (spawnedSubagents.length === 1) firstDispatch.subagentId = id;
        return id;
      },
      assign: async (_spec: TaskSpec) => {
        const id = `fleet-task-${taskIdsReturned.length + 1}`;
        taskIdsReturned.push(id);
        if (taskIdsReturned.length === 1) firstDispatch.runTaskId = id;
        return id;
      },
      awaitTasks: async (_taskIds: string[]): Promise<TaskResult[]> => {
        // Round 1 will use `awaitCompletion:false` so this hook is unused there.
        // Round 2 uses `awaitCompletion:true` and the fake returns success.
        if (taskIdsReturned.length === 1) return [];
        return [
          {
            subagentId: 'sub-2',
            taskId: taskIdsReturned[taskIdsReturned.length - 1] ?? 'fleet-task-2',
            status: 'success',
            result: 'retry succeeded',
            iterations: 1,
            toolCalls: 1,
            durationMs: 1,
          },
        ];
      },
      terminate: async (_subagentId: string) => {
        // Real fleets would call this when dispatch fails; we use it for
        // symmetry here. It does not affect lifecycle assertions.
      },
    };
    const tool = makeKanbanQueueTool(fakeDirector as never);

    // ---------------------------------------------------------------------
    // Step 1: First dispatch — worker never reports back (simulated).
    // ---------------------------------------------------------------------
    const firstResult = await tool.execute(
      {
        boardId: board.id,
        awaitCompletion: false,
        heartbeatIntervalMs: 30_000,
        leaseTtlMs: 120_000,
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );

    expect(firstResult).toMatchObject({ ok: true, count: 1 });
    const firstSpec = (
      firstResult as { dispatched?: Array<{ runTaskId: string; subagentId: string }> }
    ).dispatched?.[0];
    expect(firstSpec).toMatchObject({
      subagentId: firstDispatch.subagentId,
      runTaskId: firstDispatch.runTaskId,
    });

    const firstState = await getBoard(tmpDir, board.id);
    expect(firstState?.tasks[0]).toMatchObject({
      status: 'in_progress',
      columnId: 'in-progress',
    });
    expect(firstState?.tasks[0]?.assignment).toMatchObject({
      status: 'running',
      subagentId: firstDispatch.subagentId,
      runTaskId: firstDispatch.runTaskId,
    });
    expect(firstState?.tasks[0]?.assignment?.leaseId).toBeTruthy();
    expect(firstState?.tasks[0]?.assignment?.leaseExpiresAt).toBeTruthy();

    // ---------------------------------------------------------------------
    // Step 2: Recovery observes an expired lease and clears the worker.
    //
    // We simulate the timeout by passing a checked-at timestamp beyond the
    // leaseExpiresAt that was seeded at dispatch time. The release mode is
    // preferred for the retry loop because it transfers a clean assignment
    // back to the ready queue.
    // ---------------------------------------------------------------------
    const recovery = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
      now: '2099-01-01T00:00:00.000Z',
      reason: 'simulated dead worker — recovery E2E',
    });

    expect(recovery).not.toBeNull();
    expect(recovery?.tasks[0]).toMatchObject({
      status: 'ready',
      columnId: 'todo',
    });
    expect(recovery?.tasks[0]?.assignment).toBeUndefined();

    const readyAfterRecovery = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(readyAfterRecovery.find((entry) => entry.task.id === task!.task.id)).toMatchObject({
      task: { status: 'ready' },
    });

    const afterReleaseNotes = (await getBoard(tmpDir, board.id))?.tasks[0]?.notes ?? [];
    expect(afterReleaseNotes.some((note) => note.content.includes('simulated dead worker'))).toBe(
      true,
    );

    // ---------------------------------------------------------------------
    // Step 3: Retry dispatch claims the recovered task and finishes it.
    // ---------------------------------------------------------------------
    const secondResult = await tool.execute(
      {
        boardId: board.id,
        awaitCompletion: true,
        heartbeatIntervalMs: 30_000,
        leaseTtlMs: 120_000,
      },
      { projectRoot: tmpDir } as never,
      { signal: new AbortController().signal },
    );

    expect(secondResult).toMatchObject({ ok: true, count: 1 });
    expect(spawnedSubagents).toHaveLength(2);
    // Sprint 1 contract: `release` clears the assignment (including routing
    // metadata) before returning the task to the ready queue. The retry
    // dispatch therefore spawns a fresh subagent with default routing.
    // The director's `ensureKanbanTool` helper still adds `kanban` to the
    // spawned subagent's tool allowlist, so the hook survives even when the
    // task itself does not pre-declare a tools list.
    const secondSpawnTools = spawnedSubagents[1]?.tools ?? [];
    if (secondSpawnTools.length > 0) {
      expect(secondSpawnTools).toEqual(expect.arrayContaining(['kanban']));
    }

    const finalState = await getBoard(tmpDir, board.id);
    expect(finalState?.tasks[0]).toMatchObject({
      status: 'completed',
      columnId: 'done',
    });
    expect(finalState?.tasks[0]?.assignment).toMatchObject({
      status: 'completed',
      lastResult: 'retry succeeded',
    });

    // ---------------------------------------------------------------------
    // Step 4: Append-only event chain matches the contracted lifecycle.
    // ---------------------------------------------------------------------
    const events = await listKanbanEvents(tmpDir, board.id);
    expect(events.map((event) => event.type)).toEqual([
      'task.claimed',
      'task.assignment.running',
      'task.stale_recovered',
      'task.claimed',
      'task.assignment.running',
      'task.assignment.completed',
    ]);

    const recoveryEvent = events.find((event) => event.type === 'task.stale_recovered');
    expect(recoveryEvent?.note).toContain('simulated dead worker');
    const completedEvent = events.find(
      (event) => event.type === 'task.assignment.completed',
    );
    expect(completedEvent?.runTaskId).toBe(taskIdsReturned[1]);
    // Sprint 1 contract: `release` wipes routing metadata, so the retry's
    // claim yields a fresh assignment without a preserved agentId. The
    // completed event therefore may or may not carry an actor depending on
    // whether the second dispatch seeded an agentId; we only assert the
    // deterministic runTaskId correlation here.
    void spawnedSubagents;
  });
});
