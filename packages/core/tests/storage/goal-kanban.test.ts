/**
 * Tests for goal-kanban — goal-to-kanban bridge.
 * Covers: board creation/lookup/deletion, format functions,
 * parseAutonomyChoice, and edge cases.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock handles double as the BoardStorePort wiring (production code no
// longer imports the mocked surface; the vi.fn()s are shared handles).
const mockCreateBoard = vi.fn();
const mockGetBoard = vi.fn();
const mockListBoards = vi.fn();
const mockRemoveBoard = vi.fn();
const mockAddTask = vi.fn();

vi.mock('@wrongstack/kanban', () => ({
  createBoard: (...args: unknown[]) => mockCreateBoard(...args),
  getBoard: (...args: unknown[]) => mockGetBoard(...args),
  listBoards: (...args: unknown[]) => mockListBoards(...args),
  removeBoard: (...args: unknown[]) => mockRemoveBoard(...args),
  addTask: (...args: unknown[]) => mockAddTask(...args),
}));

import { setBoardStorePort } from '../../src/storage/board-store-port.js';

import {
  createGoalKanbanBoard,
  deleteGoalKanbanBoard,
  findGoalBoardByTag,
  findGoalKanbanBoard,
  formatGoalAutonomyChoice,
  formatGoalEvent,
  formatGoalKanbanPreview,
  parseAutonomyChoice,
} from '../../src/storage/goal-kanban.js';
import type { GoalFile } from '../../src/storage/goal-store.js';

function makeGoal(overrides: Partial<GoalFile> = {}): GoalFile {
  return {
    version: 1,
    goal: 'Build a REST API',
    setAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    iterations: 0,
    engineState: 'idle',
    goalState: 'active',
    todoAttempts: {},
    journal: [],
    deliverables: ['Design schema', 'Implement endpoints', 'Write tests'],
    ...overrides,
  } as GoalFile;
}

beforeEach(() => {
  vi.clearAllMocks();
  // goal-kanban resolves kanban through the BoardStorePort (roadmap #11);
  // tests wire the port to the same mocks the CLI composition root would
  // wire to the real package.
  setBoardStorePort({
    createBoard: (...args: unknown[]) =>
      mockCreateBoard(...(args as Parameters<typeof mockCreateBoard>)),
    listBoards: (...args: unknown[]) =>
      mockListBoards(...(args as Parameters<typeof mockListBoards>)),
    getBoard: (...args: unknown[]) => mockGetBoard(...(args as Parameters<typeof mockGetBoard>)),
    removeBoard: (...args: unknown[]) =>
      mockRemoveBoard(...(args as Parameters<typeof mockRemoveBoard>)),
    addTask: (...args: unknown[]) => mockAddTask(...(args as Parameters<typeof mockAddTask>)),
    updateTask: (() => {
      throw new Error('updateTask not expected in goal-kanban tests');
    }) as never,
  });
  mockCreateBoard.mockResolvedValue({
    id: 'board-123',
    columns: [{ id: 'backlog' }, { id: 'todo' }, { id: 'done' }],
  });
  mockGetBoard.mockResolvedValue({ id: 'board-123', title: 'Test Board' });
  mockListBoards.mockResolvedValue([]);
  mockRemoveBoard.mockResolvedValue(true);
  mockAddTask.mockResolvedValue({ task: { id: 'task-1' } });
});

describe('createGoalKanbanBoard', () => {
  it('creates a board with deliverables as tasks', async () => {
    const goal = makeGoal();
    const boardId = await createGoalKanbanBoard(
      '/project',
      goal,
      '2026-08-26/sess_01TESTGOALKANBAN00000000',
    );
    expect(boardId).toBe('board-123');
    expect(mockCreateBoard).toHaveBeenCalledTimes(1);
    expect(mockAddTask).toHaveBeenCalledTimes(3); // 3 deliverables
  });

  it('returns null when projectRoot is empty', async () => {
    const result = await createGoalKanbanBoard(
      '',
      makeGoal(),
      '2026-08-26/sess_01TESTGOALKANBAN00000000',
    );
    expect(result).toBeNull();
    expect(mockCreateBoard).not.toHaveBeenCalled();
  });

  it('reuses existing board when kanbanBoardId is set and board exists', async () => {
    const goal = { ...makeGoal(), kanbanBoardId: 'existing-board' } as never;
    const result = await createGoalKanbanBoard(
      '/project',
      goal,
      '2026-08-26/sess_01TESTGOALKANBAN00000000',
    );
    expect(result).toBe('existing-board');
    expect(mockCreateBoard).not.toHaveBeenCalled();
  });

  it('creates a new board when existing board is not found', async () => {
    mockGetBoard.mockRejectedValueOnce(new Error('not found'));
    const goal = { ...makeGoal(), kanbanBoardId: 'dead-board' } as never;
    const result = await createGoalKanbanBoard(
      '/project',
      goal,
      '2026-08-26/sess_01TESTGOALKANBAN00000000',
    );
    expect(result).toBe('board-123');
    expect(mockCreateBoard).toHaveBeenCalledTimes(1);
  });

  it('handles goal with no deliverables', async () => {
    const goal = makeGoal({ deliverables: [] });
    const boardId = await createGoalKanbanBoard(
      '/project',
      goal,
      '2026-08-26/sess_01TESTGOALKANBAN00000000',
    );
    expect(boardId).toBe('board-123');
    expect(mockAddTask).not.toHaveBeenCalled();
  });

  it('truncates long goal titles', async () => {
    const goal = makeGoal({ goal: 'A'.repeat(200) });
    await createGoalKanbanBoard('/project', goal, '2026-08-26/sess_01TESTGOALKANBAN00000000');
    const callArgs = mockCreateBoard.mock.calls[0]?.[1] as { title: string };
    expect(callArgs.title.length).toBeLessThan(100);
  });
});

describe('findGoalKanbanBoard', () => {
  it('returns the board when found', async () => {
    const result = await findGoalKanbanBoard('/project', 'board-123');
    expect(result).toEqual({ id: 'board-123', title: 'Test Board' });
  });

  it('returns null when board is missing', async () => {
    mockGetBoard.mockRejectedValueOnce(new Error('not found'));
    const result = await findGoalKanbanBoard('/project', 'dead-board');
    expect(result).toBeNull();
  });

  it('returns null for empty inputs', async () => {
    expect(await findGoalKanbanBoard('', 'board')).toBeNull();
    expect(await findGoalKanbanBoard('/project', '')).toBeNull();
  });
});

describe('deleteGoalKanbanBoard', () => {
  it('removes the board', async () => {
    await deleteGoalKanbanBoard('/project', 'board-123');
    expect(mockRemoveBoard).toHaveBeenCalledWith('/project', 'board-123');
  });

  it('is a no-op for empty inputs', async () => {
    await deleteGoalKanbanBoard('', 'board');
    await deleteGoalKanbanBoard('/project', '');
    expect(mockRemoveBoard).not.toHaveBeenCalled();
  });

  it('swallows removal errors', async () => {
    mockRemoveBoard.mockRejectedValueOnce(new Error('permission denied'));
    await expect(deleteGoalKanbanBoard('/project', 'board')).resolves.toBeUndefined();
  });
});

describe('findGoalBoardByTag', () => {
  it('finds a board by goal tag', async () => {
    mockListBoards.mockResolvedValueOnce([{ id: 'board-abc', tags: ['goal:build-a-rest-api'] }]);
    const result = await findGoalBoardByTag('/project', makeGoal());
    expect(result).toBeDefined();
  });

  it('returns null when no matching board', async () => {
    mockListBoards.mockResolvedValueOnce([{ id: 'board-xyz', tags: ['other-tag'] }]);
    const result = await findGoalBoardByTag('/project', makeGoal());
    expect(result).toBeNull();
  });

  it('returns null for empty projectRoot', async () => {
    expect(await findGoalBoardByTag('', makeGoal())).toBeNull();
  });
});

describe('formatGoalKanbanPreview', () => {
  it('renders deliverables in columns', () => {
    const output = formatGoalKanbanPreview(makeGoal(), 'board-123', 3);
    expect(output).toContain('GOAL KANBAN');
    expect(output).toContain('Build a REST API');
    expect(output).toContain('Backlog');
    expect(output).toContain('Design schema');
  });

  it('shows done deliverables in Done column', () => {
    const goal = makeGoal({
      deliverables: ['✅ Design schema', 'Implement endpoints'],
    });
    const output = formatGoalKanbanPreview(goal);
    expect(output).toContain('Done');
    expect(output).toContain('1/2 deliverables complete');
  });

  it('shows progress bar when progress is set', () => {
    const goal = makeGoal({ progress: 60, progressNote: 'Making progress' }) as GoalFile;
    const output = formatGoalKanbanPreview(goal);
    expect(output).toContain('60%');
    expect(output).toContain('Making progress');
  });

  it('handles empty deliverables', () => {
    const goal = makeGoal({ deliverables: [] });
    const output = formatGoalKanbanPreview(goal);
    expect(output).toContain('GOAL KANBAN');
  });
});

describe('formatGoalEvent', () => {
  it('renders the goal event banner', () => {
    const output = formatGoalEvent(makeGoal(), 'board-123');
    expect(output).toContain('Goal Event');
    expect(output).toContain('Mission locked');
    expect(output).toContain('3 deliverables');
  });

  it('shows board id when provided', () => {
    const output = formatGoalEvent(makeGoal(), 'board-123');
    expect(output).toContain('board-123');
  });

  it('omits board line when no board', () => {
    const output = formatGoalEvent(makeGoal());
    expect(output).not.toContain('Kanban board created');
  });
});

describe('formatGoalAutonomyChoice', () => {
  it('renders both autonomy modes', () => {
    const output = formatGoalAutonomyChoice();
    expect(output).toContain('Autonomy Eternal');
    expect(output).toContain('Eternal Parallel');
    expect(output).toContain('Enter 1 or 2');
  });
});

describe('parseAutonomyChoice', () => {
  it('parses "1" as eternal', () => {
    expect(parseAutonomyChoice('1')).toBe('eternal');
  });

  it('parses "eternal" as eternal', () => {
    expect(parseAutonomyChoice('eternal')).toBe('eternal');
  });

  it('parses "e" as eternal', () => {
    expect(parseAutonomyChoice('e')).toBe('eternal');
  });

  it('parses "2" as eternal-parallel', () => {
    expect(parseAutonomyChoice('2')).toBe('eternal-parallel');
  });

  it('parses "parallel" as eternal-parallel', () => {
    expect(parseAutonomyChoice('parallel')).toBe('eternal-parallel');
  });

  it('parses "p" as eternal-parallel', () => {
    expect(parseAutonomyChoice('p')).toBe('eternal-parallel');
  });

  it('parses empty/skip/0 as null', () => {
    expect(parseAutonomyChoice('')).toBeNull();
    expect(parseAutonomyChoice('skip')).toBeNull();
    expect(parseAutonomyChoice('s')).toBeNull();
    expect(parseAutonomyChoice('0')).toBeNull();
  });

  it('returns null for unrecognized input', () => {
    expect(parseAutonomyChoice('banana')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(parseAutonomyChoice('ETERNAL')).toBe('eternal');
    expect(parseAutonomyChoice('Parallel')).toBe('eternal-parallel');
  });
});
