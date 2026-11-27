import type { KanbanBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKanbanSupervisor,
  type KanbanSupervisorDispatchOptions,
} from '../src/server/kanban-supervisor.js';

/**
 * The project-wide Kanban companion switch gates the supervisor's agentic
 * manager on top of the per-board supervisor config: a pass reads the live
 * workspace flag before scheduling, a disable skips new dispatches and stops
 * in-flight runs, and a failed flag read keeps the pre-flag behavior (fail
 * open) rather than silently disabling supervision. Deterministic reconcile /
 * recovery sweeps are untouched by the switch.
 */
const state = vi.hoisted(() => ({
  board: null as KanbanBoard | null,
  companionEnabled: true,
}));

vi.mock('@wrongstack/kanban', () => ({
  getBoard: vi.fn(async () => state.board),
  listBoards: vi.fn(async () => (state.board ? [state.board] : [])),
  reconcileKanbanBoard: vi.fn(async () => ({ board: state.board, tasks: [] })),
  resolveGateEnforcement: () => 'off',
  getKanbanQueueHealth: vi.fn(async () => ({
    counts: { running: 0, startable: 1, review: 0, blocked: 0, failed: 0 },
    staleAssignments: { count: 0 },
    dependencyBlocked: { count: 0 },
  })),
  kanbanQueueAnomalyCount: () => 0,
  recoverStaleTaskAssignments: vi.fn(),
  finalizeTaskCompletion: vi.fn(),
  claimBoardManagement: vi.fn(async () => true),
  renewBoardManagement: vi.fn(async () => true),
  finishBoardManagement: vi.fn(async () => true),
  getKanbanCompanionEnabled: vi.fn(async () => state.companionEnabled),
}));
vi.mock('../src/server/kanban-broadcast.js', () => ({ publishKanbanBoard: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  state.companionEnabled = true;
  state.board = {
    id: 'b',
    title: 'Leader work',
    version: 1,
    createdAt: '',
    updatedAt: '',
    columns: [],
    tasks: [
      {
        id: 't',
        title: 'Implement search',
        status: 'pending',
        columnId: 'todo',
        order: 0,
        priority: 'medium',
        createdAt: '',
        updatedAt: '',
      },
    ],
  };
});
afterEach(() => vi.useRealTimers());

function setup() {
  const dispatch = vi.fn(
    async (_prompt: string, _opts?: KanbanSupervisorDispatchOptions) => 'spawned',
  );
  const log = vi.fn();
  const supervisor = createKanbanSupervisor({
    projectRoot: '/project',
    broadcast: vi.fn(),
    dispatchTask: dispatch,
    log,
  });
  return { dispatch, log, supervisor };
}

describe('companion switch gating of the management scheduler', () => {
  it('reads the live flag before scheduling and dispatches when it is on', async () => {
    const { getKanbanCompanionEnabled } = await import('@wrongstack/kanban');
    const { dispatch, supervisor } = setup();
    try {
      await supervisor.auditNow('b');
      expect(vi.mocked(getKanbanCompanionEnabled)).toHaveBeenCalledWith('/project');
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      supervisor.dispose();
    }
  });

  it('a disabled companion schedules no manager and advertises no pending management', async () => {
    state.companionEnabled = false;
    const { dispatch, supervisor } = setup();
    try {
      await supervisor.auditNow('b');
      expect(dispatch).not.toHaveBeenCalled();
      const snapshot = supervisor.getSnapshot('b');
      expect(snapshot?.status).toBe('healthy');
      expect(snapshot?.summary ?? '').not.toContain('task management pending');
    } finally {
      supervisor.dispose();
    }
  });

  it('a disable on a later pass aborts an in-flight management run', async () => {
    const dispatch = vi.fn(
      (_prompt: string, opts?: KanbanSupervisorDispatchOptions) =>
        new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('companion disabled')), {
            once: true,
          });
        }),
    );
    const supervisor = createKanbanSupervisor({
      projectRoot: '/project',
      broadcast: vi.fn(),
      dispatchTask: dispatch,
      log: vi.fn(),
    });
    try {
      // The dispatch hangs, so the first pass never resolves until the run is
      // stopped; drive it with bounded async timer flushes.
      const firstPass = supervisor.auditNow('b');
      for (let i = 0; i < 50 && dispatch.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(dispatch).toHaveBeenCalledTimes(1);
      const signal = dispatch.mock.calls[0]![1]!.signal!;
      expect(signal.aborted).toBe(false);

      state.companionEnabled = false;
      await supervisor.auditNow('b');
      expect(signal.aborted).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      await firstPass;
      expect(supervisor.getStats().runningAgents).toBe(0);
    } finally {
      supervisor.dispose();
    }
  });

  it('cancelManagement() stops an in-flight run without waiting for a pass', async () => {
    const dispatch = vi.fn(
      (_prompt: string, opts?: KanbanSupervisorDispatchOptions) =>
        new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        }),
    );
    const supervisor = createKanbanSupervisor({
      projectRoot: '/project',
      broadcast: vi.fn(),
      dispatchTask: dispatch,
      log: vi.fn(),
    });
    try {
      const firstPass = supervisor.auditNow('b');
      for (let i = 0; i < 50 && dispatch.mock.calls.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      const signal = dispatch.mock.calls[0]![1]!.signal!;
      supervisor.cancelManagement();
      supervisor.cancelManagement(); // idempotent
      expect(signal.aborted).toBe(true);
      await firstPass;
      expect(supervisor.getStats().runningAgents).toBe(0);
    } finally {
      supervisor.dispose();
    }
  });

  it('a failed flag read keeps management enabled (fail open) and logs why', async () => {
    const { getKanbanCompanionEnabled } = await import('@wrongstack/kanban');
    vi.mocked(getKanbanCompanionEnabled).mockRejectedValueOnce(new Error('flag io'));
    const { dispatch, log, supervisor } = setup();
    try {
      await supervisor.auditNow('b');
      expect(dispatch).toHaveBeenCalledTimes(1);
      const logged = log.mock.calls.map((call) => String(call[0]));
      expect(logged.some((line) => line.includes('companion flag read failed'))).toBe(true);
    } finally {
      supervisor.dispose();
    }
  });
});
