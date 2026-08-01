import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskGraph, TaskNode } from '../src/types/task-graph.js';
import type { PhaseGraph } from '../src/types/phase-graph.js';
import {
  addColumn,
  addGoalMetricToTask,
  addTask,
  assignTask,
  createBoard,
  createBoardFromTaskGraph,
  createBoardsFromPhaseGraph,
  duplicateBoard,
  exportBoardToTaskGraph,
  getBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  getBoardWithLivePresence,
  listKanbanEvents,
  listReadyTasks,
  listTaskActivity,
  mergeTasks,
  recoverStaleTaskAssignments,
  recordTaskActivity,
  removeColumn,
  removeTask,
  searchKanban,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  touchKanbanPresence,
  transferTaskToBoard,
  transitionTask,
  updateBoard,
  updateColumn,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
} from '../src/manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-async-'));
});

async function makeBoard(lifecycle?: Parameters<typeof createBoard>[1]['lifecycle']) {
  return createBoard(tmpDir, {
    title: 'Async Board',
    ...(lifecycle ? { lifecycle } : {}),
  });
}

function managedLifecycle() {
  return {
    mode: 'managed' as const,
    columns: {
      backlog: 'backlog',
      todo: 'todo',
      running: 'in-progress',
      review: 'review',
      done: 'done',
    },
  };
}

function managedCardDetails(description: string) {
  return {
    description,
    dueDate: '2026-08-01',
    assignee: 'kanban-agent',
    labels: ['managed'],
    childTaskIds: ['seed-child'],
    successCriteria: [
      { id: 'criteria-1', description: 'Acceptance criteria exists', type: 'manual' as const, status: 'pending' as const },
    ],
  };
}

function graph(overrides: Partial<TaskGraph> = {}): TaskGraph {
  const now = Date.now();
  return {
    id: 'graph-1',
    specId: 'spec-1',
    title: 'Test Graph',
    nodes: new Map<string, TaskNode>([
      [
        'n1',
        {
          id: 'n1',
          title: 'Node one',
          description: 'desc',
          type: 'feature',
          priority: 'high',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
      ],
    ]),
    edges: [],
    rootNodes: ['n1'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── task-graph-bridge ────────────────────────────────────────────────

describe('createBoardFromTaskGraph', () => {
  it('imports a graph with parent/child relationships and preserves them', async () => {
    const now = Date.now();
    const g: TaskGraph = {
      id: 'g-parent',
      specId: 'sp',
      title: 'Parent Graph',
      nodes: new Map([
        ['p', { id: 'p', title: 'Parent', description: '', type: 'feature', priority: 'medium', status: 'pending', parentId: undefined, children: ['c'], createdAt: now, updatedAt: now }],
        ['c', { id: 'c', title: 'Child', description: '', type: 'feature', priority: 'medium', status: 'pending', parentId: 'p', children: [], createdAt: now, updatedAt: now }],
      ]),
      edges: [{ id: 'e1', from: 'p', to: 'c', type: 'blocks' }],
      rootNodes: ['p'],
      createdAt: now,
      updatedAt: now,
    };
    const { board, taskIdMap } = await createBoardFromTaskGraph(tmpDir, g, { sourceSystem: 'goal', phaseId: 'phase-1' });
    expect(board.tasks).toHaveLength(2);
    const parent = board.tasks.find((t) => t.origin?.taskId === 'p')!;
    const child = board.tasks.find((t) => t.origin?.taskId === 'c')!;
    expect(parent.childTaskIds).toContain(child.id);
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.origin?.phaseId).toBe('phase-1');
    // taskIdMap maps source node ids to created task ids
    expect(taskIdMap.get('p')).toBe(parent.id);
    expect(taskIdMap.get('c')).toBe(child.id);
  });

  it('applies custom title/tags/generatedBy/description options', async () => {
    const { board } = await createBoardFromTaskGraph(tmpDir, graph(), {
      title: 'Custom',
      description: 'My desc',
      tags: ['t1'],
      generatedBy: 'me',
      sourceSystem: 'src',
    });
    expect(board.title).toBe('Custom');
    expect(board.description).toBe('My desc');
    expect(board.tags).toContain('t1');
    expect(board.generatedBy).toBe('me');
  });
});

describe('syncBoardFromTaskGraph', () => {
  it('creates, updates, and archives tasks to match the graph', async () => {
    // Seed a board with one task imported from a graph
    const g1 = graph();
    const { board } = await createBoardFromTaskGraph(tmpDir, g1);
    const boardId = board.id;

    // Sync again with an updated graph: node updated + a new node + missing node archived
    const now = Date.now();
    const updatedNode = { ...g1.nodes.get('n1')!, title: 'Renamed', updatedAt: now };
    const g2: TaskGraph = {
      ...g1,
      nodes: new Map([
        ['n1', updatedNode],
        ['n2', { id: 'n2', title: 'New node', description: '', type: 'feature', priority: 'low', status: 'in_progress', createdAt: now, updatedAt: now }],
      ]),
      rootNodes: ['n1', 'n2'],
    };
    const result = await syncBoardFromTaskGraph(tmpDir, boardId, g2, { sourceSystem: 'task-graph' });
    expect(result).not.toBeNull();
    expect(result!.createdTaskIds).toHaveLength(1);
    expect(result!.updatedTaskIds).toHaveLength(1);
    const stored = await getBoard(tmpDir, boardId);
    expect(stored!.tasks.find((t) => t.title === 'Renamed')).toBeDefined();
    expect(stored!.tasks.find((t) => t.title === 'New node')).toBeDefined();
  });

  it('archives tasks missing from the graph when archiveMissingTasks is on', async () => {
    const g1 = graph({
      nodes: new Map([
        ['n1', { ...graph().nodes.get('n1')! }],
        ['n2', { id: 'n2', title: 'To archive', description: '', type: 'feature', priority: 'low', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() }],
      ]),
      rootNodes: ['n1', 'n2'],
    });
    const { board } = await createBoardFromTaskGraph(tmpDir, g1);
    // Sync with only n1; n2 should be archived
    const result = await syncBoardFromTaskGraph(tmpDir, board.id, graph(), { archiveMissingTasks: true });
    expect(result!.archivedTaskIds).toHaveLength(1);
    const stored = await getBoard(tmpDir, board.id);
    const archived = stored!.tasks.find((t) => t.origin?.taskId === 'n2');
    expect(archived?.status).toBe('archived');
    expect(archived?.assignment).toBeUndefined();
  });

  it('refuses to sync a managed board', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle() });
    await expect(syncBoardFromTaskGraph(tmpDir, b.id, graph())).rejects.toThrow('managed Kanban Agent board');
  });

  it('returns null for an unknown board', async () => {
    expect(await syncBoardFromTaskGraph(tmpDir, 'nope', graph())).toBeNull();
  });
});

describe('exportBoardToTaskGraph', () => {
  it('exports rootNodes and edges from a real board', async () => {
    const b = await makeBoard();
    const a = await addTask(tmpDir, b.id, { title: 'A' });
    const c = await addTask(tmpDir, b.id, { title: 'C' });
    await updateTask(tmpDir, b.id, c!.task.id, { dependsOn: [a!.task.id] });
    const result = await exportBoardToTaskGraph(tmpDir, b.id);
    expect(result).not.toBeNull();
    expect(result!.graph.nodes.size).toBe(2);
    expect(result!.graph.edges.some((e) => e.type === 'depends_on')).toBe(true);
    expect(result!.graph.rootNodes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('createBoardsFromPhaseGraph', () => {
  it('creates one board per phase, tagged as goal', async () => {
    const tg = graph();
    const pg: PhaseGraph = {
      id: 'goal-1',
      title: 'My Goal',
      description: 'desc',
      phases: new Map([
        ['ph1', { id: 'ph1', name: 'Phase One', description: '', status: 'pending', taskGraph: tg, dependsOn: [], nextPhases: [], parallelizable: false, priority: 'high', estimateHours: 1, assignedAgents: [], createdAt: Date.now(), updatedAt: Date.now() }],
        ['ph2', { id: 'ph2', name: 'Phase Two', description: '', status: 'pending', taskGraph: tg, dependsOn: ['ph1'], nextPhases: [], parallelizable: false, priority: 'medium', estimateHours: 1, assignedAgents: [], createdAt: Date.now() + 1, updatedAt: Date.now() + 1 }],
      ]),
      rootPhaseIds: ['ph1'],
      activePhaseIds: [],
      completedPhaseIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const boards = await createBoardsFromPhaseGraph(tmpDir, pg);
    expect(boards).toHaveLength(2);
    expect(boards[0]!.phase.id).toBe('ph1');
    expect(boards[0]!.board.tags).toContain('goal');
    expect(boards[0]!.board.title).toBe('My Goal: Phase One');
  });
});

// ── boards.ts edges ──────────────────────────────────────────────────

describe('updateBoard edges', () => {
  it('clears completedAt with null and updates supervisor/lifecycle', async () => {
    const b = await makeBoard();
    await updateBoard(tmpDir, b.id, { completedAt: '2026-07-17T00:00:00Z', supervisor: { enabled: true, mode: 'deterministic' } });
    const stored = await getBoard(tmpDir, b.id);
    expect(stored?.completedAt).toBe('2026-07-17T00:00:00Z');
    expect(stored?.supervisor?.mode).toBe('deterministic');
    // Clear supervisor + completedAt via null
    const cleared = await updateBoard(tmpDir, b.id, { completedAt: null, supervisor: null });
    expect(cleared?.completedAt).toBeUndefined();
    expect(cleared?.supervisor).toBeUndefined();
  });

  it('updates columns and reconciles orphaned tasks into a valid column', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'Keep me', columnId: 'backlog' });
    // Replace columns with a fresh set (backlog id preserved so task stays valid)
    const updated = await updateBoard(tmpDir, b.id, {
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
        { id: 'done', title: 'Done', order: 1, wipLimit: 0 },
      ],
    });
    expect(updated).not.toBeNull();
    const stored = await getBoard(tmpDir, b.id);
    expect(stored!.tasks.find((x) => x.id === t!.task.id)?.columnId).toBe('backlog');
  });

  it('rejects an invalid managed lifecycle policy', async () => {
    const b = await makeBoard(managedLifecycle());
    // Point two stages at the same column -> distinctness failure
    await expect(
      updateBoard(tmpDir, b.id, {
        lifecycle: { mode: 'managed', columns: { backlog: 'backlog', todo: 'backlog', running: 'in-progress', review: 'review', done: 'done' } },
      }),
    ).rejects.toThrow('distinct');
  });
});

describe('addColumn edges', () => {
  it('adds a column with description, color, wipLimit, and a generated id', async () => {
    const b = await makeBoard();
    const result = await addColumn(tmpDir, b.id, { title: 'Custom Col', description: 'd', color: '#fff', wipLimit: 3 });
    expect(result?.column.id).toBe('custom-col');
    expect(result?.column.color).toBe('#fff');
    expect(result?.column.wipLimit).toBe(3);
  });
  it('returns null for an unknown board', async () => {
    expect(await addColumn(tmpDir, 'nope', { title: 'X' })).toBeNull();
  });
});

describe('updateColumn edges', () => {
  it('updates order, wipLimit, and description', async () => {
    const b = await makeBoard();
    const colId = b.columns[0]!.id;
    const updated = await updateColumn(tmpDir, b.id, colId, { order: 5, wipLimit: 2, description: 'new' });
    expect(updated).not.toBeNull();
    const col = updated!.columns.find((c) => c.id === colId);
    expect(col?.wipLimit).toBe(2);
    expect(col?.description).toBe('new');
  });
  it('returns null for unknown board or column', async () => {
    const b = await makeBoard();
    expect(await updateColumn(tmpDir, b.id, 'no-such-col', { title: 'X' })).toBeNull();
    expect(await updateColumn(tmpDir, 'no-board', 'backlog', { title: 'X' })).toBeNull();
  });
});

describe('removeColumn edges', () => {
  it('throws when removing a non-empty column without a move target', async () => {
    const b = await createBoard(tmpDir, {
      title: 'X',
      columns: [
        { id: 'a', title: 'A', order: 0, wipLimit: 0 },
        { id: 'b', title: 'B', order: 1, wipLimit: 0 },
      ],
    });
    await addTask(tmpDir, b.id, { title: 'task', columnId: 'a' });
    await expect(removeColumn(tmpDir, b.id, 'a')).rejects.toThrow('has tasks');
  });
  it('throws when moving to the same column being removed', async () => {
    const b = await createBoard(tmpDir, {
      title: 'X',
      columns: [
        { id: 'a', title: 'A', order: 0, wipLimit: 0 },
        { id: 'b', title: 'B', order: 1, wipLimit: 0 },
      ],
    });
    await addTask(tmpDir, b.id, { title: 'task', columnId: 'a' });
    await expect(removeColumn(tmpDir, b.id, 'a', { moveTasksToColumnId: 'a' })).rejects.toThrow('Cannot move');
  });
  it('throws when move target column does not exist', async () => {
    const b = await createBoard(tmpDir, {
      title: 'X',
      columns: [{ id: 'a', title: 'A', order: 0, wipLimit: 0 }],
    });
    await addTask(tmpDir, b.id, { title: 'task', columnId: 'a' });
    await expect(removeColumn(tmpDir, b.id, 'a', { moveTasksToColumnId: 'nope' })).rejects.toThrow('Target column not found');
  });
  it('removes an empty column without tasks', async () => {
    const b = await createBoard(tmpDir, {
      title: 'X',
      columns: [
        { id: 'a', title: 'A', order: 0, wipLimit: 0 },
        { id: 'b', title: 'B', order: 1, wipLimit: 0 },
      ],
    });
    const result = await removeColumn(tmpDir, b.id, 'b');
    expect(result?.columns.find((c) => c.id === 'b')).toBeUndefined();
  });
  it('returns null for unknown board or column', async () => {
    const b = await makeBoard();
    expect(await removeColumn(tmpDir, b.id, 'no-such-col')).toBeNull();
    expect(await removeColumn(tmpDir, 'no-board', 'backlog')).toBeNull();
  });
});

describe('duplicateBoard edges', () => {
  it('omits completed tasks when includeCompletedTasks is false', async () => {
    const b = await makeBoard();
    await addTask(tmpDir, b.id, { title: 'Active' });
    await addTask(tmpDir, b.id, { title: 'Done', status: 'completed', columnId: 'done' });
    const dup = await duplicateBoard(tmpDir, b.id, { includeCompletedTasks: false });
    expect(dup!.tasks.map((t) => t.title)).toContain('Active');
    expect(dup!.tasks.map((t) => t.title)).not.toContain('Done');
  });
  it('preserves assignment when requested', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X', assignedAgent: 'bot', assignee: 'ada' });
    const dup = await duplicateBoard(tmpDir, b.id, { preserveAssignment: true });
    const copied = dup!.tasks.find((x) => x.title === 'X');
    expect(copied?.assignedAgent).toBe('bot');
    expect(copied?.assignee).toBe('ada');
    // Reference task id should not carry over
    expect(copied?.id).not.toBe(t!.task.id);
  });
  it('duplicates a managed board and restarts cards in backlog', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle(), tasks: [{ title: 'Managed', description: 'Duplicated managed board test card.' }] });
    const dup = await duplicateBoard(tmpDir, b.id);
    const card = dup!.tasks[0]!;
    expect(card.columnId).toBe('backlog');
    expect(card.status).toBe('pending');
    expect(card.lifecycle?.currentStage).toBe('backlog');
  });
});

// ── tasks.ts edges ───────────────────────────────────────────────────

describe('addTask edges', () => {
  it('returns null for an unknown board', async () => {
    expect(await addTask(tmpDir, 'nope', { title: 'X' })).toBeNull();
  });
});

describe('updateTask edges', () => {
  it('clears dueDate with null and moves column with status sync', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X', dueDate: '2026-08-01' });
    const updated = await updateTask(tmpDir, b.id, t!.task.id, {
      dueDate: null,
      status: 'completed',
    });
    const task = updated!.tasks.find((x) => x.id === t!.task.id)!;
    expect(task.dueDate).toBeUndefined();
    expect(task.status).toBe('completed');
    expect(task.completedAt).toBeDefined();
  });
  it('throws when moving to a non-existent column', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await expect(updateTask(tmpDir, b.id, t!.task.id, { columnId: 'ghost' })).rejects.toThrow('Column not found');
  });
  it('returns null for an unknown task', async () => {
    const b = await makeBoard();
    expect(await updateTask(tmpDir, b.id, 'nope', { title: 'X' })).toBeNull();
  });
  it('reorders tasks when an explicit order is given', async () => {
    const b = await makeBoard();
    const a = await addTask(tmpDir, b.id, { title: 'A', columnId: 'backlog' });
    const c = await addTask(tmpDir, b.id, { title: 'C', columnId: 'backlog' });
    await updateTask(tmpDir, b.id, a!.task.id, { order: 5 });
    const stored = await getBoard(tmpDir, b.id);
    const aTask = stored!.tasks.find((t) => t.id === a!.task.id)!;
    const cTask = stored!.tasks.find((t) => t.id === c!.task.id)!;
    expect(aTask.order).toBeGreaterThan(cTask.order);
  });
});

describe('removeTask edges', () => {
  it('cleans up references in dependent tasks', async () => {
    const b = await makeBoard();
    const parent = await addTask(tmpDir, b.id, { title: 'Parent' });
    const child = await addTask(tmpDir, b.id, { title: 'Child', dependsOn: [parent!.task.id], parentTaskId: parent!.task.id, chain: { chainId: 'ch', order: 1, previousTaskId: parent!.task.id } });
    await removeTask(tmpDir, b.id, parent!.task.id);
    const stored = await getBoard(tmpDir, b.id);
    const childTask = stored!.tasks.find((t) => t.id === child!.task.id)!;
    expect(childTask.dependsOn).toBeUndefined();
    expect(childTask.parentTaskId).toBeUndefined();
    expect(childTask.chain?.previousTaskId).toBeUndefined();
  });
  it('returns null for an unknown task', async () => {
    const b = await makeBoard();
    expect(await removeTask(tmpDir, b.id, 'nope')).toBeNull();
  });
});

describe('transferTaskToBoard', () => {
  it('moves within the same board when source and target are equal', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X', columnId: 'backlog' });
    const result = await transferTaskToBoard(tmpDir, b.id, t!.task.id, b.id, { targetColumnId: 'done' });
    expect(result).not.toBeNull();
    const stored = await getBoard(tmpDir, b.id);
    expect(stored!.tasks.find((x) => x.id === t!.task.id)?.columnId).toBe('done');
  });
  it('cross-board transfer copies then removes the source', async () => {
    const src = await makeBoard();
    const dst = await createBoard(tmpDir, { title: 'Dst' });
    const t = await addTask(tmpDir, src.id, { title: 'Move' });
    const result = await transferTaskToBoard(tmpDir, src.id, t!.task.id, dst.id);
    expect(result).not.toBeNull();
    const srcStored = await getBoard(tmpDir, src.id);
    const dstStored = await getBoard(tmpDir, dst.id);
    expect(srcStored!.tasks).toHaveLength(0);
    expect(dstStored!.tasks.find((x) => x.title === 'Move')).toBeDefined();
  });
  it('returns null when source board or task is missing', async () => {
    const dst = await makeBoard();
    expect(await transferTaskToBoard(tmpDir, 'nope', 'x', dst.id)).toBeNull();
  });
});

describe('goal metrics', () => {
  it('addGoalMetricToTask returns null for unknown task', async () => {
    const b = await makeBoard();
    expect(await addGoalMetricToTask(tmpDir, b.id, 'nope', { name: 'M' })).toBeNull();
  });
  it('updateGoalMetricOnTask returns null for unknown task or metric', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    expect(await updateGoalMetricOnTask(tmpDir, b.id, t!.task.id, 'nope', { current: 1 })).toBeNull();
    expect(await updateGoalMetricOnTask(tmpDir, b.id, 'nope', 'nope', { current: 1 })).toBeNull();
  });
  it('updates a metric by prefix id', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await addGoalMetricToTask(tmpDir, b.id, t!.task.id, { name: 'Speed', target: 100 });
    const stored = await getBoard(tmpDir, b.id);
    const metricId = stored!.tasks.find((x) => x.id === t!.task.id)!.goalMetrics![0]!.id;
    const prefix = metricId.slice(0, 8);
    const updated = await updateGoalMetricOnTask(tmpDir, b.id, t!.task.id, prefix, { current: 42, status: 'met' });
    const metric = updated!.tasks.find((x) => x.id === t!.task.id)!.goalMetrics![0]!;
    expect(metric.current).toBe(42);
    expect(metric.status).toBe('met');
  });
});

describe('recordTaskActivity + listKanbanEvents', () => {
  it('records an activity event and returns null for an unknown task', async () => {
    const b = await makeBoard();
    expect(await recordTaskActivity(tmpDir, b.id, 'nope', { kind: 'observation', summary: 's' })).toBeNull();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await recordTaskActivity(tmpDir, b.id, t!.task.id, { kind: 'attempt', summary: 'tried', outcome: 'failed', details: 'd' });
    const events = await listKanbanEvents(tmpDir, b.id);
    expect(events.some((e) => e.type === 'task.activity.attempt')).toBe(true);
  });
  it('listTaskActivity clamps the limit', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    for (let i = 0; i < 5; i++) {
      await recordTaskActivity(tmpDir, b.id, t!.task.id, { kind: 'observation', summary: `s${i}` });
    }
    const activity = await listTaskActivity(tmpDir, b.id, t!.task.id, { limit: 2 });
    expect(activity).toHaveLength(2);
    // Limit clamped to a minimum of 1
    const one = await listTaskActivity(tmpDir, b.id, t!.task.id, { limit: 0 });
    expect(one).toHaveLength(1);
  });
});

// ── assignment.ts edges ──────────────────────────────────────────────

describe('updateTaskAssignment edges', () => {
  it('marks a cancelled assignment as blocked', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await assignTask(tmpDir, b.id, t!.task.id, { agentId: 'bot' });
    const updated = await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'cancelled', error: 'aborted' });
    const task = updated!.tasks.find((x) => x.id === t!.task.id)!;
    expect(task.status).toBe('blocked');
    expect(task.assignment?.error).toBe('aborted');
  });
  it('marks a running assignment as in_progress and stamps dispatchedAt', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await assignTask(tmpDir, b.id, t!.task.id, { agentId: 'bot' });
    const updated = await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'running' });
    const task = updated!.tasks.find((x) => x.id === t!.task.id)!;
    expect(task.status).toBe('in_progress');
    expect(task.assignment?.dispatchedAt).toBeDefined();
  });
  it('re-queues a completed task back to ready on queued status', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await assignTask(tmpDir, b.id, t!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'completed' });
    const updated = await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'queued' });
    const task = updated!.tasks.find((x) => x.id === t!.task.id)!;
    expect(task.status).toBe('ready');
  });
  it('returns null for an unknown task', async () => {
    const b = await makeBoard();
    expect(await updateTaskAssignment(tmpDir, b.id, 'nope', { status: 'running' })).toBeNull();
  });
  it('preserves managed card column on assignment update and stamps managed completedAt', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle(), tasks: [{ title: 'Card', description: 'Assignment update test card.' }] });
    const card = (await getBoard(tmpDir, b.id))!.tasks[0]!;
    const updated = await updateTaskAssignment(tmpDir, b.id, card.id, { status: 'completed' });
    const task = updated!.tasks.find((x) => x.id === card.id)!;
    expect(task.assignment?.completedAt).toBeDefined();
    // Managed column stays in backlog (no lifecycle advance)
    expect(task.columnId).toBe('backlog');
  });
});

describe('recoverStaleTaskAssignments edges', () => {
  it('fails when retry budget is exhausted', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await assignTask(tmpDir, b.id, t!.task.id, { agentId: 'bot', maxAttempts: 1 });
    await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'queued', leaseExpiresAt: '2020-01-01T00:00:00Z', attempt: 1 });
    const result = await recoverStaleTaskAssignments(tmpDir, b.id, { mode: 'retry' });
    expect(result!.tasks[0]!.assignment?.status).toBe('failed');
    expect(result!.tasks[0]!.status).toBe('failed');
  });
  it('auto mode with policy routes to fail on cost ceiling', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X', costCeilingUsd: 5 });
    await assignTask(tmpDir, b.id, t!.task.id, { agentId: 'bot', costCeilingUsd: 5 });
    await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'queued', leaseExpiresAt: '2020-01-01T00:00:00Z' });
    const result = await recoverStaleTaskAssignments(tmpDir, b.id, { mode: 'auto', policy: { failWhenCostCeilingSet: true } });
    expect(result!.tasks[0]!.assignment?.status).toBe('failed');
  });
  it('skips tasks that are not queued/running', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await assignTask(tmpDir, b.id, t!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'completed' });
    const result = await recoverStaleTaskAssignments(tmpDir, b.id, { mode: 'retry' });
    expect(result).toBeNull();
  });
});

describe('getKanbanOrchestrationSnapshot', () => {
  it('classifies tasks into ready/queued/running/blocked/review/failed/completed', async () => {
    const b = await makeBoard();
    await addTask(tmpDir, b.id, { title: 'Ready' });
    const runByStatus = await addTask(tmpDir, b.id, { title: 'Review', status: 'review', columnId: 'review' });
    await addTask(tmpDir, b.id, { title: 'Failed', status: 'failed', columnId: 'review' });
    await addTask(tmpDir, b.id, { title: 'Done', status: 'completed', columnId: 'done' });
    const snap = await getKanbanOrchestrationSnapshot(tmpDir, { boardId: b.id });
    expect(snap.ready.length).toBeGreaterThanOrEqual(1);
    expect(snap.review.some((r) => r.task.id === runByStatus!.task.id)).toBe(true);
    expect(snap.failed.length).toBeGreaterThanOrEqual(1);
    expect(snap.completed.length).toBeGreaterThanOrEqual(1);
  });
  it('returns an empty snapshot shape when no boards match', async () => {
    const snap = await getKanbanOrchestrationSnapshot(tmpDir, { boardId: 'nope' });
    expect(snap.boards).toEqual([]);
    expect(snap.ready).toEqual([]);
  });
});

describe('getKanbanQueueHealth', () => {
  it('counts ready/running/heartbeat/stale/failedRetryable across a board', async () => {
    const b = await makeBoard();
    // A freshly added task is pending, not ready (ready requires status:'ready').
    await addTask(tmpDir, b.id, { title: 'Pending' });
    // A genuinely-ready task increments counts.ready.
    await addTask(tmpDir, b.id, { title: 'Ready', status: 'ready' });
    const runner = await addTask(tmpDir, b.id, { title: 'Runner' });
    await assignTask(tmpDir, b.id, runner!.task.id, { agentId: 'bot' });
    // Lease expires just 10s after `now` => within the default 60s heartbeat interval
    // => the runner is counted in heartbeatDue.
    await updateTaskAssignment(tmpDir, b.id, runner!.task.id, {
      status: 'running',
      leaseId: 'lease-runner',
      heartbeatAt: '2026-07-17T00:00:00Z',
      leaseExpiresAt: '2026-07-17T00:00:10Z',
    });
    const health = await getKanbanQueueHealth(tmpDir, { boardId: b.id, now: '2026-07-17T00:00:05Z' });
    expect(health.counts.pending).toBeGreaterThanOrEqual(1);
    expect(health.counts.ready).toBeGreaterThanOrEqual(1);
    expect(health.counts.running).toBeGreaterThanOrEqual(1);
    // Heartbeat is genuinely due (lease lapses within heartbeatIntervalMs).
    expect(health.heartbeatDue.count).toBe(1);
    expect(health.heartbeatDue.tasks[0]!.task.id).toBe(runner!.task.id);
    expect(health.classifications.counts.claimable).toBeGreaterThanOrEqual(2);
    expect(health.classifications.counts.running_live).toBe(1);
    expect(
      health.classifications.diagnostics.some(
        (diagnostic) =>
          diagnostic.taskId === runner!.task.id && diagnostic.bucket === 'running_live',
      ),
    ).toBe(true);
  });
  it('surfaces classifier diagnostics for stale and status-only running tasks', async () => {
    const b = await makeBoard();
    const stale = await addTask(tmpDir, b.id, { title: 'Stale' });
    await assignTask(tmpDir, b.id, stale!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, b.id, stale!.task.id, {
      status: 'running',
      leaseId: 'lease-1',
      leaseExpiresAt: '2020-01-01T00:00:00Z',
    });
    await addTask(tmpDir, b.id, { title: 'Status only', status: 'in_progress', columnId: 'in-progress' });

    const health = await getKanbanQueueHealth(tmpDir, { boardId: b.id, now: '2026-07-17T00:00:00Z' });

    expect(health.classifications.counts.running_expired).toBe(1);
    expect(health.classifications.counts.running_no_lease).toBe(1);
    expect(health.classifications.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: stale!.task.id, bucket: 'running_expired' }),
        expect.objectContaining({ bucket: 'running_no_lease' }),
      ]),
    );
  });
  it('surfaces stale assignments and lastStaleRecoveredAt after recovery', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'Stale' });
    await assignTask(tmpDir, b.id, t!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, b.id, t!.task.id, { status: 'queued', leaseExpiresAt: '2020-01-01T00:00:00Z' });
    const before = await getKanbanQueueHealth(tmpDir, { boardId: b.id, now: '2026-07-17T00:00:00Z' });
    expect(before.staleAssignments.count).toBe(1);
    await recoverStaleTaskAssignments(tmpDir, b.id, { mode: 'retry', now: '2026-07-17T00:00:00Z' });
    const after = await getKanbanQueueHealth(tmpDir, { boardId: b.id, now: '2026-07-17T00:00:00Z' });
    expect(after.lastStaleRecoveredAt).toBeDefined();
  });
});

// ── lifecycle.ts edges ───────────────────────────────────────────────

describe('transitionTask edges', () => {
  it('returns null for an unknown task and rejects backwards transitions', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle(), tasks: [{ title: 'X', description: 'd', dueDate: '2026-08-01', assignee: 'a', labels: ['l'], childTaskIds: ['c1'], successCriteria: [{ id: 'c1', description: 'c', type: 'manual', status: 'pending' }], assignment: { status: 'running', agentId: 'a', leaseId: 'l', claimedAt: '2026-07-17T00:00:00Z', heartbeatAt: '2026-07-17T00:00:00Z', leaseExpiresAt: '2026-07-18T00:00:00Z' } }] });
    const card = (await getBoard(tmpDir, b.id))!.tasks[0]!;
    expect(await transitionTask(tmpDir, b.id, 'nope', { to: 'todo', actor: 'a', comment: 'c' })).toBeNull();
    // Backwards transition from backlog -> done (non-adjacent) is rejected
    await expect(transitionTask(tmpDir, b.id, card.id, { to: 'done', actor: 'a', comment: 'c' })).rejects.toThrow('one stage at a time');
  });
  it('requires a managed board and rejects transitions on legacy boards', async () => {
    const b = await makeBoard();
    const t = await addTask(tmpDir, b.id, { title: 'X' });
    await expect(transitionTask(tmpDir, b.id, t!.task.id, { to: 'todo', actor: 'a', comment: 'c' })).rejects.toThrow('managed board');
  });
  it('rejects transition with missing actor and comment', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle(), tasks: [{ title: 'X', description: 'Transition validation test card.' }] });
    const card = (await getBoard(tmpDir, b.id))!.tasks[0]!;
    await expect(transitionTask(tmpDir, b.id, card.id, { to: 'todo', actor: '', comment: 'c' })).rejects.toThrow('actor');
    await expect(transitionTask(tmpDir, b.id, card.id, { to: 'todo', actor: 'a', comment: '' })).rejects.toThrow('comment');
  });
});

// ── presence.ts edges ────────────────────────────────────────────────

describe('presence edges', () => {
  it('returns null for an unknown board', async () => {
    expect(await touchKanbanPresence(tmpDir, 'nope', { sessionId: 's', agentId: 'a' })).toBeNull();
    expect(await getBoardWithLivePresence(tmpDir, 'nope')).toBeNull();
  });
  it('no-ops when sessionId or agentId is blank, returning the board unchanged', async () => {
    const b = await makeBoard();
    const result = await touchKanbanPresence(tmpDir, b.id, { sessionId: '  ', agentId: 'a' });
    // Blank session returns the board without writing presence
    expect(result?.presence ?? []).toEqual([]);
  });
  it('getBoardWithLivePresence derives active state from a custom now', async () => {
    const b = await makeBoard();
    const touched = await touchKanbanPresence(tmpDir, b.id, { sessionId: 's', agentId: 'a', seenAt: '2026-07-17T00:00:00Z', ttlMs: 60_000 });
    expect(touched?.presence?.[0]?.active).toBe(true);
    const later = await getBoardWithLivePresence(tmpDir, b.id, new Date('2026-07-17T00:02:00Z'));
    expect(later?.presence?.[0]?.active).toBe(false);
  });
});

// ── serialization.ts searchKanban / listReadyTasks edges ─────────────

describe('searchKanban + listReadyTasks edges', () => {
  it('searchKanban scopes to a single boardId', async () => {
    const b1 = await makeBoard();
    const b2 = await createBoard(tmpDir, { title: 'Other' });
    await addTask(tmpDir, b1.id, { title: 'On b1' });
    await addTask(tmpDir, b2.id, { title: 'On b2' });
    const results = await searchKanban(tmpDir, { boardId: b1.id });
    expect(results.every((r) => r.board.id === b1.id)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
  it('listReadyTasks respects the limit and filters by priority', async () => {
    const b = await makeBoard();
    await addTask(tmpDir, b.id, { title: 'A', priority: 'low' });
    await addTask(tmpDir, b.id, { title: 'B', priority: 'high' });
    const results = await listReadyTasks(tmpDir, { priority: 'high', limit: 5 });
    expect(results.every((r) => r.task.priority === 'high')).toBe(true);
  });
});

// ── splitTask + setTaskChain edges ───────────────────────────────────

describe('splitTask edges', () => {
  it('inherits labels and dependencies, and chains children when asked', async () => {
    const b = await makeBoard();
    const dep = await addTask(tmpDir, b.id, { title: 'Dep' });
    const parent = await addTask(tmpDir, b.id, { title: 'Parent', labels: ['x'], dependsOn: [dep!.task.id] });
    const result = await splitTask(tmpDir, b.id, parent!.task.id, {
      titles: ['C1', 'C2'],
      inheritLabels: true,
      inheritDependencies: true,
      chainChildren: true,
    });
    expect(result).not.toBeNull();
    const stored = await getBoard(tmpDir, b.id);
    const children = stored!.tasks.filter((t) => t.parentTaskId === parent!.task.id);
    expect(children).toHaveLength(2);
    expect(children[0]!.labels).toContain('x');
    expect(children[0]!.dependsOn).toContain(dep!.task.id);
    expect(children[0]!.chain?.chainId).toBe(children[1]!.chain?.chainId);
  });
  it('rewires dependents of the parent onto the children by default', async () => {
    const b = await makeBoard();
    const parent = await addTask(tmpDir, b.id, { title: 'P' });
    const dependent = await addTask(tmpDir, b.id, { title: 'D', dependsOn: [parent!.task.id] });
    await splitTask(tmpDir, b.id, parent!.task.id, { titles: ['C1', 'C2'] });
    const stored = await getBoard(tmpDir, b.id);
    const dep = stored!.tasks.find((t) => t.id === dependent!.task.id)!;
    // No longer depends directly on parent; rewired onto the children
    expect(dep.dependsOn).not.toContain(parent!.task.id);
    expect(dep.dependsOn?.length).toBeGreaterThanOrEqual(1);
  });
  it('throws when no titles are provided', async () => {
    const b = await makeBoard();
    const parent = await addTask(tmpDir, b.id, { title: 'P' });
    await expect(splitTask(tmpDir, b.id, parent!.task.id, { titles: [] })).rejects.toThrow('at least one child title');
  });

  it('creates managed-board children in backlog even when the parent advanced', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Managed split',
      lifecycle: managedLifecycle(),
      tasks: [{ title: 'Parent', ...managedCardDetails('Parent task for managed split.') }],
    });
    const parent = b.tasks[0]!;
    await transitionTask(tmpDir, b.id, parent.id, {
      to: 'todo',
      actor: 'tester',
      comment: 'Advance parent before splitting.',
    });

    const result = await splitTask(tmpDir, b.id, parent.id, {
      titles: ['Child'],
      childSpecs: [{ description: 'Managed child from split.' }],
    });

    expect(result).not.toBeNull();
    expect(result!.children[0]!.columnId).toBe('backlog');
    expect(result!.children[0]!.lifecycle?.currentStage).toBe('backlog');
  });

  it('requires descriptions for new managed-board children', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Managed split validation',
      lifecycle: managedLifecycle(),
      tasks: [{ title: 'Parent', ...managedCardDetails('Parent task for managed split validation.') }],
    });
    const parent = b.tasks[0]!;

    await expect(
      splitTask(tmpDir, b.id, parent.id, { titles: ['Child'], childSpecs: [{ description: '' }] }),
    ).rejects.toThrow('Add a complete task description.');
  });
});

describe('mergeTasks managed lifecycle edges', () => {
  it('creates the merged managed-board task in backlog even when a source advanced', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Managed merge',
      lifecycle: managedLifecycle(),
      tasks: [
        { title: 'First', ...managedCardDetails('First task for managed merge.') },
        { title: 'Second', ...managedCardDetails('Second task for managed merge.') },
      ],
    });
    const first = b.tasks[0]!;
    const second = b.tasks[1]!;
    await transitionTask(tmpDir, b.id, first.id, {
      to: 'todo',
      actor: 'tester',
      comment: 'Advance source before merge.',
    });

    const result = await mergeTasks(tmpDir, b.id, {
      taskIds: [first.id, second.id],
      title: 'Merged',
    });

    expect(result).not.toBeNull();
    expect(result!.task.columnId).toBe('backlog');
    expect(result!.task.lifecycle?.currentStage).toBe('backlog');
  });

  it('requires descriptions for new merged tasks on managed boards', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Managed merge validation',
      lifecycle: managedLifecycle(),
      tasks: [
        { title: 'First', ...managedCardDetails('First task for managed merge validation.') },
        { title: 'Second', ...managedCardDetails('Second task for managed merge validation.') },
      ],
    });

    await expect(
      mergeTasks(tmpDir, b.id, {
        taskIds: [b.tasks[0]!.id, b.tasks[1]!.id],
        title: 'Merged',
        description: '',
      }),
    ).rejects.toThrow('Add a complete task description.');
  });
});

describe('setTaskChain edges', () => {
  it('returns null for an unknown board', async () => {
    expect(await setTaskChain(tmpDir, 'nope', { taskIds: [] })).toBeNull();
  });
  it('re-normalizes the previous chain when tasks are moved to a new one', async () => {
    const b = await makeBoard();
    const a = await addTask(tmpDir, b.id, { title: 'A' });
    const c = await addTask(tmpDir, b.id, { title: 'C' });
    const d = await addTask(tmpDir, b.id, { title: 'D' });
    await setTaskChain(tmpDir, b.id, { taskIds: [a!.task.id, c!.task.id], chainId: 'old' });
    // Move A into a new chain; old chain should renormalize around C
    await setTaskChain(tmpDir, b.id, { taskIds: [a!.task.id, d!.task.id], chainId: 'new' });
    const stored = await getBoard(tmpDir, b.id);
    const cTask = stored!.tasks.find((t) => t.id === c!.task.id)!;
    expect(cTask.chain?.chainId).toBe('old');
    expect(cTask.chain?.previousTaskId).toBeUndefined();
  });
});
