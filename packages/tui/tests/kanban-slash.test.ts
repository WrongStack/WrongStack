// Tests for `/kanban` — the TUI slash command that opens the kanban panel
// and performs common board/task operations from the composer.
//
// What this file pins down:
//   - `parseKanbanArgs` grammar covers every supported subcommand + the
//     unknown/help fall-throughs
//   - `createKanbanSlashCommand.run` routes to the right @wrongstack/kanban
//     function, opens the panel via the onPanelOpen bridge, and emits helpful
//     error messages when there's no board to act on
//   - `renderBoardsList` renders empty / populated boards with width-aware
//     truncation
//   - The empty-state hint in `KanbanPanel` no longer references a slash
//     command that doesn't exist (defensive regression on the hint text)

import type {
  KanbanBoard,
  KanbanBoardSummary,
  KanbanColumn,
  KanbanQueueHealth,
  KanbanTask,
} from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKanbanSlashCommand,
  type KanbanSlashDeps,
  parseKanbanArgs,
  renderAuditReport,
  renderBoardsList,
  renderHealthReport,
  resolveAddTarget,
} from '../src/kanban-slash.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = '2026-07-18T12:00:00.000Z';

function column(
  id: string,
  title: string,
  order: number,
  extras: Partial<KanbanColumn> = {},
): KanbanColumn {
  return { id, title, order, ...extras };
}

function task(
  id: string,
  columnId: string,
  title: string,
  status: KanbanTask['status'] = 'pending',
  order = 0,
): KanbanTask {
  return {
    id,
    columnId,
    title,
    status,
    order,
    priority: 'medium',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function summary(
  id: string,
  title: string,
  extras: Partial<KanbanBoardSummary> = {},
): KanbanBoardSummary {
  return {
    id,
    title,
    createdAt: NOW,
    updatedAt: NOW,
    columnCount: 3,
    taskCount: 0,
    completedTaskCount: 0,
    ...extras,
  };
}

function board(
  id: string,
  title: string,
  columns: KanbanColumn[],
  tasks: KanbanTask[] = [],
  extras: Partial<KanbanBoard> = {},
): KanbanBoard {
  return {
    id,
    title,
    columns,
    tasks,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...extras,
  };
}

// ── vi.mock factories ───────────────────────────────────────────────────────

const mockCreateBoard = vi.fn();
const mockAddTask = vi.fn();
const mockListBoards = vi.fn();
const mockGetBoard = vi.fn();
const mockUpdateBoard = vi.fn();
const mockUpdateTask = vi.fn();

vi.mock('@wrongstack/kanban', () => ({
  createBoard: (...args: unknown[]) => mockCreateBoard(...args),
  addTask: (...args: unknown[]) => mockAddTask(...args),
  listBoards: (...args: unknown[]) => mockListBoards(...args),
  getBoard: (...args: unknown[]) => mockGetBoard(...args),
  updateBoard: (...args: unknown[]) => mockUpdateBoard(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
}));

// ── Test helpers ────────────────────────────────────────────────────────────

type PanelOpenMock = ReturnType<typeof vi.fn<(action: string) => boolean>>;
type BoardFocusMock = ReturnType<typeof vi.fn<(boardId: string) => boolean>>;

function makeDeps(
  overrides: Omit<Partial<KanbanSlashDeps>, 'onPanelOpen' | 'onBoardFocus'> & {
    onPanelOpen?: { current: PanelOpenMock | null };
    onBoardFocus?: { current: BoardFocusMock | null };
  } = {},
): KanbanSlashDeps & {
  onPanelOpen: { current: PanelOpenMock | null };
  onBoardFocus: { current: BoardFocusMock | null };
} {
  // Strip both bridges out of the spread so a caller's accidental
  // `undefined` cannot leak into the returned bridges (which the runner
  // types as non-null). Both fall back to a fresh mock that auto-resolves
  // true — only the bridge-success tests deliberately replace these
  // with `undefined` or `() => false` mocks.
  const { onPanelOpen: overridePanel, onBoardFocus: overrideFocus, ...rest } = overrides;
  return {
    projectRoot: '/tmp/project',
    // A TUI always runs inside a session; board writes are attributed to it.
    sessionId: 'abc123',
    onPanelOpen: overridePanel ?? { current: vi.fn(() => true) },
    onBoardFocus: overrideFocus ?? { current: vi.fn(() => true) },
    terminalWidth: 100,
    ...rest,
  };
}

function emptyResult(): { board: KanbanBoard | null; task: KanbanTask | null } {
  return { board: null, task: null };
}

beforeEach(() => {
  mockCreateBoard.mockReset();
  mockAddTask.mockReset();
  mockListBoards.mockReset();
  mockGetBoard.mockReset();
  mockUpdateBoard.mockReset();
  mockUpdateTask.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('parseKanbanArgs', () => {
  it('parses board and task boundary commands', () => {
    expect(parseKanbanArgs('boundary sprint show')).toEqual({
      kind: 'boundary',
      boardQuery: 'sprint',
      action: 'show',
    });
    expect(
      parseKanbanArgs(
        'boundary sprint allow package read_write packages/webui --task abc123 --enforcement block --shell confirm',
      ),
    ).toEqual({
      kind: 'boundary',
      boardQuery: 'sprint',
      action: 'allow',
      selectorKind: 'package',
      access: 'read_write',
      path: 'packages/webui',
      taskQuery: 'abc123',
      enforcement: 'block',
      shellAccess: 'confirm',
    });
    expect(parseKanbanArgs('boundary sprint allow folder write src')).toEqual({ kind: 'help' });
  });

  it('empty input opens the panel', () => {
    expect(parseKanbanArgs('')).toEqual({ kind: 'open' });
    expect(parseKanbanArgs('   ')).toEqual({ kind: 'open' });
  });

  it('recognises help aliases and treats unknown subcommands as help', () => {
    expect(parseKanbanArgs('help')).toEqual({ kind: 'help' });
    expect(parseKanbanArgs('--help')).toEqual({ kind: 'help' });
    expect(parseKanbanArgs('-h')).toEqual({ kind: 'help' });
    // Unknown subcommands surface the usage text so users discover the
    // right command shape instead of getting a silent "command not found".
    expect(parseKanbanArgs('frobnicate')).toEqual({ kind: 'help' });
  });

  it('recognises boards/list/ls aliases', () => {
    expect(parseKanbanArgs('boards')).toEqual({ kind: 'boards' });
    expect(parseKanbanArgs('list')).toEqual({ kind: 'boards' });
    expect(parseKanbanArgs('ls')).toEqual({ kind: 'boards' });
  });

  it('parses create with a single-word title', () => {
    expect(parseKanbanArgs('create sprint-2')).toEqual({
      kind: 'create',
      title: 'sprint-2',
    });
  });

  it('parses create with a multi-word and quoted title', () => {
    expect(parseKanbanArgs('create "Sprint 2 — hardening"')).toEqual({
      kind: 'create',
      title: 'Sprint 2 — hardening',
    });
  });

  it('parses add with an optional --column flag', () => {
    expect(parseKanbanArgs('add "fix login bug" --column todo')).toEqual({
      kind: 'add',
      title: 'fix login bug',
      column: 'todo',
    });
  });

  it('parses add with -c shorthand and --column=value form', () => {
    expect(parseKanbanArgs('add -c review "rework copy"')).toEqual({
      kind: 'add',
      title: 'rework copy',
      column: 'review',
    });
    expect(parseKanbanArgs('add wire webhooks --column=in-progress')).toEqual({
      kind: 'add',
      title: 'wire webhooks',
      column: 'in-progress',
    });
  });

  it('parses add with --desc, -d shorthand and --desc=value form', () => {
    expect(parseKanbanArgs('add "fix login" --desc "empty password edge case"')).toEqual({
      kind: 'add',
      title: 'fix login',
      column: null,
      description: 'empty password edge case',
    });
    expect(parseKanbanArgs('add seed db -d "idempotent fixtures"')).toEqual({
      kind: 'add',
      title: 'seed db',
      column: null,
      description: 'idempotent fixtures',
    });
    expect(parseKanbanArgs('add ship feature --desc=go-live')).toEqual({
      kind: 'add',
      title: 'ship feature',
      column: null,
      description: 'go-live',
    });
    // description is optional; without it the parsed result omits the field.
    expect(parseKanbanArgs('add plain task')).toEqual({
      kind: 'add',
      title: 'plain task',
      column: null,
    });
    // --column and --desc compose freely.
    expect(parseKanbanArgs('add "x" -c review --desc "y"')).toEqual({
      kind: 'add',
      title: 'x',
      column: 'review',
      description: 'y',
    });
  });

  it('falls back to help when add/create are missing their argument', () => {
    expect(parseKanbanArgs('create')).toEqual({ kind: 'help' });
    expect(parseKanbanArgs('add')).toEqual({ kind: 'help' });
  });

  it('parses audit with no argument as a project-wide scan', () => {
    expect(parseKanbanArgs('audit')).toEqual({ kind: 'audit', boardQuery: '' });
    expect(parseKanbanArgs('clean')).toEqual({ kind: 'audit', boardQuery: '' });
    expect(parseKanbanArgs('cleaner')).toEqual({ kind: 'audit', boardQuery: '' });
  });

  it('parses audit <query> as a single-board scan', () => {
    expect(parseKanbanArgs('audit Demo')).toEqual({
      kind: 'audit',
      boardQuery: 'Demo',
    });
    expect(parseKanbanArgs('clean "Sprint 2"')).toEqual({
      kind: 'audit',
      boardQuery: 'Sprint 2',
    });
  });
});

describe('createKanbanSlashCommand — dispatch routing', () => {
  it('exposes a slash command named "kanban"', () => {
    const cmd = createKanbanSlashCommand(makeDeps());
    expect(cmd.name).toBe('kanban');
    expect(cmd.description).toMatch(/board/i);
  });

  it('empty args opens the kanban panel and returns a silent success', async () => {
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('');
    expect(result).toEqual({ message: '' });
    expect(deps.onPanelOpen.current).toHaveBeenCalledWith('toggleKanbanPanel');
  });

  it('falls back to text guidance when the onPanelOpen bridge rejects', async () => {
    const deps = makeDeps({
      onPanelOpen: { current: vi.fn(() => false) },
    });
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('');
    expect((result as { message?: string }).message).toMatch(/bridge not available/);
  });

  it('create subcommand writes a board and opens the panel', async () => {
    mockCreateBoard.mockResolvedValue(
      board('board-123', 'My board', [column('backlog', 'Backlog', 0)]),
    );
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);

    const result = await cmd.run('create My board');
    // A board created from inside a session carries that session's tag, which
    // is how `/kanban add` later finds "this session's board" first.
    expect(mockCreateBoard).toHaveBeenCalledWith('/tmp/project', {
      title: 'My board',
      tags: ['session:abc123'],
    });
    expect((result as { message?: string }).message).toContain('Created board');
    expect(deps.onPanelOpen.current).toHaveBeenCalledWith('toggleKanbanPanel');
  });

  it('tags a created board for the active session before opening the panel', async () => {
    mockCreateBoard.mockResolvedValue(
      board('board-session', 'Session board', [column('backlog', 'Backlog', 0)], [], {
        tags: ['session:abc123'],
      }),
    );
    const deps = makeDeps({ sessionId: 'abc123' });
    const cmd = createKanbanSlashCommand(deps);

    await cmd.run('create Session board');

    expect(mockCreateBoard).toHaveBeenCalledWith('/tmp/project', {
      title: 'Session board',
      tags: ['session:abc123'],
    });
    expect(deps.onPanelOpen.current).toHaveBeenCalledWith('toggleKanbanPanel');
  });

  it('add subcommand targets the session-tagged board first, then the most recent', async () => {
    const older = summary('board-old', 'Older board', { updatedAt: '2026-07-01T00:00:00Z' });
    const session = summary('board-session', 'Session board', {
      tags: ['session:abc123'],
      updatedAt: '2026-07-15T00:00:00Z',
    });
    const newer = summary('board-new', 'Newer board', { updatedAt: '2026-07-17T00:00:00Z' });

    mockListBoards.mockResolvedValue([older, session, newer]);
    mockGetBoard.mockResolvedValue(
      board(
        'board-session',
        'Session board',
        [column('backlog', 'Backlog', 0), column('todo', 'To Do', 1), column('done', 'Done', 2)],
        [],
      ),
    );
    mockAddTask.mockResolvedValue({
      ...emptyResult(),
      board: board('board-session', 'Session board', [column('todo', 'To Do', 1)]),
      task: task('task-1', 'todo', 'next attempt'),
    });

    const deps = makeDeps({ sessionId: 'abc123' });
    const target = await resolveAddTarget(deps, null);
    expect(target?.boardId).toBe('board-session');
    expect(target?.columnId).toBe('backlog');

    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('add "next attempt"');
    expect((result as { message?: string }).message).toContain('Added task');
    expect((result as { message?: string }).message).toContain('Session board');
    expect(mockAddTask).toHaveBeenCalledWith(
      '/tmp/project',
      'board-session',
      expect.objectContaining({ title: 'next attempt', columnId: 'backlog' }),
      expect.objectContaining({ sessionId: 'abc123' }),
    );
    expect(deps.onPanelOpen.current).toHaveBeenCalledWith('toggleKanbanPanel');
  });

  it('add subcommand falls back to the most-recently-updated board when no session tag matches', async () => {
    // No board carries the session:<id> tag, so resolveAddTarget must
    // fall through to the most-recently-updated summary. We give `board-old`
    // an earlier updatedAt than `board-new` to make the precedence
    // unambiguous.
    const older = summary('board-old', 'Older board', { updatedAt: '2026-07-01T00:00:00Z' });
    const newer = summary('board-new', 'Newer board', { updatedAt: '2026-07-17T00:00:00Z' });

    mockListBoards.mockResolvedValue([older, newer]);
    mockGetBoard.mockResolvedValue(
      board('board-new', 'Newer board', [column('backlog', 'Backlog', 0)]),
    );
    mockAddTask.mockResolvedValue({
      ...emptyResult(),
      board: board('board-new', 'Newer board', [column('backlog', 'Backlog', 0)]),
      task: task('t1', 'backlog', 'next'),
    });

    // A session with no `session:<id>`-tagged board, so the most-recently-
    // updated fallback branch runs.
    const deps = makeDeps({ sessionId: 'session-with-no-board' });
    const target = await resolveAddTarget(deps, null);
    expect(target?.boardId).toBe('board-new');
    expect(target?.boardTitle).toBe('Newer board');
  });

  it('add subcommand honours --column by id or by title', async () => {
    mockListBoards.mockResolvedValue([summary('b', 'Solo', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(
      board('b', 'Solo', [column('backlog', 'Backlog', 0), column('review', 'Review', 1)]),
    );
    mockAddTask.mockResolvedValue({
      ...emptyResult(),
      board: board('b', 'Solo', [column('review', 'Review', 1)]),
      task: task('t1', 'review', 'check'),
    });
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('add check --column review');
    expect(mockAddTask).toHaveBeenCalledWith(
      '/tmp/project',
      'b',
      expect.objectContaining({ columnId: 'review' }),
      expect.objectContaining({ sessionId: 'abc123' }),
    );
    expect((result as { message?: string }).message).toContain('review');

    mockAddTask.mockClear();
    mockAddTask.mockResolvedValue({
      ...emptyResult(),
      board: board('b', 'Solo', [column('review', 'Review', 1)]),
      task: task('t2', 'review', 'verify'),
    });
    await cmd.run('add verify -c "Review"');
    expect(mockAddTask).toHaveBeenCalledWith(
      '/tmp/project',
      'b',
      expect.objectContaining({ columnId: 'review' }),
      expect.objectContaining({ sessionId: 'abc123' }),
    );
  });

  it('add subcommand reports a clear error when there are no boards', async () => {
    mockListBoards.mockResolvedValue([]);
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('add anything');
    expect((result as { message?: string }).message).toMatch(
      /no kanban board found.*\/kanban create/i,
    );
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(deps.onPanelOpen.current).not.toHaveBeenCalled();
  });

  it('add subcommand on a managed board without --desc surfaces a helpful error', async () => {
    // Managed boards require a description on every card (see
    // `initializeAndValidateManagedTask`). Rather than letting the create
    // call fail with a cryptic validation error, we intercept and point the
    // user at the --desc flag.
    mockListBoards.mockResolvedValue([summary('mb', 'Managed', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(
      board(
        'mb',
        'Managed',
        [
          column('backlog', 'Backlog', 0),
          column('todo', 'To Do', 1),
          column('in-progress', 'In Progress', 2),
          column('review', 'Review', 3),
          column('done', 'Done', 4),
        ],
        [],
        {
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
        },
      ),
    );

    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('add "wire up CI"');
    const message = (result as { message?: string }).message ?? '';
    expect(message).toMatch(/managed board/i);
    expect(message).toMatch(/--desc/);
    // No task should have been created.
    expect(mockAddTask).not.toHaveBeenCalled();
    expect(deps.onPanelOpen.current).not.toHaveBeenCalled();
  });

  it('add subcommand on a managed board with --desc creates the task in Backlog', async () => {
    // With a description supplied, the task should land in the Backlog
    // column regardless of any caller-supplied --column hint (managed
    // boards pin new cards to Backlog).
    mockListBoards.mockResolvedValue([summary('mb', 'Managed', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(
      board(
        'mb',
        'Managed',
        [column('backlog', 'Backlog', 0), column('todo', 'To Do', 1), column('done', 'Done', 2)],
        [],
        {
          lifecycle: {
            mode: 'managed',
            columns: {
              backlog: 'backlog',
              todo: 'todo',
              running: 'todo',
              review: 'todo',
              done: 'done',
            },
          },
        },
      ),
    );
    mockAddTask.mockResolvedValue({
      ...emptyResult(),
      board: board('mb', 'Managed', [column('backlog', 'Backlog', 0)]),
      task: task('t1', 'backlog', 'wire up CI'),
    });

    const deps = makeDeps();
    const target = await resolveAddTarget(deps, 'done');
    // --column done must be ignored: managed boards always target Backlog.
    expect(target?.managed).toBe(true);
    expect(target?.columnId).toBe('backlog');

    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('add "wire up CI" --desc "configure github actions"');
    expect(mockAddTask).toHaveBeenCalledWith(
      '/tmp/project',
      'mb',
      expect.objectContaining({
        title: 'wire up CI',
        columnId: 'backlog',
        description: 'configure github actions',
      }),
      expect.objectContaining({ sessionId: 'abc123' }),
    );
    const message = (result as { message?: string }).message ?? '';
    expect(message).toContain('Added task');
    expect(message).toContain('backlog');
    expect(deps.onPanelOpen.current).toHaveBeenCalledWith('toggleKanbanPanel');
  });

  it('resolveAddTarget flags a legacy board as managed:false and honours --column', async () => {
    mockListBoards.mockResolvedValue([summary('legacy', 'Legacy', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(
      board('legacy', 'Legacy', [column('todo', 'To Do', 0), column('done', 'Done', 1)]),
    );
    const deps = makeDeps();
    const target = await resolveAddTarget(deps, 'done');
    expect(target?.managed).toBe(false);
    expect(target?.columnId).toBe('done');
  });

  it('unknown subcommand returns the usage text without touching the panel', async () => {
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('frobnicate');
    expect((result as { message?: string }).message).toMatch(/Usage:/);
    expect(deps.onPanelOpen.current).not.toHaveBeenCalled();
  });

  it('boards subcommand renders the boards table', async () => {
    mockListBoards.mockResolvedValue([
      summary('b-new', 'Newer', {
        updatedAt: '2026-07-18T00:00:00Z',
        taskCount: 5,
        completedTaskCount: 2,
      }),
      summary('b-old', 'Older', { updatedAt: '2026-07-01T00:00:00Z', taskCount: 1 }),
    ]);
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('boards');
    expect((result as { message?: string }).message).toContain('Newer');
    expect((result as { message?: string }).message).toContain('Older');
    expect((result as { message?: string }).message).toMatch(/2 boards/);
    expect(deps.onPanelOpen.current).not.toHaveBeenCalled();
  });

  it('wraps thrown errors with a kanban command prefix', async () => {
    mockCreateBoard.mockRejectedValue(new Error('disk full'));
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('create broken');
    expect((result as { message?: string }).message).toMatch(/Kanban command failed/);
    expect((result as { message?: string }).message).toContain('disk full');
  });
});

describe('renderBoardsList', () => {
  it('emits an empty-state message when no boards exist', () => {
    const out = renderBoardsList([]);
    expect(out).toMatch(/none yet/);
    expect(out).toContain('/kanban create');
  });

  it('sorts boards newest first and surfaces task counts', () => {
    const boards = [
      summary('a', 'Alpha', { updatedAt: '2026-07-01T00:00:00Z', taskCount: 1 }),
      summary('b', 'Beta', {
        updatedAt: '2026-07-18T00:00:00Z',
        taskCount: 4,
        completedTaskCount: 2,
      }),
    ];
    const out = renderBoardsList(boards);
    // Beta comes first because its updatedAt is later
    const betaIdx = out.indexOf('Beta');
    const alphaIdx = out.indexOf('Alpha');
    expect(betaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeLessThan(alphaIdx);
    expect(out).toContain('4 tasks');
    expect(out).toContain('2 done');
  });

  it('truncates long titles in narrow terminals', () => {
    const long = 'x'.repeat(60);
    const out = renderBoardsList([summary('b', long, { updatedAt: NOW })], 40);
    expect(out).not.toContain(long);
    expect(out).toContain('…');
  });

  it('marks goal-linked boards', () => {
    const boards = [summary('b', 'Goal board', { tags: ['goal:auth'], updatedAt: NOW })];
    const out = renderBoardsList(boards);
    expect(out).toContain('🎯');
  });
});

// ── /kanban use — bridge success contract ────────────────────────────────────

describe('/kanban use — bridge success contract', () => {
  beforeEach(() => {
    mockListBoards.mockReset();
    mockCreateBoard.mockReset();
    mockAddTask.mockReset();
    mockGetBoard.mockReset();
  });

  it('reports the board as opening only when both bridges succeed', async () => {
    mockListBoards.mockResolvedValue([summary('b-1', 'Demo', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(board('b-1', 'Demo', [column('backlog', 'Backlog', 0)]));
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('use Demo');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/Opening "Demo"/);
    expect(deps.onPanelOpen.current).toHaveBeenCalledWith('toggleKanbanPanel');
    expect(deps.onBoardFocus.current).toHaveBeenCalledWith('b-1');
  });

  it('reports a clear fallback when both bridges are absent', async () => {
    mockListBoards.mockResolvedValue([summary('b-1', 'Demo', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(board('b-1', 'Demo', [column('backlog', 'Backlog', 0)]));
    const deps = makeDeps({
      onPanelOpen: { current: undefined } as never,
      onBoardFocus: { current: undefined } as never,
    });
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('use Demo');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/bridge is not available/);
    expect(msg).not.toMatch(/Opening "Demo"/);
  });

  it('reports panel-not-opened when only the focus bridge is wired', async () => {
    mockListBoards.mockResolvedValue([summary('b-1', 'Demo', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(board('b-1', 'Demo', [column('backlog', 'Backlog', 0)]));
    const deps = makeDeps({
      onPanelOpen: { current: undefined } as never,
      onBoardFocus: { current: vi.fn(() => true) },
    });
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('use Demo');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/panel did not open/);
    expect(msg).not.toMatch(/Opening "Demo"/);
  });

  it('reports partial success when panel opens but focus returns false', async () => {
    mockListBoards.mockResolvedValue([summary('b-1', 'Demo', { updatedAt: NOW })]);
    mockGetBoard.mockResolvedValue(board('b-1', 'Demo', [column('backlog', 'Backlog', 0)]));
    const deps = makeDeps({
      onPanelOpen: { current: vi.fn(() => true) },
      onBoardFocus: { current: vi.fn(() => false) },
    });
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('use Demo');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/could not focus "Demo"/);
    expect(msg).not.toMatch(/Opening "Demo"/);
  });
});

// ── renderHealthReport — partition the lifecycle total correctly ───────────

function makeHealth(overrides: Partial<KanbanQueueHealth['counts']> = {}): KanbanQueueHealth {
  return {
    generatedAt: '2026-07-18T12:00:00.000Z',
    boardIds: ['b-1'],
    counts: {
      ready: 0,
      startable: 0,
      queued: 0,
      running: 0,
      review: 0,
      failed: 0,
      completed: 0,
      pending: 0,
      archived: 0,
      blocked: 0,
      ...overrides,
    },
    dependencyBlocked: { count: 0, tasks: [] },
    staleAssignments: { count: 0, tasks: [] },
    failedRetryable: { count: 0, tasks: [] },
    heartbeatDue: { count: 0, tasks: [] },
    // `KanbanQueueHealth` declares these optional (`?: string`); under
    // exactOptionalPropertyTypes they must be omitted rather than set to
    // `undefined`. The renderer already treats an absent value as "never".
  };
}

describe('renderHealthReport — queue-health partitioning', () => {
  it('does not double-count queued against the lifecycle total', () => {
    // 5 lifecycle tasks, 3 of them queued for assignment. The headline
    // total must be 5, not 8 — `queued` is an overlay.
    const out = renderHealthReport(makeHealth({ ready: 2, queued: 3, running: 1, completed: 2 }));
    expect(out).toContain('5 task');
    expect(out).not.toContain('8 task');
  });

  it('reports queued as a separate "subset" line when present', () => {
    const out = renderHealthReport(makeHealth({ ready: 2, queued: 3 }));
    expect(out).toMatch(/3 currently queued for assignment/);
    expect(out).toMatch(/queued 3/);
  });

  it('omits the queued subset line when no tasks are queued', () => {
    const out = renderHealthReport(makeHealth({ ready: 2 }));
    expect(out).not.toContain('currently queued for assignment');
  });
});

// ── /kanban audit — Kanban Cleaner projection ──────────────────────────────

import type { KanbanAuditSummary } from '../src/kanban-audit.js';

function makeAudit(overrides: Partial<KanbanAuditSummary> = {}): KanbanAuditSummary {
  const issues = overrides.issues ?? [
    {
      id: 'i-err',
      taskId: 't-err',
      taskTitle: 'Error task',
      code: 'abandoned-running-task',
      severity: 'error' as const,
      message: 'Running without a complete assignment lease',
    },
    {
      id: 'i-warn',
      taskId: 't-warn',
      taskTitle: 'Warning task',
      code: 'missing-description',
      severity: 'warning' as const,
      message: 'Add a description',
    },
  ];
  const errorCount = issues.filter(
    (i: { severity: string; taskId?: string }) => i.severity === 'error',
  ).length;
  const warningCount = issues.filter(
    (i: { severity: string; taskId?: string }) => i.severity === 'warning',
  ).length;
  return {
    generatedAt: '2026-07-18T12:00:00.000Z',
    boardIds: ['b-1'],
    counts: { error: errorCount, warning: warningCount },
    dependencyBlocked: { count: 0, tasks: [] },
    staleAssignments: { count: 0, tasks: [] },
    failedRetryable: { count: 0, tasks: [] },
    heartbeatDue: { count: 0, tasks: [] },
    lastDispatchedAt: undefined,
    lastStaleRecoveredAt: undefined,
    issues,
    affectedTaskCount: new Set(issues.map((i: { severity: string; taskId?: string }) => i.taskId))
      .size,
    ...overrides,
  };
}

describe('renderAuditReport — multi-board scan', () => {
  it('emits a per-board table with severity counters and top issues', () => {
    const out = renderAuditReport(
      [
        { title: 'Sprint 4 demo', summary: makeAudit() },
        { title: 'Clean board', summary: makeAudit({ issues: [] }) },
      ],
      true,
    );
    expect(out).toMatch(/Kanban Cleaner audit/);
    expect(out).toMatch(/2 boards scanned/);
    // Per-board header is shown only in multi mode.
    expect(out).toContain('**Sprint 4 demo**');
    expect(out).toContain('**Clean board**');
    // Severity counters + top issue surface.
    expect(out).toMatch(/2 cleaner issues \(1 error · 1 warning\)/);
    expect(out).toContain('abandoned-running-task');
    expect(out).toContain('missing-description');
    // Clean boards still surface — with a ✓ line, no issue rows.
    expect(out).toMatch(/Clean \(no cleaner findings\)/);
  });

  it('reports a clean board without ranking an issue line', () => {
    const out = renderAuditReport(
      [{ title: 'Spotless', summary: makeAudit({ issues: [] }) }],
      true,
    );
    expect(out).toMatch(/Clean \(no cleaner findings\)/);
    expect(out).not.toContain('abandoned-running-task');
  });

  it('renders errors before warnings inside the top-3 list', () => {
    const out = renderAuditReport([{ title: 'B', summary: makeAudit() }], true);
    const errIdx = out.indexOf('abandoned-running-task');
    const warnIdx = out.indexOf('missing-description');
    expect(errIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(warnIdx);
  });

  it('renders the single-board scan without repeating the title', () => {
    const out = renderAuditReport([{ title: 'Solo board', summary: makeAudit() }], false);
    expect(out).toMatch(/Single-board scan/);
    expect(out).not.toContain('**Solo board**');
    expect(out).not.toMatch(/1 boards scanned/);
  });

  it('falls back to "Could not audit" when a board fails to load', () => {
    const out = renderAuditReport(
      [{ title: 'Broken', summary: makeAudit(), error: 'disk full' }],
      true,
    );
    expect(out).toMatch(/Could not audit: disk full/);
  });
});

describe('/kanban audit — dispatch routing', () => {
  beforeEach(() => {
    mockListBoards.mockReset();
    mockGetBoard.mockReset();
    mockCreateBoard.mockReset();
    mockAddTask.mockReset();
  });

  it('renders an empty-state message when no boards exist', async () => {
    mockListBoards.mockResolvedValue([]);
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('audit');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/No boards exist yet/);
    expect(msg).toContain('/kanban create');
  });

  it('scans a single matching board and reports findings', async () => {
    mockListBoards.mockResolvedValue([summary('b-1', 'Demo', { updatedAt: NOW })]);
    // Use a fully-bare task that triggers multiple cleaner warnings —
    // missing-description (description undefined), missing-labels
    // (no tags / labels), missing-assignee (no assignedAgent), and
    // missing-success-criteria (no checks). The audit must report
    // all of these on a /kanban audit Demo call.
    mockGetBoard.mockResolvedValue(
      board(
        'b-1',
        'Demo',
        [column('todo', 'To Do', 0)],
        [task('t1', 'todo', 'Bare task', 'pending')],
      ),
    );
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('audit Demo');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/Single-board scan/);
    // The bare task fires at least three missing-* warnings; the top-3
    // surface pins two of them and the overflow row pins the rest, so
    // we assert against the full set rather than the visible order.
    expect(msg).toContain('missing-description');
    expect(msg).toContain('missing-labels');
    expect(msg).toMatch(/… and \d+ more|missing-assignee/);
  });

  it('reports a clear error when the queried board does not exist', async () => {
    mockListBoards.mockResolvedValue([summary('b-1', 'Demo', { updatedAt: NOW })]);
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('audit nonexistent');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/No kanban board matches "nonexistent"/);
    expect(msg).toContain('/kanban boards');
  });

  it('scans every board when called with no argument', async () => {
    mockListBoards.mockResolvedValue([
      summary('b-1', 'Alpha', { updatedAt: NOW }),
      summary('b-2', 'Beta', { updatedAt: NOW }),
    ]);
    mockGetBoard.mockImplementation(async (_root: string, id: string) =>
      board(
        id,
        id === 'b-1' ? 'Alpha' : 'Beta',
        [column('todo', 'To Do', 0)],
        [task('t1', 'todo', `t-${id}`, 'pending')],
      ),
    );
    const deps = makeDeps();
    const cmd = createKanbanSlashCommand(deps);
    const result = await cmd.run('audit');
    const msg = (result as { message?: string }).message ?? '';
    expect(msg).toMatch(/2 boards scanned/);
    expect(msg).toContain('**Alpha**');
    expect(msg).toContain('**Beta**');
    // Per-board warnings should surface (missing-* issues on bare tasks).
    expect(msg).toContain('missing-description');
  });
});

describe('KanbanPanel empty-state hint', () => {
  // Defensive regression: the empty-state hint used to claim `/kanban create`
  // was the way to make a board, even though no such command existed. After
  // Sprint 1 the command exists, so this test just guards the surface text
  // (the file is the user-visible surface — the fact that it now reads
  // accurately is the real value).
  it('mentions the now-registered /kanban create subcommand', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    // `fileURLToPath` correctly turns `file:///D:/.../tests/x.test.ts` into
    // a Windows path without the leading-slash ambiguity that bites
    // `new URL(import.meta.url).pathname` here.
    const here = fileURLToPath(import.meta.url);
    const panelPath = path.resolve(path.dirname(here), '../src/components/kanban-panel.tsx');
    const source = await readFile(panelPath, 'utf8');
    // The hint is rendered as JSX with `&lt;title&gt;` so we cannot blindly
    // strip tags (regex over `<...>` matches across angle-bracketed type
    // parameters like `Promise<string | null | undefined>` and corrupts the
    // flattened text). Anchor on each visible phrase directly so the test
    // surfaces a regression even if the surrounding JSX changes shape.
    expect(source).toContain('No kanban boards yet.');
    expect(source).toContain('Press ');
    // The literal text shown to the user, JSX-quoted:
    expect(source).toContain('/kanban create &lt;title&gt;');
    expect(source).toContain('in the composer');
  });
});
