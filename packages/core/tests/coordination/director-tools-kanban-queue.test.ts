import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Director } from '../../src/coordination/director.js';
import { makeKanbanQueueTool } from '../../src/coordination/director-tools.js';

// ---------------------------------------------------------------------------
// Tests for the kanban_queue dispatch service migration.
//
// The Director now calls reserveKanbanDispatch + startKanbanDispatch +
// completeKanbanDispatch/failKanbanDispatch instead of manually composing
// claimReadyTask + updateTaskAssignment + transitionTask + finalizeTaskCompletion.
//
// These tests verify:
//  1. Reassignment during spawn: startKanbanDispatch returns null → orphan
//     terminated, conflict reported.
//  2. Short-lease clamping: effective TTL ≥ 2× heartbeat interval.
//  3. Dispatch-time lease stamping happens inside startKanbanDispatch.
//  4. Supervisor heartbeat renews with expectedLeaseId fence.
//  5. Heartbeat batches never overlap.
//  6. Worker prompt advertises the lease token from reserveKanbanDispatch.
//  7. Fire-and-forget renewal supervisor.
//  8-9. Lease revocation detection and stale-subagent termination.
// ---------------------------------------------------------------------------

const claimReadyTaskMock = vi.fn();
const updateTaskAssignmentMock = vi.fn();
const heartbeatTaskAssignmentMock = vi.fn();
const listReadyTasksMock = vi.fn();
const getBoardMock = vi.fn();
const finalizeTaskCompletionMock = vi.fn();
const transitionTaskMock = vi.fn();

// Generate a stable UUID for the mock lease so prompt assertions can match it.
const MOCK_LEASE_ID = 'aaaa1111-bbbb-cccc-dddd-eeeeffff0000';
const MOCK_LEASE_EXPIRES = '2026-01-01T00:10:00.000Z';

vi.mock('@wrongstack/kanban', () => ({
  claimReadyTask: (...a: unknown[]) => claimReadyTaskMock(...a),
  updateTaskAssignment: (...a: unknown[]) => updateTaskAssignmentMock(...a),
  heartbeatTaskAssignment: (...a: unknown[]) => heartbeatTaskAssignmentMock(...a),
  listReadyTasks: (...a: unknown[]) => listReadyTasksMock(...a),
  getBoard: (...a: unknown[]) => getBoardMock(...a),
  describeKanbanBoundary: () => 'unrestricted',
  // Dispatch service: compose the mocked primitives.
  reserveKanbanDispatch: async (_projectRoot: string, input: Record<string, unknown>) => {
    const routing = (input.routing ?? {}) as Record<string, unknown>;
    const claim = await claimReadyTaskMock(_projectRoot, {
      ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...routing,
      leaseId: MOCK_LEASE_ID,
      claimedAt: '2026-01-01T00:00:00.000Z',
      heartbeatAt: '2026-01-01T00:00:00.000Z',
      leaseExpiresAt: MOCK_LEASE_EXPIRES,
      status: 'queued',
    });
    if (!claim) return null;
    return {
      board: claim.board,
      task: claim.task,
      lease: {
        leaseId: MOCK_LEASE_ID,
        claimedAt: '2026-01-01T00:00:00.000Z',
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        leaseExpiresAt: MOCK_LEASE_EXPIRES,
      },
    };
  },
  startKanbanDispatch: async (_projectRoot: string, input: Record<string, unknown>) => {
    const board = await updateTaskAssignmentMock(
      _projectRoot,
      input.boardId,
      input.taskId,
      {
        status: 'running',
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 300000).toISOString(),
        ...(input.subagentId !== undefined ? { subagentId: input.subagentId } : {}),
        ...(input.runTaskId !== undefined ? { runTaskId: input.runTaskId } : {}),
      },
      { expectedLeaseId: input.leaseId },
    );
    if (!board) return null;
    if (board.lifecycle?.mode === 'managed') {
      await transitionTaskMock(_projectRoot, input.boardId, input.taskId, {
        to: 'running',
        actor: input.actor,
        comment: 'Dispatch started.',
      });
    }
    const task = board.tasks?.find((t: { id: string }) => t.id === input.taskId);
    return task ? { board, task } : { board, task: { id: input.taskId } };
  },
  completeKanbanDispatch: async (_projectRoot: string, input: Record<string, unknown>) => {
    const board = await updateTaskAssignmentMock(
      _projectRoot,
      input.boardId,
      input.taskId,
      { status: 'completed', ...(input.result !== undefined ? { lastResult: input.result } : {}) },
      { expectedLeaseId: input.leaseId },
    );
    if (!board) return null;
    if (board.lifecycle?.mode !== 'managed') {
      await finalizeTaskCompletionMock(_projectRoot, input.boardId, input.taskId, {});
    }
    const task = board.tasks?.find((t: { id: string }) => t.id === input.taskId);
    return task ? { board, task } : { board, task: { id: input.taskId } };
  },
  failKanbanDispatch: async (_projectRoot: string, input: Record<string, unknown>) => {
    return updateTaskAssignmentMock(
      _projectRoot,
      input.boardId,
      input.taskId,
      { status: 'failed', error: input.error },
      { expectedLeaseId: input.leaseId },
    );
  },
  finalizeTaskCompletion: (...a: unknown[]) => finalizeTaskCompletionMock(...a),
  transitionTask: (...a: unknown[]) => transitionTaskMock(...a),
}));

// Roadmap #11: director-tools resolves kanban dispatch through the port;
// wire it to this suite's mocked @wrongstack/kanban surface. The factory
// functions above compose the primitive mocks, so wiring them preserves
// every assertion in this suite verbatim.
import {
  completeKanbanDispatch,
  failKanbanDispatch,
  getBoard,
  heartbeatTaskAssignment,
  listReadyTasks,
  reserveKanbanDispatch,
  startKanbanDispatch,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import { setKanbanDispatch } from '../../src/coordination/kanban-dispatch-port.js';

setKanbanDispatch({
  getBoard,
  listReadyTasks,
  reserveKanbanDispatch,
  startKanbanDispatch,
  completeKanbanDispatch,
  failKanbanDispatch,
  updateTaskAssignment,
  heartbeatTaskAssignment,
});

vi.mock('../../src/coordination/dispatcher.js', () => ({
  dispatchAgent: vi.fn(),
}));

interface MutableAssignment {
  status: string;
  leaseId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
}

function makeClaim(taskId = 'task-1', assignment?: MutableAssignment) {
  return {
    board: { id: 'board-1', title: 'Board', tasks: [], columns: [] },
    task: {
      id: taskId,
      title: 'Do the thing',
      status: 'in_progress',
      priority: 'high',
      columnId: 'running',
      ...(assignment ? { assignment } : {}),
    },
  };
}

type MockDirector = {
  spawn: ReturnType<typeof vi.fn>;
  assign: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  awaitTasks: ReturnType<typeof vi.fn>;
  fleet?: { subscribe: ReturnType<typeof vi.fn> };
};
let director: MockDirector;
let fleetHandlers: Map<string, Set<(event: unknown) => void>>;
const emitFleet = (subagentId: string, event: Record<string, unknown>): void => {
  for (const handler of fleetHandlers.get(subagentId) ?? []) handler(event);
};
const asDir = () => director as never as Director;
const ctx = { projectRoot: 'D:/tmp/proj' } as never;

beforeEach(() => {
  vi.useRealTimers();
  claimReadyTaskMock.mockReset();
  updateTaskAssignmentMock.mockReset();
  heartbeatTaskAssignmentMock.mockReset();
  listReadyTasksMock.mockReset();
  getBoardMock.mockReset();
  finalizeTaskCompletionMock.mockReset();
  transitionTaskMock.mockReset();
  // Default: empty board for the revocation guard.
  getBoardMock.mockResolvedValue({ id: 'board-1', tasks: [] });
  finalizeTaskCompletionMock.mockResolvedValue(null);
  fleetHandlers = new Map();
  director = {
    spawn: vi.fn(async () => 'sub-1'),
    assign: vi.fn(async (task: { id: string }) => task.id),
    terminate: vi.fn(async () => {}),
    awaitTasks: vi.fn(async () => []),
    fleet: {
      subscribe: vi.fn((subagentId: string, handler: (event: unknown) => void) => {
        const set = fleetHandlers.get(subagentId) ?? new Set();
        set.add(handler);
        fleetHandlers.set(subagentId, set);
        return () => {
          set.delete(handler);
        };
      }),
    } as never,
  };
});
afterEach(() => {
  for (const [subagentId, handlers] of fleetHandlers) {
    for (const handler of [...handlers]) {
      handler({ type: 'subagent.stopped', subagentId });
    }
  }
  fleetHandlers.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('kanban_queue dispatch service', () => {
  it('reassignment during queueing: startKanbanDispatch returns null → orphan terminated, conflict reported', async () => {
    // The reserve succeeds (claim is made), but startKanbanDispatch returns
    // null because the lease was lost during spawn (updateTaskAssignment
    // returns null for a stale lease).
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue(null);

    const tool = makeKanbanQueueTool(asDir());
    const res = (await tool.execute({ taskId: 'task-1' }, ctx, {} as never)) as {
      dispatched?: unknown[];
      errors?: Array<{ taskId?: string; error: string }>;
    };

    // Director.assign() must not be called — orphan is terminated before hand-off.
    expect(director.assign).not.toHaveBeenCalled();
    expect(director.terminate).toHaveBeenCalledWith('sub-1');
    expect(res.dispatched ?? []).toHaveLength(0);
    const err = (res.errors ?? []).find((entry) => entry.taskId === 'task-1');
    expect(err).toBeDefined();
    expect(err?.error ?? '').toMatch(/lease/i);

    // The startKanbanDispatch call (via updateTaskAssignmentMock) was fenced
    // with the lease ID from reserveKanbanDispatch.
    const startWrite = updateTaskAssignmentMock.mock.calls.find(
      (call) => (call[3] as { status?: string })?.status === 'running',
    );
    expect(startWrite).toBeDefined();
    expect((startWrite?.[4] as { expectedLeaseId?: string })?.expectedLeaseId).toBe(MOCK_LEASE_ID);
  });

  it('short lease: effectiveLeaseTtlMs is clamped to 2x heartbeat interval and the prompt receives computed values', async () => {
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });

    const tool = makeKanbanQueueTool(asDir());
    // Schema-minimum lease (1s) with no explicit heartbeat interval.
    await tool.execute({ taskId: 'task-1', leaseTtlMs: 1000 }, ctx, {} as never);

    expect(director.assign).toHaveBeenCalledTimes(1);
    const spec = director.assign.mock.calls[0]?.[0] as { description: string };
    expect(spec.description).toContain('expected heartbeatIntervalMs: 5000');
    expect(spec.description).toContain('expected leaseTtlMs: 10000');
    expect(spec.description).not.toContain('expected leaseTtlMs: 1000\n');
  });

  it('queue delay: startKanbanDispatch stamps heartbeatAt and leaseExpiresAt from the dispatch moment', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-07-18T12:00:00.000Z');
    vi.setSystemTime(t0);
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });
    // Simulate a slow coordinator queue: spawn stalls for 2 minutes.
    const queueDelayMs = 2 * 60 * 1000;
    director.spawn = vi.fn(async () => {
      vi.setSystemTime(new Date(t0.getTime() + queueDelayMs));
      return 'sub-1';
    });

    const tool = makeKanbanQueueTool(asDir());
    await tool.execute({ taskId: 'task-1', leaseTtlMs: 5 * 60 * 1000 }, ctx, {} as never);

    // The startKanbanDispatch mock stamps heartbeatAt/leaseExpiresAt from
    // new Date() (the dispatch moment). Verify those values are set.
    const startWrite = updateTaskAssignmentMock.mock.calls.find(
      (call) => (call[3] as { status?: string })?.status === 'running',
    );
    expect(startWrite).toBeDefined();
    const patch = startWrite?.[3] as { heartbeatAt: string; leaseExpiresAt: string };
    const dispatchedAtMs = t0.getTime() + queueDelayMs;
    expect(Date.parse(patch.heartbeatAt)).toBe(dispatchedAtMs);
    expect(Date.parse(patch.leaseExpiresAt)).toBe(dispatchedAtMs + 300000);
    // Fenced with the lease from reserveKanbanDispatch.
    expect((startWrite?.[4] as { expectedLeaseId?: string })?.expectedLeaseId).toBe(MOCK_LEASE_ID);
  });

  it('awaitCompletion: supervisor heartbeat renews the lease with the expectedLeaseId fence while workers run', async () => {
    vi.useFakeTimers();
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });
    heartbeatTaskAssignmentMock.mockResolvedValue({ id: 'board-1' });
    let settleAwait: (value: unknown[]) => void = () => {};
    director.awaitTasks = vi.fn(() => new Promise<unknown[]>((resolve) => (settleAwait = resolve)));

    const tool = makeKanbanQueueTool(asDir());
    const heartbeatIntervalMs = 10_000;
    const execPromise = tool.execute(
      { taskId: 'task-1', awaitCompletion: true, leaseTtlMs: 60_000, heartbeatIntervalMs },
      ctx,
      {} as never,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 2 + 50);

    expect(heartbeatTaskAssignmentMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of heartbeatTaskAssignmentMock.mock.calls) {
      const patch = call[3] as { expectedLeaseId?: string; leaseExpiresAt?: string };
      expect(patch.expectedLeaseId).toEqual(expect.any(String));
      expect(patch.leaseExpiresAt).toEqual(expect.any(String));
    }

    // Settle: heartbeats stop, terminal write is fenced.
    const assignedTaskId = (director.assign.mock.calls[0]?.[0] as { id: string })?.id ?? '';
    settleAwait([
      { taskId: assignedTaskId, subagentId: 'sub-1', status: 'success', result: 'done' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await execPromise;
    const heartbeatsAtSettle = heartbeatTaskAssignmentMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3);
    expect(heartbeatTaskAssignmentMock.mock.calls.length).toBe(heartbeatsAtSettle);
    // The terminal write (completed) must be fenced.
    const terminalWrite = updateTaskAssignmentMock.mock.calls.find(
      (call) => (call[3] as { status?: string })?.status === 'completed',
    );
    expect(terminalWrite).toBeDefined();
    expect((terminalWrite?.[4] as { expectedLeaseId?: string })?.expectedLeaseId).toEqual(
      expect.any(String),
    );
  });

  it('awaitCompletion: never overlaps slow heartbeat batches', async () => {
    vi.useFakeTimers();
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });
    const heartbeatResolvers: Array<() => void> = [];
    heartbeatTaskAssignmentMock.mockImplementation(
      () => new Promise((resolve) => heartbeatResolvers.push(() => resolve({ id: 'board-1' }))),
    );
    let settleAwait: (value: unknown[]) => void = () => {};
    director.awaitTasks = vi.fn(() => new Promise<unknown[]>((resolve) => (settleAwait = resolve)));

    const heartbeatIntervalMs = 10_000;
    const tool = makeKanbanQueueTool(asDir());
    const execPromise = tool.execute(
      { taskId: 'task-1', awaitCompletion: true, leaseTtlMs: 60_000, heartbeatIntervalMs },
      ctx,
      {} as never,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3 + 50);
    expect(heartbeatTaskAssignmentMock).toHaveBeenCalledTimes(1);

    heartbeatResolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs + 50);
    expect(heartbeatTaskAssignmentMock).toHaveBeenCalledTimes(2);

    const assignedTaskId = (director.assign.mock.calls[0]?.[0] as { id?: string })?.id ?? '';
    settleAwait([
      { taskId: assignedTaskId, subagentId: 'sub-1', status: 'success', result: 'done' },
    ]);
    heartbeatResolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    await execPromise;
  });

  it('worker prompt advertises the lease token from reserveKanbanDispatch', async () => {
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });

    const tool = makeKanbanQueueTool(asDir());
    await tool.execute({ taskId: 'task-1' }, ctx, {} as never);

    const spec = director.assign.mock.calls[0]?.[0] as { description: string };
    const prompt = spec.description;
    // The concrete lease id from reserveKanbanDispatch appears in the prompt.
    const leaseIdMatch = prompt.match(/leaseId: ([0-9a-f-]{36})/);
    expect(leaseIdMatch).not.toBeNull();
    const leaseId = leaseIdMatch?.[1] ?? '';
    expect(leaseId).toBe(MOCK_LEASE_ID);
    // Same id is instructed as expectedLeaseId on lifecycle calls.
    const fenceMentions = prompt.match(new RegExp(`expectedLeaseId "${leaseId}"`, 'g'));
    expect(fenceMentions?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(prompt).toContain('heartbeat_assignment');
    expect(prompt).toMatch(/mark_assignment[\s\S]*?"running"[\s\S]*?expectedLeaseId/);
    expect(prompt).toMatch(/"completed" or "failed"[\s\S]*?expectedLeaseId/);
  });

  it('fire-and-forget dispatch: host-side renewal keeps the lease alive until the terminal fleet event', async () => {
    vi.useFakeTimers();
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });
    heartbeatTaskAssignmentMock.mockResolvedValue({ id: 'board-1' });

    const tool = makeKanbanQueueTool(asDir());
    const heartbeatIntervalMs = 10_000;
    const res = (await tool.execute(
      { taskId: 'task-1', leaseTtlMs: 60_000, heartbeatIntervalMs },
      ctx,
      {} as never,
    )) as { dispatched: Array<{ subagentId: string; runTaskId: string }> };
    expect(res.dispatched).toHaveLength(1);
    expect(director.fleet?.subscribe).toHaveBeenCalledWith('sub-1', expect.any(Function));

    // While the worker runs, the lease is renewed on every interval, fenced
    // with the lease id from reserveKanbanDispatch (stored in dispatches[].leaseId).
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3 + 50);
    expect(heartbeatTaskAssignmentMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of heartbeatTaskAssignmentMock.mock.calls) {
      const patch = call[3] as { expectedLeaseId?: string; leaseExpiresAt?: string };
      expect(patch.expectedLeaseId).toBe(MOCK_LEASE_ID);
      expect(patch.leaseExpiresAt).toEqual(expect.any(String));
    }

    // Terminal fleet event stops the renewal.
    const runTaskId = res.dispatched[0]?.runTaskId ?? '';
    emitFleet('sub-1', { type: 'subagent.completed', taskId: runTaskId, subagentId: 'sub-1' });
    const heartbeatsAtTerminal = heartbeatTaskAssignmentMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3);
    expect(heartbeatTaskAssignmentMock.mock.calls.length).toBe(heartbeatsAtTerminal);
  });

  it('fire-and-forget: detects lease revocation and terminates stale subagent', async () => {
    vi.useFakeTimers();
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });
    heartbeatTaskAssignmentMock.mockResolvedValue({ id: 'board-1' });
    // recover_stale reclaimed the task with a different leaseId.
    const newLeaseId = '00000000-0000-4000-8000-000000000999';
    getBoardMock.mockResolvedValue({
      id: 'board-1',
      tasks: [{ id: 'task-1', assignment: { leaseId: newLeaseId } }],
    });

    const tool = makeKanbanQueueTool(asDir());
    const heartbeatIntervalMs = 10_000;
    const res = (await tool.execute(
      { taskId: 'task-1', leaseTtlMs: 60_000, heartbeatIntervalMs },
      ctx,
      {} as never,
    )) as { dispatched: Array<{ subagentId: string }> };
    expect(res.dispatched).toHaveLength(1);

    // First heartbeat tick: the watchdog detects the lease mismatch and
    // terminates the stale subagent. No heartbeat was sent.
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs + 50);
    expect(director.terminate).toHaveBeenCalledWith('sub-1');
    expect(heartbeatTaskAssignmentMock).not.toHaveBeenCalled();

    // No further heartbeats after revocation.
    const heartbeatsAfterRevoke = heartbeatTaskAssignmentMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3);
    expect(heartbeatTaskAssignmentMock.mock.calls.length).toBe(heartbeatsAfterRevoke);
  });

  it('awaitCompletion: detects lease revocation and terminates stale subagent mid-flight', async () => {
    vi.useFakeTimers();
    claimReadyTaskMock.mockResolvedValueOnce(makeClaim());
    updateTaskAssignmentMock.mockResolvedValue({ id: 'board-1', tasks: [{ id: 'task-1' }] });
    heartbeatTaskAssignmentMock.mockResolvedValue({ id: 'board-1' });
    const newLeaseId = '00000000-0000-4000-8000-000000000999';
    getBoardMock.mockResolvedValue({
      id: 'board-1',
      tasks: [{ id: 'task-1', assignment: { leaseId: newLeaseId } }],
    });

    let settleAwait: (value: unknown[]) => void = () => {};
    director.awaitTasks = vi.fn(() => new Promise<unknown[]>((resolve) => (settleAwait = resolve)));

    const heartbeatIntervalMs = 10_000;
    const tool = makeKanbanQueueTool(asDir());
    const execPromise = tool.execute(
      { taskId: 'task-1', awaitCompletion: true, leaseTtlMs: 60_000, heartbeatIntervalMs },
      ctx,
      {} as never,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Heartbeat detects lease revocation and terminates the stale subagent.
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs + 50);
    expect(director.terminate).toHaveBeenCalledWith('sub-1');

    // No further heartbeats after revocation.
    const heartbeatsAfterRevoke = heartbeatTaskAssignmentMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs * 3);
    expect(heartbeatTaskAssignmentMock.mock.calls.length).toBe(heartbeatsAfterRevoke);

    // Settle: the stopped result lands. The terminal write is fenced.
    const assignedTaskId = (director.assign.mock.calls[0]?.[0] as { id?: string })?.id ?? '';
    settleAwait([
      { taskId: assignedTaskId, subagentId: 'sub-1', status: 'stopped', error: 'terminated' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const result = (await execPromise) as {
      results?: Array<{ taskId: string; status: string }>;
      resultFailures?: Array<{ taskId: string; error: string }>;
    };

    // The failKanbanDispatch call (via updateTaskAssignmentMock) is fenced.
    const terminalWrite = updateTaskAssignmentMock.mock.calls.find(
      (call) => (call[3] as { status?: string })?.status === 'failed',
    );
    expect(terminalWrite).toBeDefined();
    expect((terminalWrite?.[4] as { expectedLeaseId?: string })?.expectedLeaseId).toEqual(
      expect.any(String),
    );
    expect(result.resultFailures ?? []).toHaveLength(1);
  });
});
