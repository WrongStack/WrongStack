import type { KanbanBoard } from '@wrongstack/kanban';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/kanban', () => ({
  createBoard: vi.fn(async (_root, opts) => ({
    id: 'mock-board-1',
    title: opts.title,
    tasks: [],
    tags: opts.tags ?? [],
  })),
  getBoard: vi.fn(async () => null),
  listBoards: vi.fn(async () => []),
  syncBoardFromTaskGraph: vi.fn(async (_root, boardId) => ({
    board: {
      id: boardId,
      tasks: [
        {
          id: 'k-t1',
          title: 'Task 1',
          status: 'review',
          origin: { taskId: 't1' },
          assignment: { status: 'completed' },
        },
      ],
    },
  })),
  updateTaskAssignment: vi.fn(async (_root, boardId, taskId, assignment) => ({
    id: boardId,
    tasks: [{ id: taskId, assignment }],
  })),
  attachVerificationReport: vi.fn(async (_root, boardId, taskId) => ({
    id: boardId,
    tasks: [{ id: taskId, verificationReport: { verdict: 'passed' } }],
  })),
  buildVerificationReport: vi.fn((opts) => opts),
  reconcileKanbanBoard: vi.fn(async (_root, boardId) => ({
    board: { id: boardId, tasks: [] },
    tasks: [{ id: 'task-reconciled' }],
  })),
  getKanbanQueueHealth: vi.fn(async () => ({
    counts: { running: 0, startable: 1, review: 1, blocked: 0, failed: 0 },
    staleAssignments: { count: 1 },
    dependencyBlocked: { count: 0 },
  })),
  recoverStaleTaskAssignments: vi.fn(async (_root, boardId) => ({
    board: { id: boardId, tasks: [] },
    tasks: [{ id: 'task-recovered' }],
  })),
  kanbanQueueAnomalyCount: vi.fn((health) => health.staleAssignments.count),
  resolveGateEnforcement: vi.fn(() => 'strict'),
  finalizeTaskCompletion: vi.fn(async (_root, boardId, taskId) => ({
    board: { id: boardId, tasks: [{ id: taskId, status: 'completed' }] },
  })),
}));

vi.mock('@wrongstack/core/tasking', () => ({
  deserializeTaskGraph: vi.fn((graph) => graph),
}));

import {
  buildTaskGraphFromGoalPhase,
  buildTaskGraphFromSddSnapshot,
  createKanbanRunMirror,
} from '../src/server/kanban-run-mirror.js';
import { createKanbanSupervisor } from '../src/server/kanban-supervisor.js';

describe('KanbanRunMirror extended coverage', () => {
  it('buildTaskGraphFromSddSnapshot handles tasks with full metadata and dependencies', () => {
    const graph = buildTaskGraphFromSddSnapshot({
      runId: 'sdd-1',
      graphId: 'g-1',
      specId: 'spec-1',
      title: 'SDD Run',
      tasks: [
        {
          id: 't1',
          shortId: 'T1',
          title: 'Task 1',
          description: 'Desc 1',
          type: 'feature',
          priority: 'high',
          status: 'completed',
          agentName: 'Worker-1',
          model: 'gpt-4',
          provider: 'openai',
          fallbackModels: ['gpt-3.5'],
          worktreeBranch: 'feat/t1',
          retries: 1,
          displayStatus: 'completed',
          verificationCommand: 'npm test',
          verificationState: 'passed',
          verificationDetail: 'All tests passed',
          deps: [],
          startedAt: 1000,
          completedAt: 2000,
        },
        {
          id: 't2',
          shortId: 'T2',
          title: 'Task 2',
          type: 'fix',
          priority: 'low',
          status: 'in_progress',
          displayStatus: 'in_progress',
          deps: ['T1'],
        },
      ],
    });

    expect(graph.id).toBe('g-1');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].from).toBe('t1');
    expect(graph.edges[0].to).toBe('t2');
  });

  it('buildTaskGraphFromGoalPhase builds nodes with phase tags', () => {
    const graph = buildTaskGraphFromGoalPhase('goal-1', 'Goal Run', {
      id: 'phase-1',
      name: 'Phase One',
      tasks: [
        {
          id: 'gt1',
          title: 'Goal Task 1',
          status: 'pending',
          priority: 'medium',
          type: 'feature',
          assignee: 'Agent-X',
          startedAt: 100,
          completedAt: 200,
        },
      ],
    });

    expect(graph.id).toBe('goal-1');
    expect(graph.nodes[0].tags).toEqual(['Phase One']);
    expect(graph.nodes[0].assignee).toBe('Agent-X');
  });

  it('projects multi-column SDD runs across wave boards', async () => {
    const broadcast = vi.fn();
    const mirror = createKanbanRunMirror({
      projectRoot: '/tmp/proj',
      broadcast,
    });

    const { getBoard, createBoard } = await import('@wrongstack/kanban');
    vi.mocked(getBoard).mockResolvedValue({
      id: 'mock-board-1',
      title: 'SDD Board',
      columns: [],
      tags: [],
      tasks: [
        {
          id: 'k-t1',
          title: 'Task 1',
          status: 'review',
          columnId: 'col-1',
          origin: { taskId: 't1' },
          assignment: { status: 'running' },
        },
      ],
    });

    mirror.onGoalState('goal-run-1', {
      title: 'Phased Goal',
      phases: [
        {
          id: 'phase-1',
          name: 'First Phase',
          tasks: [
            {
              id: 'gt1',
              title: 'Goal T1',
              status: 'in_progress',
              priority: 'high',
              type: 'feature',
              assignee: 'Worker-A',
            },
          ],
        },
      ],
    });

    await mirror.flush();
    expect(createBoard).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalled();
    mirror.dispose();
  });
});

describe('KanbanSupervisor auditNow and agent execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('audits boards, recovers stale assignments, and sweeps gate parked tasks', async () => {
    const broadcast = vi.fn();
    const log = vi.fn();
    const dispatchTask = vi.fn(async () => 'Agent dispatched');

    const { getBoard, listBoards } = await import('@wrongstack/kanban');
    const board: KanbanBoard = {
      id: 'b1',
      title: 'Supervised Board',
      columns: [],
      tags: [],
      supervisor: {
        enabled: true,
        mode: 'agentic',
        intervalMs: 5000,
      },
      completionGate: { enforcement: 'strict' },
      tasks: [
        {
          id: 't-parked',
          title: 'Parked Task',
          status: 'review',
          columnId: 'col-rev',
          assignment: { status: 'completed' },
        },
      ],
    };
    vi.mocked(getBoard).mockResolvedValue(board);
    vi.mocked(listBoards).mockResolvedValue([{ id: 'b1', title: 'Supervised Board' }]);

    const supervisor = createKanbanSupervisor({
      projectRoot: () => '/tmp/supervised-proj',
      broadcast,
      log,
      dispatchTask,
    });

    const snapshots = await supervisor.auditNow('b1');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].boardId).toBe('b1');
    expect(snapshots[0].status).toBe('running');
    expect(dispatchTask).toHaveBeenCalled();

    // Verify stats
    const stats = supervisor.getStats();
    expect(stats.snapshots).toBeGreaterThanOrEqual(1);
    expect(stats.runningAgents).toBe(1);

    // Call onDone callback passed to dispatchTask
    const dispatchOptions = dispatchTask.mock.calls[0][1];
    expect(dispatchOptions?.onDone).toBeDefined();
    await dispatchOptions?.onDone?.({
      status: 'completed',
      result: 'Anomalies resolved',
    });

    expect(supervisor.getStats().runningAgents).toBe(0);
    supervisor.dispose();
  });

  it('audits disabled boards without running reconciliation or agents', async () => {
    const broadcast = vi.fn();
    const { getBoard } = await import('@wrongstack/kanban');
    const board: KanbanBoard = {
      id: 'b-disabled',
      title: 'Disabled Board',
      columns: [],
      tags: [],
      supervisor: { enabled: false },
      tasks: [],
    };
    vi.mocked(getBoard).mockResolvedValue(board);

    const supervisor = createKanbanSupervisor({
      projectRoot: '/tmp/test',
      broadcast,
    });

    const snapshots = await supervisor.auditNow('b-disabled');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].status).toBe('disabled');
    supervisor.dispose();
  });
});
