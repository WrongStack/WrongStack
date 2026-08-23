import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @wrongstack/kanban
const mockListBoards = vi.hoisted(() => vi.fn(async (): Promise<any[]> => []));
const mockCreateBoard = vi.hoisted(() =>
  vi.fn(async () => ({
    id: 'b1',
    title: 'Test',
    columns: [{ id: 'col1', name: 'Backlog' }],
    tasks: [],
    updatedAt: new Date().toISOString(),
    taskCount: 0,
    completedTaskCount: 0,
  })),
);
const mockGetBoard = vi.hoisted(() => vi.fn(async (): Promise<any> => null));
const mockRemoveBoard = vi.hoisted(() => vi.fn(async () => true));
const mockDuplicateBoard = vi.hoisted(() => vi.fn(async (): Promise<any> => null));
const mockUpdateBoard = vi.hoisted(() => vi.fn(async (): Promise<any> => null));
const mockCreateBoardFromText = vi.hoisted(() =>
  vi.fn(() => ({ title: 'Generated', columns: [{ id: 'backlog', name: 'Backlog' }] })),
);
const mockParseLinesIntoTasks = vi.hoisted(() => vi.fn(() => []));
const mockGetKanbanSnapshot = vi.hoisted(() => vi.fn(async () => ({})));
const mockExportBoardAsMarkdown = vi.hoisted(() => vi.fn(() => '# Board'));
const mockAddTask = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@wrongstack/kanban', () => ({
  DEFAULT_COLUMNS: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'done', name: 'Done' },
  ],
  listBoards: mockListBoards,
  createBoard: mockCreateBoard,
  getBoard: mockGetBoard,
  removeBoard: mockRemoveBoard,
  duplicateBoard: mockDuplicateBoard,
  updateBoard: vi.fn(async () => ({ id: 'b1', title: 'New Name' })),
  updateBoardManager: mockUpdateBoard,
  createBoardFromText: mockCreateBoardFromText,
  parseLinesIntoTasks: mockParseLinesIntoTasks,
  getKanbanOrchestrationSnapshot: mockGetKanbanSnapshot,
  exportBoardAsMarkdown: mockExportBoardAsMarkdown,
  addTask: mockAddTask,
  addColumn: vi.fn(async () => undefined),
  removeColumn: vi.fn(async () => undefined),
  addDependency: vi.fn(async () => undefined),
  addCheckToTask: vi.fn(async () => undefined),
  addNoteToTask: vi.fn(async () => undefined),
  addGoalMetricToTask: vi.fn(async () => undefined),
  assignTask: vi.fn(async () => undefined),
  claimReadyTask: vi.fn(async () => undefined),
  copyTaskToBoard: vi.fn(async () => undefined),
  createBoardFromTaskGraph: vi.fn(async () => null),
  exportBoardToTaskGraph: vi.fn(() => ({})),
  getTask: vi.fn(async () => null),
  getTaskChain: vi.fn(async () => null),
  listReadyTasks: vi.fn(async () => []),
  mergeTasks: vi.fn(async () => undefined),
  moveTask: vi.fn(async () => undefined),
  releaseTaskClaim: vi.fn(async () => undefined),
  setTaskChain: vi.fn(async () => undefined),
  splitTask: vi.fn(async () => undefined),
  syncBoardFromTaskGraph: vi.fn(async () => undefined),
  transferTaskToBoard: vi.fn(async () => undefined),
  updateTask: vi.fn(async () => undefined),
  updateTaskAssignment: vi.fn(async () => undefined),
  updateGoalMetricOnTask: vi.fn(async () => undefined),
  removeTask: vi.fn(async () => undefined),
  getKanbanBoardById: vi.fn(async () => null),
}));

vi.mock('@wrongstack/sdd', () => ({ TaskGraphStore: vi.fn() }));

vi.mock('../src/slash-commands/kanban-format.js', () => ({
  HEADING: (s: string) => s,
  LABEL: (s: string) => s,
  DIM: (s: string) => s,
  fmtAge: (s: string) => s,
  formatBoardList: vi.fn(() => 'BOARD LIST'),
  formatBoardDetail: vi.fn(() => 'BOARD DETAIL'),
  formatDependencyChain: vi.fn(() => 'DEPS'),
  formatKanbanSnapshot: vi.fn(() => 'SNAPSHOT'),
  formatReadyTasks: vi.fn(() => 'READY'),
  formatTaskChain: vi.fn(() => 'CHAIN'),
  formatTaskDetail: vi.fn(() => 'TASK DETAIL'),
}));

vi.mock('../src/slash-commands/kanban-agent-helpers.js', () => ({
  buildKanbanAgentPrompt: vi.fn(() => ''),
  parseKanbanAgentFlags: vi.fn(() => ({})),
  splitCsv: vi.fn((s: string) => s.split(',')),
}));

vi.mock('../src/slash-commands/kanban-help.js', () => ({ KANBAN_COMMAND_HELP: 'KANBAN HELP' }));

vi.mock('../src/slash-commands/kanban-graph.js', () => ({
  handleGraphSubcommand: vi.fn(async () => ({ message: 'GRAPH' })),
}));
vi.mock('../src/slash-commands/kanban-task.js', () => ({
  handleTaskSubcommand: vi.fn(async () => ({ message: 'TASK' })),
}));
vi.mock('../src/slash-commands/kanban-column.js', () => ({
  handleColumnSubcommand: vi.fn(async () => ({ message: 'COLUMN' })),
}));

import type { SlashCommandContext } from '../src/slash-commands/command-context.js';
import { buildKanbanCommand } from '../src/slash-commands/kanban.js';

/** Narrow the slash-command execute/run union (which includes `void`) to its message. */
function runMessage(result: unknown): string | undefined {
  return (result as { message?: string } | undefined)?.message;
}

function makeCtx(): SlashCommandContext {
  return {
    projectRoot: '/tmp/proj',
    onPanelOpen: { current: undefined },
  } as any;
}

describe('kanban slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListBoards.mockResolvedValue([]);
  });

  it('returns error when projectRoot is missing', async () => {
    const cmd = buildKanbanCommand({ projectRoot: undefined } as any);
    const result = await cmd.run('');
    expect(runMessage(result)).toContain('No project root');
  });

  it('lists boards when no subcommand', async () => {
    mockListBoards.mockResolvedValue([
      { id: 'b1', title: 'Board 1', tasks: [], updatedAt: '', taskCount: 0, completedTaskCount: 0 },
    ]);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('');
    expect(runMessage(result)).toBeTruthy();
  });

  it('creates a board with title', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('create My Board');
    expect(runMessage(result)).toContain('created');
  });

  it('returns error when create has no title', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('create');
    expect(runMessage(result)).toContain('Usage');
  });

  it('duplicates a board', async () => {
    mockDuplicateBoard.mockResolvedValue({ id: 'b2', title: 'Copy' });
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('duplicate b1 New Title');
    expect(runMessage(result)).toContain('duplicated');
  });

  it('returns error when duplicate has no boardId', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('duplicate');
    expect(runMessage(result)).toContain('Usage');
  });

  it('returns error when board not found for duplicate', async () => {
    mockDuplicateBoard.mockResolvedValue(null);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('duplicate missing');
    expect(runMessage(result)).toContain('not found');
  });

  it('shows board detail', async () => {
    mockGetBoard.mockResolvedValue({ id: 'b1', title: 'Board 1', columns: [], tasks: [] });
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('show b1');
    expect(runMessage(result)).toBeTruthy();
  });

  it('returns help when show has no boardId', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('show');
    expect(runMessage(result)).toBeTruthy();
  });

  it('returns error when board not found for show', async () => {
    mockGetBoard.mockResolvedValue(null);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('show missing');
    expect(runMessage(result)).toContain('not found');
  });

  it('deletes a board', async () => {
    mockRemoveBoard.mockResolvedValue(true);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('delete b1');
    expect(runMessage(result)).toContain('deleted');
  });

  it('returns error when delete fails', async () => {
    mockRemoveBoard.mockResolvedValue(false);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('delete b1');
    expect(runMessage(result)).toContain('not found');
  });

  it('returns error when delete has no boardId', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('delete');
    expect(runMessage(result)).toContain('Usage');
  });

  it('renames a board', async () => {
    mockUpdateBoard.mockResolvedValue({ id: 'b1', title: 'New Name' });
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('rename b1 New Name');
    expect(runMessage(result)).toContain('renamed');
  });

  it('returns error when rename has insufficient args', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('rename b1');
    expect(runMessage(result)).toContain('Usage');
  });

  it('returns error when rename board not found', async () => {
    // Reset the updateBoard mock to return null for this test
    const kanban = await import('@wrongstack/kanban');
    vi.mocked(kanban.updateBoard).mockResolvedValue(null as any);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('rename b1 New Name');
    expect(runMessage(result)).toContain('not found');
  });

  it('generates a board from text', async () => {
    mockParseLinesIntoTasks.mockReturnValue([]);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('generate Build a REST API');
    expect(runMessage(result)).toContain('generated');
  });

  it('returns error when generate has no description', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('generate');
    expect(runMessage(result)).toContain('Usage');
  });

  it('shows snapshot', async () => {
    mockGetKanbanSnapshot.mockResolvedValue({});
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('snapshot');
    expect(runMessage(result)).toBeTruthy();
  });

  it('exports a board as markdown', async () => {
    mockGetBoard.mockResolvedValue({ id: 'b1', title: 'B1', columns: [], tasks: [] });
    mockExportBoardAsMarkdown.mockReturnValue('# Board');
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('export b1');
    expect(runMessage(result)).toBeTruthy();
  });

  it('returns error when export has no boardId', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('export');
    expect(runMessage(result)).toContain('Usage');
  });

  it('returns error when export board not found', async () => {
    mockGetBoard.mockResolvedValue(null);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('export missing');
    expect(runMessage(result)).toContain('not found');
  });

  it('shows dependency chain', async () => {
    mockGetBoard.mockResolvedValue({
      id: 'b1',
      title: 'B1',
      columns: [],
      tasks: [{ id: 't1', title: 'T1', dependencies: [] }],
    });
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('deps b1 t1');
    expect(runMessage(result)).toBeTruthy();
  });

  it('returns error when deps has insufficient args', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('deps b1');
    expect(runMessage(result)).toContain('Usage');
  });

  it('returns error when deps board not found', async () => {
    mockGetBoard.mockResolvedValue(null);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('deps b1 t1');
    expect(runMessage(result)).toContain('not found');
  });

  it('prune dry-run shows nothing to prune', async () => {
    mockListBoards.mockResolvedValue([
      {
        id: 'b1',
        title: 'B1',
        updatedAt: new Date().toISOString(),
        taskCount: 0,
        completedTaskCount: 0,
      },
    ]);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('prune 7');
    expect(runMessage(result)).toContain('Nothing to prune');
  });

  it('prune with --all includes unfinished boards', async () => {
    mockListBoards.mockResolvedValue([]);
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('prune 7 --all');
    expect(runMessage(result)).toContain('Nothing to prune');
  });

  it('prune invalid days returns usage', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('prune abc');
    expect(runMessage(result)).toContain('Usage');
  });

  it('returns help for unknown subcommand', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('totally-unknown');
    expect(runMessage(result)).toBeTruthy();
  });

  it('open/panel subcommand in non-TUI returns message', async () => {
    const cmd = buildKanbanCommand(makeCtx());
    const result = await cmd.run('open');
    expect(runMessage(result)).toBeTruthy();
  });
});
