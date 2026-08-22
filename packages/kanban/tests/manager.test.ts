import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as internalModule from '../src/manager/_internal.js';
import {
  addCheckToTask,
  addColumn,
  addDependency,
  addLinkToTask,
  addNoteToTask,
  addTask,
  areDependenciesMet,
  assignTask,
  buildTaskGraphFromKanbanBoard,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  createBoardFromText,
  duplicateBoard,
  exportBoardAsMarkdown,
  exportBoardToTaskGraph,
  findBlockedTasks,
  getBoard,
  getKanbanQueueHealth,
  getTask,
  heartbeatTaskAssignment,
  listBoards,
  listReadyTasks,
  mergeTasks,
  moveTask,
  parseLinesIntoTasks,
  reconcileKanbanBoard,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeBoard,
  removeColumn,
  removeTask,
  StaleWriteError,
  searchKanban,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  transitionTask,
  updateBoard,
  updateCheckOnTask,
  updateColumn,
  updateTask,
  updateTaskAssignment,
} from '../src/manager.js';
import type { KanbanBoard } from '../src/types.js';
import type { ClaimKanbanTaskInput } from '../src/types-operations.js';
import { CURRENT_KANBAN_VERSION } from '../src/types-operations.js';
import { finalizeTaskCompletion } from '../src/verification/completion-gate.js';

// hoisted: makes _internal.js exports mockable so vi.spyOn intercepts
// imports from assignment.ts (named imports create separate live bindings
// that vi.spyOn on a namespace proxy cannot reach without vi.mock).
vi.mock('../src/manager/_internal.js', async (importOriginal) => ({
  ...(await importOriginal()),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-test-'));
});

async function makeBoard(input?: { title?: string; description?: string }) {
  return createBoard(tmpDir, {
    title: input?.title ?? 'Test Board',
    description: input?.description,
  });
}

function sampleBoard(overrides?: Partial<KanbanBoard>): KanbanBoard {
  const now = new Date().toISOString();
  return {
    id: 'board-1',
    title: 'Test Board',
    description: 'A test board',
    columns: [
      { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
      { id: 'in-progress', title: 'In Progress', order: 1, wipLimit: 5 },
      { id: 'done', title: 'Done', order: 2, wipLimit: 0 },
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'Task one',
        columnId: 'backlog',
        order: 0,
        priority: 'high',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-2',
        title: 'Task two',
        columnId: 'backlog',
        order: 1,
        priority: 'medium',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'task-3',
        title: 'Task three',
        columnId: 'done',
        order: 0,
        priority: 'low',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

// ── createBoardFromText ─────────────────────────────────────────

describe('managed Kanban Agent lifecycle', () => {
  async function managedBoard() {
    return createBoard(tmpDir, {
      title: 'Managed Board',
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
  }

  function completeDetails() {
    const lease = '2026-07-15T12:00:00.000Z';
    return {
      description: 'Implement and verify the managed lifecycle.',
      dueDate: '2026-07-20T00:00:00.000Z',
      assignee: 'agent-1',
      labels: ['kanban'],
      childTaskIds: ['subtask-1'],
      successCriteria: [
        {
          id: 'criterion-1',
          description: 'Lifecycle enforcement is verified.',
          type: 'manual' as const,
          status: 'pending' as const,
        },
      ],
      assignment: {
        status: 'running' as const,
        agentId: 'agent-1',
        leaseId: 'lease-1',
        claimedAt: lease,
        heartbeatAt: lease,
        leaseExpiresAt: '2026-07-16T12:00:00.000Z',
      },
    };
  }

  it('rejects under-filled cards and skipped direct moves', async () => {
    const board = await managedBoard();
    const created = await addTask(tmpDir, board.id, {
      title: 'Managed task',
      description: 'Test task for under-filled card validation.',
    });
    expect(created?.task.lifecycle?.currentStage).toBe('backlog');
    await expect(
      transitionTask(tmpDir, board.id, created!.task.id, {
        to: 'todo',
        actor: 'agent-1',
        comment: 'Ready to plan.',
      }),
    ).rejects.toThrow('Assign an owner');
    await expect(moveTask(tmpDir, board.id, created!.task.id, 'done')).rejects.toThrow(
      'must use transitionTask',
    );
    const stored = await getBoard(tmpDir, board.id);
    expect(stored?.tasks[0]?.columnId).toBe('backlog');
    expect(stored?.tasks[0]?.lifecycle?.history).toHaveLength(1);
  });

  it('persists every adjacent transition and blocks Done until review evidence passes', async () => {
    const board = await managedBoard();
    const created = await addTask(tmpDir, board.id, {
      title: 'Managed task',
      ...completeDetails(),
    });
    const todo = await transitionTask(tmpDir, board.id, created!.task.id, {
      to: 'todo',
      actor: 'agent-1',
      comment: 'Details verified; task accepted.',
    });
    expect(todo?.task.status).toBe('ready');
    expect(todo?.task.columnId).toBe('todo');
    const running = await transitionTask(tmpDir, board.id, created!.task.id, {
      to: 'running',
      actor: 'agent-1',
      comment: 'Implementation started.',
    });
    expect(running?.task.status).toBe('in_progress');
    expect(running?.task.lifecycle?.history).toHaveLength(3);

    await updateTaskAssignment(tmpDir, board.id, created!.task.id, {
      status: 'completed',
      lastResult: 'Implementation and focused tests completed.',
    });
    const afterWorker = await getBoard(tmpDir, board.id);
    expect(afterWorker?.tasks[0]?.lifecycle?.currentStage).toBe('running');
    expect(afterWorker?.tasks[0]?.status).toBe('in_progress');

    const review = await transitionTask(tmpDir, board.id, created!.task.id, {
      to: 'review',
      actor: 'agent-1',
      comment: 'Implementation complete; requesting review.',
      attachment: { url: 'artifact://focused-tests', type: 'file' },
    });
    expect(review?.task.status).toBe('review');
    await expect(
      transitionTask(tmpDir, board.id, created!.task.id, {
        to: 'done',
        actor: 'reviewer-1',
        action: 'Approved',
        comment: 'Reviewed.',
        attachment: { url: 'review://approval', type: 'url' },
      }),
    ).rejects.toThrow('explicitly passed');

    await updateCheckOnTask(tmpDir, board.id, created!.task.id, 'criterion-1', {
      status: 'passed',
      checkedBy: 'reviewer-1',
      checkedAt: '2026-07-15T13:00:00.000Z',
    });
    const done = await transitionTask(tmpDir, board.id, created!.task.id, {
      to: 'done',
      actor: 'reviewer-1',
      action: 'Approved',
      comment: 'Acceptance criteria passed and evidence reviewed.',
      attachment: { url: 'review://approval', type: 'url' },
    });
    expect(done?.task.status).toBe('completed');
    expect(done?.task.columnId).toBe('done');
    expect(done?.task.lifecycle?.history.map((entry) => entry.to)).toEqual([
      'backlog',
      'todo',
      'running',
      'review',
      'done',
    ]);
  });

  it('restarts copied cards in managed Backlog and protects lifecycle columns', async () => {
    const source = await makeBoard();
    const sourceTask = await addTask(tmpDir, source.id, {
      title: 'Copied task',
      description: 'Source task for copy-to-managed-board test.',
      columnId: 'done',
      status: 'completed',
    });
    const target = await managedBoard();
    const copied = await copyTaskToBoard(tmpDir, source.id, sourceTask!.task.id, target.id);
    expect(copied?.task.columnId).toBe('backlog');
    expect(copied?.task.status).toBe('pending');
    expect(copied?.task.lifecycle?.history.map((entry) => entry.to)).toEqual(['backlog']);
    // Columns are locked — removeColumn always throws (formerly it threw only
    // for managed lifecycle columns; now it throws for all columns).
    await expect(removeColumn(tmpDir, target.id, 'backlog')).rejects.toThrow(/Columns are locked/);
  });

  it('keeps legacy boards compatible with direct moves', async () => {
    const board = await makeBoard();
    const created = await addTask(tmpDir, board.id, { title: 'Legacy task' });
    const moved = await moveTask(tmpDir, board.id, created!.task.id, 'done');
    expect(moved?.tasks[0]?.status).toBe('completed');
  });
});

describe('createBoardFromText', () => {
  it('generates a board from a description with default columns', () => {
    const result = createBoardFromText({
      description: 'My board description',
    });
    expect(result.title).toBe('Kanban: My board description');
    // Columns are no longer on the result — createBoard supplies them via
    // normalizeColumns (always DEFAULT_COLUMNS). The former 4-column default
    // (which dropped "done") is gone.
    expect(result.columns).toBeUndefined();
    expect(result.tasks).toEqual([]);
  });

  it('uses input title when provided', () => {
    const result = createBoardFromText({
      title: 'Custom Title',
      description: 'desc',
    });
    expect(result.title).toBe('Custom Title');
  });

  it('truncates long description in auto-title', () => {
    const long = 'a'.repeat(100);
    const result = createBoardFromText({ description: long });
    expect(result.title).toBe(`Kanban: ${'a'.repeat(60)}...`);
  });

  it('includes context when provided', () => {
    const result = createBoardFromText({
      description: 'Do the thing',
      context: 'Because reasons',
    });
    expect(result.description).toContain('Context: Because reasons');
  });

  it('ignores custom column count — columns are locked', () => {
    const result = createBoardFromText({
      description: 'desc',
      columnCount: 3,
    });
    // columnCount is ignored; createBoard will apply the 5 standard columns.
    expect(result.columns).toBeUndefined();
  });

  it('ignores custom column titles — columns are locked', () => {
    const result = createBoardFromText({
      description: 'desc',
      columns: ['Alpha', 'Beta'],
    });
    // Custom titles are ignored; createBoard will apply the 5 standard columns.
    expect(result.columns).toBeUndefined();
  });
});

// ── parseLinesIntoTasks ─────────────────────────────────────────────────

describe('parseLinesIntoTasks', () => {
  it('parses bullet-point lines into tasks', () => {
    const tasks = parseLinesIntoTasks('- Do this\n- Do that');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('Do this');
    expect(tasks[1]!.title).toBe('Do that');
  });

  it('handles hash-prefixed lines', () => {
    const tasks = parseLinesIntoTasks('# Task A\n# Task B');
    expect(tasks).toHaveLength(2);
  });

  it('skips empty lines', () => {
    const tasks = parseLinesIntoTasks('- Task\n\n- Another');
    expect(tasks).toHaveLength(2);
  });

  it('assigns target column', () => {
    const tasks = parseLinesIntoTasks('- Something', 'in-progress');
    expect(tasks[0]!.columnId).toBe('in-progress');
  });

  it('defaults to medium priority', () => {
    const tasks = parseLinesIntoTasks('- Default priority');
    expect(tasks[0]!.priority).toBe('medium');
  });
});

// ── areDependenciesMet ─────────────────────────────────────────────────

describe('areDependenciesMet', () => {
  it('returns true when task has no dependencies', () => {
    const board = sampleBoard();
    expect(areDependenciesMet(board, 'task-1')).toBe(true);
  });

  it('returns true when all dependencies are completed', () => {
    const board = sampleBoard({
      tasks: [
        { ...sampleBoard().tasks[0]!, dependsOn: ['task-3'] },
        ...sampleBoard().tasks.slice(1),
      ],
    });
    expect(areDependenciesMet(board, 'task-1')).toBe(true);
  });

  it('returns false when dependencies are not completed', () => {
    const board = sampleBoard({
      tasks: [
        { ...sampleBoard().tasks[0]!, dependsOn: ['task-2'] },
        ...sampleBoard().tasks.slice(1),
      ],
    });
    expect(areDependenciesMet(board, 'task-1')).toBe(false);
  });
});

// ── findBlockedTasks ───────────────────────────────────────────────────

describe('findBlockedTasks', () => {
  it('returns empty array for unknown task', () => {
    const board = sampleBoard();
    expect(findBlockedTasks(board, 'nonexistent')).toEqual([]);
  });

  it('returns tasks that depend on the given task and are not completed', () => {
    const board = sampleBoard({
      tasks: [
        ...sampleBoard().tasks,
        {
          id: 'task-4',
          title: 'Blocked by one',
          columnId: 'backlog',
          order: 2,
          priority: 'medium',
          status: 'pending',
          dependsOn: ['task-1'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const blocked = findBlockedTasks(board, 'task-1');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.id).toBe('task-4');
  });

  it('does not return completed tasks that depend on the task', () => {
    const board = sampleBoard({
      tasks: [
        ...sampleBoard().tasks,
        {
          id: 'task-4',
          title: 'Already done',
          columnId: 'done',
          order: 0,
          priority: 'medium',
          status: 'completed',
          dependsOn: ['task-1'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
    });
    expect(findBlockedTasks(board, 'task-1')).toHaveLength(0);
  });
});

// ── exportBoardAsMarkdown ──────────────────────────────────────────────

describe('exportBoardAsMarkdown', () => {
  it('renders a board with title and columns', () => {
    const md = exportBoardAsMarkdown(sampleBoard());
    expect(md).toContain('# Test Board');
    expect(md).toContain('## Backlog');
    expect(md).toContain('## In Progress');
    expect(md).toContain('## Done');
  });

  it('renders tasks with checkboxes in their columns', () => {
    const md = exportBoardAsMarkdown(sampleBoard());
    expect(md).toContain('- [ ] Task one');
    expect(md).toContain('- [ ] Task two');
    expect(md).toContain('- [x] Task three');
  });

  it('includes description when present', () => {
    const md = exportBoardAsMarkdown(sampleBoard({ description: 'A test board' }));
    expect(md).toContain('A test board');
  });

  it('includes tags when present', () => {
    const md = exportBoardAsMarkdown(sampleBoard({ tags: ['frontend', 'urgent'] }));
    expect(md).toContain('#frontend');
    expect(md).toContain('#urgent');
  });

  it('shows _Empty_ for columns with no tasks', () => {
    const board = sampleBoard();
    board.columns.push({ id: 'review', title: 'Review', order: 3, wipLimit: 0 });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('_Empty_');
  });

  it('renders priority badge for non-medium priorities', () => {
    const md = exportBoardAsMarkdown(sampleBoard());
    expect(md).toContain('!high');
  });

  it('includes task description when present', () => {
    const board = sampleBoard({
      tasks: [
        {
          ...sampleBoard().tasks[0]!,
          description: 'This is task one description',
        },
        ...sampleBoard().tasks.slice(1),
      ],
    });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('This is task one description');
  });

  it('renders assignee when present', () => {
    const board = sampleBoard({
      tasks: [
        {
          ...sampleBoard().tasks[0]!,
          assignedAgent: 'agent-xyz',
        },
        ...sampleBoard().tasks.slice(1),
      ],
    });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('@agent-xyz');
  });

  it('renders success criteria checks', () => {
    const board = sampleBoard({
      tasks: [
        {
          ...sampleBoard().tasks[0]!,
          successCriteria: [
            { id: 'c1', description: 'Must compile', status: 'passed', type: 'manual' },
            { id: 'c2', description: 'Must pass tests', status: 'pending', type: 'test' },
          ],
        },
        ...sampleBoard().tasks.slice(1),
      ],
    });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('[x] Must compile');
    expect(md).toContain('[ ] Must pass tests');
  });

  it('renders provider info when assignment metadata is present', () => {
    const board = sampleBoard({
      tasks: [
        {
          ...sampleBoard().tasks[0]!,
          assignment: { status: 'running', provider: 'anthropic', model: 'opus' },
        },
        ...sampleBoard().tasks.slice(1),
      ],
    });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('anthropic');
    expect(md).toContain('opus');
  });
});

// ── buildTaskGraphFromKanbanBoard ──────────────────────────────────────

describe('buildTaskGraphFromKanbanBoard', () => {
  it('builds a task graph with nodes from non-archived tasks', () => {
    const board = sampleBoard();
    const { graph } = buildTaskGraphFromKanbanBoard(board);
    expect(graph.nodes.size).toBe(3);
    expect(graph.title).toBe(board.title);
  });

  it('excludes archived tasks by default', () => {
    const now = new Date().toISOString();
    const board = sampleBoard({
      tasks: [
        ...sampleBoard().tasks,
        {
          id: 'task-archived',
          title: 'Archived task',
          columnId: 'backlog',
          order: 3,
          priority: 'low',
          status: 'archived',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const { graph } = buildTaskGraphFromKanbanBoard(board);
    expect(graph.nodes.size).toBe(3); // archived excluded
  });

  it('includes archived tasks when asked', () => {
    const now = new Date().toISOString();
    const board = sampleBoard({
      tasks: [
        ...sampleBoard().tasks,
        {
          id: 'task-archived',
          title: 'Archived task',
          columnId: 'backlog',
          order: 3,
          priority: 'low',
          status: 'archived',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const { graph } = buildTaskGraphFromKanbanBoard(board, { includeArchived: true });
    expect(graph.nodes.size).toBe(4);
  });

  it('creates dependency edges from dependsOn', () => {
    const board = sampleBoard({
      tasks: [
        { ...sampleBoard().tasks[0]!, dependsOn: ['task-2'] },
        ...sampleBoard().tasks.slice(1),
      ],
    });
    const { graph } = buildTaskGraphFromKanbanBoard(board);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    const depEdges = graph.edges.filter((e) => e.type === 'depends_on');
    expect(depEdges.length).toBeGreaterThanOrEqual(1);
  });
});

// ── CRUD with real filesystem ──────────────────────────────────────────

describe('createBoard', () => {
  it('creates a board and returns it with an id and defaults', async () => {
    const board = await makeBoard();
    expect(board.id).toBeTruthy();
    expect(board.title).toBe('Test Board');
    expect(board.columns.length).toBeGreaterThanOrEqual(1);
    expect(board.version).toBe(CURRENT_KANBAN_VERSION);
    expect(board.revision).toBe(0);
  });

  it('creates a board with provided tasks', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Tasks Board',
      tasks: [{ title: 'Pre-defined task' }],
    });
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0]!.title).toBe('Pre-defined task');
  });
});

describe('getBoard', () => {
  it('returns null for unknown board', async () => {
    expect(await getBoard(tmpDir, 'nonexistent')).toBeNull();
  });

  it('returns a created board', async () => {
    const created = await makeBoard();
    const fetched = await getBoard(tmpDir, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Test Board');
  });
});

describe('listBoards', () => {
  it('returns empty list when no boards exist', async () => {
    const boards = await listBoards(tmpDir);
    expect(boards).toEqual([]);
  });

  it('lists created boards', async () => {
    await makeBoard({ title: 'Board A' });
    await makeBoard({ title: 'Board B' });
    const boards = await listBoards(tmpDir);
    expect(boards.length).toBeGreaterThanOrEqual(2);
  });
});

describe('updateBoard', () => {
  it('updates board title and description', async () => {
    const created = await makeBoard();
    const updated = await updateBoard(tmpDir, created.id, {
      title: 'Updated Title',
      description: 'Updated desc',
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Updated Title');
    expect(updated!.description).toBe('Updated desc');
  });

  it('returns null for unknown board', async () => {
    const result = await updateBoard(tmpDir, 'nonexistent', { title: 'Nope' });
    expect(result).toBeNull();
  });
});

describe('removeBoard', () => {
  it('returns false for unknown board', async () => {
    expect(await removeBoard(tmpDir, 'nonexistent')).toBe(false);
  });

  it('removes a board', async () => {
    const created = await makeBoard();
    expect(await removeBoard(tmpDir, created.id)).toBe(true);
    expect(await getBoard(tmpDir, created.id)).toBeNull();
  });
});

describe('addColumn', () => {
  it('throws — columns are locked to the 5 standard columns', async () => {
    const created = await makeBoard();
    await expect(addColumn(tmpDir, created.id, { title: 'New Column' })).rejects.toThrow(
      /Columns are locked/,
    );
  });
});

describe('updateColumn', () => {
  it('throws — column updates are not supported', async () => {
    const created = await makeBoard();
    const colId = created.columns[0]!.id;
    await expect(
      updateColumn(tmpDir, created.id, colId, { title: 'Renamed Column' }),
    ).rejects.toThrow(/Columns are locked/);
  });
});

describe('removeColumn', () => {
  it('throws — column removal is not supported', async () => {
    const board = await makeBoard();
    await expect(removeColumn(tmpDir, board.id, 'todo')).rejects.toThrow(/Columns are locked/);
  });
});

describe('addTask', () => {
  it('adds a task to a board', async () => {
    const board = await makeBoard();
    const result = await addTask(tmpDir, board.id, { title: 'New task' });
    expect(result).not.toBeNull();
    expect(result!.task.title).toBe('New task');
    expect(result!.task.priority).toBe('medium');
  });
});

describe('getTask', () => {
  it('returns null for unknown task', async () => {
    expect(await getTask(tmpDir, 'board-id', 'unknown-task')).toBeNull();
  });
});

describe('updateTask', () => {
  it('updates title, description, priority, and labels', async () => {
    const board = await makeBoard();
    const added = await addTask(tmpDir, board.id, { title: 'Original' });
    expect(added).not.toBeNull();
    const updatedBoard = await updateTask(tmpDir, board.id, added!.task.id, {
      title: 'Updated',
      description: 'New description',
      priority: 'high',
      labels: ['urgent', 'frontend'],
    });
    expect(updatedBoard).not.toBeNull();
    const task = updatedBoard!.tasks.find((t) => t.id === added!.task.id);
    expect(task?.title).toBe('Updated');
    expect(task?.description).toBe('New description');
    expect(task?.priority).toBe('high');
    expect(task?.labels).toEqual(['urgent', 'frontend']);
  });
});

describe('removeTask', () => {
  it('removes a task from a board', async () => {
    const board = await makeBoard();
    const added = await addTask(tmpDir, board.id, { title: 'Remove me' });
    expect(added).not.toBeNull();
    const result = await removeTask(tmpDir, board.id, added!.task.id);
    expect(result).not.toBeNull();
    expect(await getTask(tmpDir, board.id, added!.task.id)).toBeNull();
  });
});

describe('searchKanban', () => {
  it('returns empty for empty project', async () => {
    expect(await searchKanban(tmpDir)).toEqual([]);
  });

  it('finds tasks by title query', async () => {
    const board = await makeBoard();
    await addTask(tmpDir, board.id, { title: 'Fix login bug' });
    const results = await searchKanban(tmpDir, { query: 'login' });
    expect(results).toHaveLength(1);
    expect(results[0]!.task.title).toContain('login');
  });

  it('finds tasks by assignedAgent', async () => {
    const board = await makeBoard();
    await addTask(tmpDir, board.id, { title: 'Agent task', assignedAgent: 'bot-1' });
    const results = await searchKanban(tmpDir, { assignedAgent: 'bot-1' });
    expect(results).toHaveLength(1);
  });

  it('finds tasks by status', async () => {
    const board = await makeBoard();
    await addTask(tmpDir, board.id, { title: 'Do later' });
    const results = await searchKanban(tmpDir, { status: 'pending' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty when no tasks match', async () => {
    const board = await makeBoard();
    await addTask(tmpDir, board.id, { title: 'Hello world' });
    const results = await searchKanban(tmpDir, { query: 'nonexistent' });
    expect(results).toHaveLength(0);
  });
});

describe('listReadyTasks', () => {
  it('returns ready tasks and respects limit', async () => {
    const board = await makeBoard();
    await addTask(tmpDir, board.id, { title: 'Ready task' });
    const results = await listReadyTasks(tmpDir, { limit: 10 });
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('addDependency', () => {
  it('adds a dependency between tasks', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Dep test',
      tasks: [{ title: 'First' }, { title: 'Second' }],
    });
    const [first, second] = board.tasks;
    const result = await addDependency(tmpDir, board.id, first!.id, second!.id);
    expect(result).not.toBeNull();
    const updated = await getBoard(tmpDir, board.id);
    const firstTask = updated!.tasks.find((t) => t.id === first!.id);
    expect(firstTask?.dependsOn).toContain(second!.id);
  });
});

describe('setTaskChain', () => {
  it('sets a chain on tasks', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Chain test',
      tasks: [{ title: 'Step 1' }, { title: 'Step 2' }],
    });
    const ids = board.tasks.map((t) => t.id);
    await setTaskChain(tmpDir, board.id, {
      taskIds: ids,
      chainId: 'chain-1',
    });
    const updated = await getBoard(tmpDir, board.id);
    for (const task of updated!.tasks) {
      expect(task.chain?.chainId).toBe('chain-1');
    }
  });

  it('removes a task from a chain and normalizes the remaining links', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Editable chain',
      tasks: [{ title: 'Step 1' }, { title: 'Step 2' }, { title: 'Step 3' }],
    });
    const [first, middle, last] = board.tasks;
    await setTaskChain(tmpDir, board.id, {
      taskIds: board.tasks.map((task) => task.id),
      chainId: 'editable-chain',
    });

    const updated = await updateTask(tmpDir, board.id, middle!.id, { chain: null });

    expect(updated?.tasks.find((task) => task.id === middle!.id)?.chain).toBeUndefined();
    expect(updated?.tasks.find((task) => task.id === first!.id)?.chain?.nextTaskId).toBe(last!.id);
    expect(updated?.tasks.find((task) => task.id === last!.id)?.chain).toMatchObject({
      order: 1,
      previousTaskId: first!.id,
    });
  });
});

describe('splitTask', () => {
  it('splits a task into children', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Split test',
      tasks: [{ title: 'Parent task' }],
    });
    const parent = board.tasks[0]!;
    const result = await splitTask(tmpDir, board.id, parent.id, {
      titles: ['Child A', 'Child B'],
    });
    expect(result).not.toBeNull();
    const updated = await getBoard(tmpDir, board.id);
    expect(updated!.tasks.length).toBeGreaterThanOrEqual(3);
  });
});

// ── exportBoardToTaskGraph ─────────────────────────────────────────────

describe('exportBoardToTaskGraph', () => {
  it('returns null for unknown board', async () => {
    const result = await exportBoardToTaskGraph(tmpDir, 'nonexistent');
    expect(result).toBeNull();
  });

  it('exports a real board to a task graph', async () => {
    const board = await makeBoard();
    await addTask(tmpDir, board.id, { title: 'Export task' });
    const result = await exportBoardToTaskGraph(tmpDir, board.id);
    expect(result).not.toBeNull();
    expect(result!.graph.nodes.size).toBeGreaterThanOrEqual(1);
    expect(result!.board.id).toBe(board.id);
  });
});

// ── getKanbanQueueHealth ──────────────────────────────────────────────

describe('getKanbanQueueHealth', () => {
  it('returns health data for a project', async () => {
    await makeBoard();
    const health = await getKanbanQueueHealth(tmpDir);
    expect(health).toBeDefined();
    expect(Array.isArray(health.boardIds)).toBe(true);
    expect(health.counts).toBeDefined();
    expect(typeof health.counts.ready).toBe('number');
    // `startable` is what display surfaces are supposed to read; it went
    // unasserted here while four of them rendered the always-zero `ready`.
    expect(typeof health.counts.startable).toBe('number');
    expect(typeof health.counts.pending).toBe('number');
    expect(typeof health.dependencyBlocked.count).toBe('number');
    expect(typeof health.staleAssignments.count).toBe('number');
  });
});

// ── duplicateBoard ─────────────────────────────────────────────────

describe('duplicateBoard', () => {
  it('returns null for unknown board', async () => {
    expect(await duplicateBoard(tmpDir, 'nonexistent')).toBeNull();
  });

  it('duplicates a board with all tasks', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Original',
      description: 'Original description',
      tags: ['alpha'],
      tasks: [{ title: 'Task A' }, { title: 'Task B' }],
    });
    const dup = await duplicateBoard(tmpDir, board.id);
    expect(dup).not.toBeNull();
    expect(dup!.title).toBe('Original Copy');
    expect(dup!.description).toBe('Original description');
    expect(dup!.tags).toEqual(['alpha']);
    expect(dup!.tasks).toHaveLength(2);
    expect(dup!.id).not.toBe(board.id);
  });

  it('duplicates with custom title', async () => {
    const board = await makeBoard();
    const dup = await duplicateBoard(tmpDir, board.id, { title: 'Custom Copy' });
    expect(dup!.title).toBe('Custom Copy');
  });

  it('excludes tasks when includeTasks is false', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Src',
      tasks: [{ title: 'Lone task' }],
    });
    const dup = await duplicateBoard(tmpDir, board.id, { includeTasks: false });
    expect(dup!.tasks).toHaveLength(0);
  });
});

// ── moveTask ───────────────────────────────────────────────────────

describe('moveTask', () => {
  it('moves a task to a different column', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Movable', columnId: 'backlog' });
    const movedBoard = await moveTask(tmpDir, board.id, task!.task.id, 'in-progress');
    expect(movedBoard).not.toBeNull();
    const moved = movedBoard!.tasks.find((t) => t.id === task!.task.id);
    expect(moved?.columnId).toBe('in-progress');
  });
});

// ── mergeTasks ─────────────────────────────────────────────────────

describe('mergeTasks', () => {
  it('merges two tasks into one', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Merge test',
      tasks: [{ title: 'First' }, { title: 'Second' }],
    });
    const ids = board.tasks.map((t) => t.id);
    const result = await mergeTasks(tmpDir, board.id, {
      taskIds: ids,
      title: 'Merged result',
    });
    expect(result).not.toBeNull();
    expect(result!.task.title).toBe('Merged result');
    expect(result!.sourceTasks).toHaveLength(2);
    // Source tasks should be archived
    const updated = await getBoard(tmpDir, board.id);
    for (const src of result!.sourceTasks) {
      const found = updated!.tasks.find((t) => t.id === src.id);
      expect(found?.status).toBe('archived');
    }
    // Merged task should exist
    expect(updated!.tasks.find((t) => t.id === result!.task.id)).toBeDefined();
  });
});

// ── addCheckToTask / updateCheckOnTask ─────────────────────────────

describe('addCheckToTask', () => {
  it('adds a check to a task', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Checkable' });
    const updatedBoard = await addCheckToTask(tmpDir, board.id, task!.task.id, {
      description: 'Must pass lint',
      type: 'auto',
    });
    expect(updatedBoard).not.toBeNull();
    const found = updatedBoard!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.successCriteria).toHaveLength(1);
    expect(found!.successCriteria![0]!.description).toBe('Must pass lint');
  });

  it('returns null for unknown task', async () => {
    const board = await makeBoard();
    const result = await addCheckToTask(tmpDir, board.id, 'no-such-task', {
      description: 'x',
      type: 'manual',
    });
    expect(result).toBeNull();
  });
});

describe('updateCheckOnTask', () => {
  it('updates a check status and sets checkedAt', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Check me' });
    const withCheck = await addCheckToTask(tmpDir, board.id, task!.task.id, {
      description: 'Must pass',
      type: 'test',
    });
    const checkId = withCheck!.tasks.find((t) => t.id === task!.task.id)!.successCriteria![0]!.id;
    const updated = await updateCheckOnTask(tmpDir, board.id, task!.task.id, checkId, {
      status: 'passed',
    });
    expect(updated).not.toBeNull();
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    expect(found!.successCriteria![0]!.status).toBe('passed');
    expect(found!.successCriteria![0]!.checkedAt).toBeDefined();
  });
});

// ── addNoteToTask ──────────────────────────────────────────────────

describe('addNoteToTask', () => {
  it('adds a note to a task', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Notable' });
    const updatedBoard = await addNoteToTask(tmpDir, board.id, task!.task.id, {
      author: 'tester',
      content: 'This is a note',
    });
    expect(updatedBoard).not.toBeNull();
    const found = updatedBoard!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.notes).toHaveLength(1);
    expect(found!.notes![0]!.content).toBe('This is a note');
    expect(found!.notes![0]!.author).toBe('tester');
  });
});

// ── addLinkToTask ──────────────────────────────────────────────────

describe('addLinkToTask', () => {
  it('adds a link to a task', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Linkable' });
    const updatedBoard = await addLinkToTask(tmpDir, board.id, task!.task.id, {
      url: 'https://example.com',
      title: 'Example',
      type: 'url',
    });
    expect(updatedBoard).not.toBeNull();
    const found = updatedBoard!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.links).toHaveLength(1);
    expect(found!.links![0]!.url).toBe('https://example.com');
  });
});

// ── createBoardFromTaskGraph ───────────────────────────────────────

describe('createBoardFromTaskGraph', () => {
  it('creates a board from a task graph', async () => {
    const graph = {
      id: 'graph-1',
      specId: 'spec-1',
      title: 'Test Graph',
      nodes: new Map([
        [
          'node-1',
          {
            id: 'node-1',
            title: 'Task from graph',
            description: 'Created from task graph',
            type: 'feature' as const,
            priority: 'high' as const,
            status: 'pending' as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        [
          'node-2',
          {
            id: 'node-2',
            title: 'Second task',
            description: 'Dependent task',
            type: 'feature' as const,
            priority: 'medium' as const,
            status: 'completed' as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            completedAt: Date.now(),
          },
        ],
      ]),
      edges: [
        {
          id: 'edge-1',
          from: 'node-1',
          to: 'node-2',
          type: 'depends_on' as const,
        },
      ],
      rootNodes: ['node-1'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const result = await createBoardFromTaskGraph(tmpDir, graph);
    expect(result.board.title).toBe('Test Graph');
    expect(result.board.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.taskIdMap.size).toBeGreaterThanOrEqual(1);
  });

  it('excludes completed tasks when option is set', async () => {
    const graph = {
      id: 'graph-2',
      specId: 'spec-2',
      title: 'Filtered Graph',
      nodes: new Map([
        [
          'node-a',
          {
            id: 'node-a',
            title: 'Active task',
            description: '',
            type: 'feature' as const,
            priority: 'high' as const,
            status: 'pending' as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        [
          'node-b',
          {
            id: 'node-b',
            title: 'Done task',
            description: '',
            type: 'bugfix' as const,
            priority: 'medium' as const,
            status: 'completed' as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            completedAt: Date.now(),
          },
        ],
      ]),
      edges: [],
      rootNodes: ['node-a'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const result = await createBoardFromTaskGraph(tmpDir, graph, {
      includeCompletedTasks: false,
    });
    expect(result.board.tasks).toHaveLength(1);
    expect(result.board.tasks[0]!.title).toBe('Active task');
  });

  it('refuses bulk task-graph synchronization on managed boards', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Managed graph board',
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    const now = Date.now();
    const graph = {
      id: 'managed-sync',
      specId: 'managed-sync-spec',
      title: 'Managed Sync',
      nodes: new Map([
        [
          'node-1',
          {
            id: 'node-1',
            title: 'Must not bypass lifecycle',
            description: '',
            type: 'feature' as const,
            priority: 'high' as const,
            status: 'completed' as const,
            createdAt: now,
            updatedAt: now,
            completedAt: now,
          },
        ],
      ]),
      edges: [],
      rootNodes: ['node-1'],
      createdAt: now,
      updatedAt: now,
    };
    await expect(syncBoardFromTaskGraph(tmpDir, board.id, graph)).rejects.toThrow(
      'cannot overwrite a managed Kanban Agent board',
    );
    expect((await getBoard(tmpDir, board.id))?.tasks).toHaveLength(0);
  });
});

// ── assignTask ─────────────────────────────────────────────────────

describe('assignTask', () => {
  it('assigns a task with agent metadata', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'To assign' });
    const updated = await assignTask(tmpDir, board.id, task!.task.id, {
      agentId: 'agent-01',
      name: 'Worker One',
      role: 'executor',
      provider: 'anthropic',
      model: 'opus',
      maxAttempts: 3,
    });
    expect(updated).not.toBeNull();
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.assignedAgent).toBe('agent-01');
    expect(found?.assignment?.provider).toBe('anthropic');
    expect(found?.assignment?.model).toBe('opus');
    expect(found?.assignment?.maxAttempts).toBe(3);
  });

  it('returns null for unknown task', async () => {
    const board = await makeBoard();
    expect(await assignTask(tmpDir, board.id, 'no-such-task', { agentId: 'x' })).toBeNull();
  });
});

// ── updateTaskAssignment ───────────────────────────────────────────

describe('updateTaskAssignment', () => {
  it('parks a completed worker in review until the completion gate finalizes', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Run and done' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const updated = await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'completed',
    });
    expect(updated).not.toBeNull();
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    // Default (soft) gate: worker completion is a claim, not a final state.
    expect(found?.status).toBe('review');
    expect(found?.assignment?.status).toBe('completed');
    expect(found?.completedAt).toBeUndefined();

    const finalized = await finalizeTaskCompletion(tmpDir, board.id, task!.task.id);
    expect(finalized?.task.status).toBe('completed');
    expect(finalized?.task.completedAt).toBeDefined();
    expect(finalized?.gate.enforcement).toBe('soft');
  });

  it('completes directly when the board gate is off', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Ungated',
      completionGate: { enforcement: 'off' },
    });
    const task = await addTask(tmpDir, board.id, { title: 'Run and done' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const updated = await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'completed',
    });
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.status).toBe('completed');
    expect(found?.completedAt).toBeDefined();
  });

  it('marks a task as failed', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Will fail' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const updated = await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'failed',
      error: 'Tool call limit exceeded',
    });
    expect(updated).not.toBeNull();
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.status).toBe('failed');
    expect(found?.assignment?.error).toBe('Tool call limit exceeded');
  });

  it('queues an assigned task back to ready', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Re-queue me' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, { status: 'completed' });
    const updated = await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'queued',
    });
    expect(updated).not.toBeNull();
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.status).toBe('ready');
    expect(found?.assignment?.status).toBe('queued');
  });
});

describe('reconcileKanbanBoard', () => {
  it('moves source tasks to the column matching their status even without an assignment', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Drifted todo' });
    const drifted = await updateTask(tmpDir, board.id, task!.task.id, {
      status: 'in_progress',
      columnId: 'backlog',
    });
    expect(drifted?.tasks.find((item) => item.id === task!.task.id)?.columnId).toBe('backlog');

    const result = await reconcileKanbanBoard(tmpDir, board.id);

    expect(result?.tasks).toHaveLength(1);
    expect(result?.board.tasks.find((item) => item.id === task!.task.id)?.columnId).toBe(
      'in-progress',
    );
  });

  it('holds completed workers in review until every completion check passes', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Verify me' });
    await addCheckToTask(tmpDir, board.id, task!.task.id, {
      description: 'Tests pass',
      type: 'test',
    });
    await assignTask(tmpDir, board.id, task!.task.id, {
      agentId: 'worker',
      modelRouting: 'session',
      skills: ['testing'],
    });
    // The completion gate already parks the worker's "completed" in review.
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, { status: 'completed' });
    const parkedBoard = await getBoard(tmpDir, board.id);
    expect(parkedBoard?.tasks.find((item) => item.id === task!.task.id)?.status).toBe('review');

    const checkId = parkedBoard?.tasks.find((item) => item.id === task!.task.id)
      ?.successCriteria?.[0]?.id;
    await updateCheckOnTask(tmpDir, board.id, task!.task.id, checkId!, { status: 'passed' });
    const completed = await reconcileKanbanBoard(tmpDir, board.id);
    const finalTask = completed?.board.tasks.find((item) => item.id === task!.task.id);
    expect(finalTask?.status).toBe('completed');
    expect(finalTask?.columnId).toBe('done');
    expect(finalTask?.assignment?.skills).toEqual(['testing']);
  });

  it('strict boards do not reconcile past review without a passed verification report', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Strict board',
      completionGate: { enforcement: 'strict' },
    });
    const task = await addTask(tmpDir, board.id, { title: 'Needs verified proof' });
    await addCheckToTask(tmpDir, board.id, task!.task.id, {
      description: 'Manually confirmed',
      type: 'manual',
      status: 'passed',
    });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'worker' });
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, { status: 'completed' });

    // All check flags passed, but a strict board still requires the gate.
    const reconciled = await reconcileKanbanBoard(tmpDir, board.id);
    const parked =
      reconciled?.board.tasks.find((item) => item.id === task!.task.id) ??
      (await getBoard(tmpDir, board.id))?.tasks.find((item) => item.id === task!.task.id);
    expect(parked?.status).toBe('review');
  });
});

// ── heartbeatTaskAssignment ────────────────────────────────────────

describe('heartbeatTaskAssignment', () => {
  it('updates heartbeat timestamp', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Heartbeat' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const hb = '2026-07-11T12:00:00.000Z';
    const updated = await heartbeatTaskAssignment(tmpDir, board.id, task!.task.id, {
      heartbeatAt: hb,
      leaseExpiresAt: '2026-07-11T12:05:00.000Z',
    });
    expect(updated).not.toBeNull();
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.assignment?.heartbeatAt).toBe(hb);
    expect(found?.assignment?.leaseExpiresAt).toBe('2026-07-11T12:05:00.000Z');
  });

  it('returns null when task has no assignment', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Not assigned' });
    expect(await heartbeatTaskAssignment(tmpDir, board.id, task!.task.id, {})).toBeNull();
  });
});

// ── claimReadyTask ─────────────────────────────────────────────────

describe('claimReadyTask', () => {
  it('claims a ready task on a specific board', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Claim test',
      tasks: [{ title: 'Claimable' }],
    });
    const result = await claimReadyTask(tmpDir, { boardId: board.id, agentId: 'worker-1' });
    expect(result).not.toBeNull();
    expect(result!.task.assignment?.agentId).toBe('worker-1');
    expect(result!.task.status).toBe('ready');
  });

  it('preserves explicit model routing and skills when a configured task is claimed', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Configured claim',
      tasks: [{ title: 'Use configured worker', status: 'ready' }],
    });
    await assignTask(tmpDir, board.id, board.tasks[0]!.id, {
      modelRouting: 'fallback_profile',
      fallbackProfile: 'careful',
      skills: ['testing', 'code-review'],
    });

    const result = await claimReadyTask(tmpDir, { boardId: board.id, agentId: 'worker-1' });

    expect(result?.task.assignment).toMatchObject({
      agentId: 'worker-1',
      modelRouting: 'fallback_profile',
      fallbackProfile: 'careful',
      skills: ['testing', 'code-review'],
    });
  });

  it('returns null when no ready tasks', async () => {
    const board = await createBoard(tmpDir, {
      title: 'Empty board',
    });
    expect(await claimReadyTask(tmpDir, { boardId: board.id, agentId: 'x' })).toBeNull();
  });

  it('claims across all boards when no boardId specified', async () => {
    await createBoard(tmpDir, { title: 'B1', tasks: [{ title: 'Pick me' }] });
    const result = await claimReadyTask(tmpDir, { agentId: 'finder' });
    expect(result).not.toBeNull();
    expect(result!.task.assignment?.agentId).toBe('finder');
  });

  it('continues to the next board when a stale write occurs on one board', async () => {
    await createBoard(tmpDir, {
      title: 'Stale board',
      tasks: [{ title: 'Task A' }],
    });
    await createBoard(tmpDir, {
      title: 'Good board',
      tasks: [{ title: 'Task B' }],
    });

    const originalFn = internalModule.claimReadyTaskOnBoard;
    const spy = vi.spyOn(internalModule, 'claimReadyTaskOnBoard');
    let callIndex = 0;
    spy.mockImplementation(
      async (projectRoot: string, boardId: string, input: ClaimKanbanTaskInput) => {
        callIndex++;
        if (callIndex <= 1) {
          throw new StaleWriteError('Stale write detected');
        }
        return originalFn(projectRoot, boardId, input);
      },
    );

    try {
      const result = await claimReadyTask(tmpDir, { agentId: 'worker' });
      expect(result).not.toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(result!.task.assignment?.agentId).toBe('worker');
      // The spy was called twice: first throw StaleWriteError (skips one
      // board), second succeeds (claims from the other board). This
      // confirms the stale-write continuation path was exercised, not
      // silently bypassed.
    } finally {
      spy.mockRestore();
    }
  });
});

// ── releaseTaskClaim ──────────────────────────────────────────────

describe('releaseTaskClaim', () => {
  it('releases a claimed task', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Release me' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const released = await releaseTaskClaim(tmpDir, board.id, task!.task.id);
    expect(released).not.toBeNull();
    const found = released!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.assignment).toBeUndefined();
    expect(found?.status).toBe('ready');
  });

  it('releases with reason note', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Release with note' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    await releaseTaskClaim(tmpDir, board.id, task!.task.id, {
      reason: 'Worker timed out',
      status: 'pending',
    });
    // Verify note was added (re-read to be safe)
    const updated = await getBoard(tmpDir, board.id);
    const found = updated!.tasks.find((t) => t.id === task!.task.id);
    expect(found?.assignment).toBeUndefined();
    expect(found?.status).toBe('pending');
    expect(found?.notes?.some((n) => n.content.includes('Worker timed out'))).toBe(true);
  });
});

// ── recoverStaleTaskAssignments ────────────────────────────────────

describe('recoverStaleTaskAssignments', () => {
  it('recovers expired assignments in retry mode', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Stale task' });
    await assignTask(tmpDir, board.id, task!.task.id, {
      agentId: 'bot',
      maxAttempts: 3,
    });
    // Set a past lease so it appears stale
    const past = '2020-01-01T00:00:00.000Z';
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'queued',
      leaseExpiresAt: past,
      attempt: 0,
    });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
    });
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0]!.assignment?.status).toBe('assigned');
    expect(result!.tasks[0]!.assignment?.attempt).toBe(1);
  });

  it('recovers expired assignments in release mode', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Release stale' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const past = '2020-01-01T00:00:00.000Z';
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'queued',
      leaseExpiresAt: past,
    });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'release',
    });
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0]!.assignment).toBeUndefined();
  });

  it('recovers expired assignments in fail mode', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Fail stale' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const past = '2020-01-01T00:00:00.000Z';
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'queued',
      leaseExpiresAt: past,
    });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'fail',
    });
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0]!.assignment?.status).toBe('failed');
    expect(result!.tasks[0]!.status).toBe('failed');
  });

  it('skips tasks with non-expired leases', async () => {
    const board = await makeBoard();
    const task = await addTask(tmpDir, board.id, { title: 'Fresh task' });
    await assignTask(tmpDir, board.id, task!.task.id, { agentId: 'bot' });
    const future = '2099-01-01T00:00:00.000Z';
    await updateTaskAssignment(tmpDir, board.id, task!.task.id, {
      status: 'queued',
      leaseExpiresAt: future,
    });
    const result = await recoverStaleTaskAssignments(tmpDir, board.id, {
      mode: 'retry',
    });
    // No tasks recovered — lease still valid
    expect(result).toBeNull();
  });
});
