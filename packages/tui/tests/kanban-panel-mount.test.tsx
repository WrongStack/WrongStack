// Sprint 2 behavioral regressions — Ink-mount tests that close the gap
// the pure-helper suite (kanban-panel-render.test.ts) leaves open.
//
// What this file pins down:
//   - At a narrow terminal width, KanbanPanel renders fewer visible
//     columns and surfaces the "+ N more columns" overflow indicator
//     rather than truncating silently.
//   - The TaskDetail pane shows every Sprint 2 surface: priority/status,
//     due date, lifecycle stage, success-criteria rollup, goal-metrics
//     rollup, and per-link line.
//   - The panel honors an `initialBoardId` prop and selects the matching
//     board without requiring the user to navigate manually.
//   - Pressing 'q' on the panel invokes the supplied `onClose` (proves
//     `useInput` is wired into the Ink testing-library renderer).

import type { KanbanBoard, KanbanBoardSummary, KanbanTask } from '@wrongstack/kanban';
import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanPanel } from '../src/components/kanban-panel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── vi.mock factories ────────────────────────────────────────────────────────

const mockListBoards = vi.fn();
const mockGetBoard = vi.fn();
const mockCreateBoard = vi.fn();
const mockDuplicateBoard = vi.fn();
const mockCopyTaskToBoard = vi.fn();
const mockTransferTaskToBoard = vi.fn();
const mockAddTask = vi.fn();
const mockRemoveTask = vi.fn();
const mockMoveTask = vi.fn();
const mockUpdateTask = vi.fn();

const mockDescribeKanbanBoundary = vi.fn((_policy?: unknown): string => 'unrestricted');

vi.mock('@wrongstack/kanban', () => ({
  listBoards: (...args: unknown[]) => mockListBoards(...args),
  getBoard: (...args: unknown[]) => mockGetBoard(...args),
  createBoard: (...args: unknown[]) => mockCreateBoard(...args),
  duplicateBoard: (...args: unknown[]) => mockDuplicateBoard(...args),
  copyTaskToBoard: (...args: unknown[]) => mockCopyTaskToBoard(...args),
  transferTaskToBoard: (...args: unknown[]) => mockTransferTaskToBoard(...args),
  addTask: (...args: unknown[]) => mockAddTask(...args),
  removeTask: (...args: unknown[]) => mockRemoveTask(...args),
  moveTask: (...args: unknown[]) => mockMoveTask(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  describeKanbanBoundary: (policy?: unknown) => mockDescribeKanbanBoundary(policy),
}));

// Stub the session-kanban helper — it would otherwise touch the agent's
// session file. Returning a resolved promise keeps the panel's mutation
// path silent without interfering with the test.
vi.mock('@wrongstack/tools/session-kanban', () => ({
  applySessionKanbanTaskToSource: () => Promise.resolve(),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = '2026-07-18T12:00:00.000Z';

function summary(id: string, title: string, taskCount = 3): KanbanBoardSummary {
  return {
    id,
    title,
    createdAt: NOW,
    updatedAt: NOW,
    columnCount: 5,
    taskCount,
    completedTaskCount: 0,
  };
}

function task(
  id: string,
  columnId: string,
  title: string,
  overrides: Partial<KanbanTask> = {},
): KanbanTask {
  return {
    id,
    title,
    columnId,
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function populatedBoard(): KanbanBoard {
  return {
    id: 'b-pop',
    title: 'Sprint 2 demo',
    columns: [
      { id: 'backlog', title: 'Backlog', order: 0 },
      { id: 'todo', title: 'To Do', order: 1 },
      { id: 'review', title: 'Review', order: 2 },
    ],
    tasks: [
      task('t1', 'todo', 'Wire kanban-slash command', {
        priority: 'high',
        status: 'in_progress',
        dueDate: '2026-08-01',
        successCriteria: [
          { id: 'c1', description: 'register /kanban', type: 'manual', status: 'passed' },
          { id: 'c2', description: 'wire health subcommand', type: 'auto', status: 'pending' },
        ],
        goalMetrics: [
          { id: 'g1', name: 'latency', status: 'met' },
          { id: 'g2', name: 'errors', status: 'missed' },
        ],
        links: [
          { url: 'https://example.com/board-1', title: 'Spec', type: 'doc' },
          { url: 'https://example.com/repo/pull/42', type: 'pr' },
        ],
        lifecycle: {
          currentStage: 'todo',
          stageEnteredAt: NOW,
          history: [],
        },
      }),
    ],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

function renderWithAct(element: React.ReactElement): ReturnType<typeof render> {
  let result: ReturnType<typeof render>;
  act(() => {
    result = render(element);
  });
  return result!;
}

function renderPanel(props: {
  board: KanbanBoard;
  terminalWidth?: number;
  initialBoardId?: string;
  onClose?: () => void;
}) {
  const { board, terminalWidth = 200, initialBoardId, onClose } = props;
  mockListBoards.mockResolvedValue([summary(board.id, board.title, board.tasks.length)]);
  mockGetBoard.mockResolvedValue(board);

  return renderWithAct(
    React.createElement(KanbanPanel, {
      projectRoot: '/tmp/project',
      sessionId: 'abc123',
      onClose: onClose ?? (() => {}),
      terminalWidth,
      initialBoardId,
    }),
  );
}

// ── Audit-aware fixture & Ink-mount tests ────────────────────────────────────

const STALE_REVIEW_AT = '2026-07-15T06:00:00.000Z'; // 78h before mount-time

function populatedBoardWithIssues(): KanbanBoard {
  return {
    id: 'b-audit',
    title: 'Sprint 4 audit demo',
    columns: [
      { id: 'todo', title: 'To Do', order: 0 },
      { id: 'review', title: 'Review', order: 1 },
    ],
    tasks: [
      // Stale-review trigger: in review for >72h. Drives `stale-review`.
      task('stale', 'review', 'Stale review item', {
        status: 'review',
        updatedAt: STALE_REVIEW_AT,
      }),
      // Missing-description + missing-assignee + missing-success-criteria:
      task('bare', 'todo', 'Bare task', {
        description: undefined,
        assignedAgent: undefined,
        assignee: undefined,
        successCriteria: undefined,
        labels: undefined,
        childTaskIds: undefined,
      }),
      // Running without a complete lease: drives `abandoned-running-task`.
      task('running', 'todo', 'Run-without-lease', {
        status: 'in_progress',
        assignedAgent: undefined,
        assignment: {
          status: 'running',
          agentId: 'agent-1',
          // leaseId/leaseExpiresAt intentionally absent.
        },
      }),
    ],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  };
}

describe('KanbanPanel — audit badge Ink-mount', () => {
  it('renders the audit headline + top issues when the board has findings', async () => {
    const { lastFrame } = renderPanel({ board: populatedBoardWithIssues() });
    await settle();
    const frame = lastFrame() ?? '';
    // Headline count: 1 error (abandoned-running-task) + 4 warnings
    // (stale-review + missing-description + missing-assignee +
    // missing-success-criteria). Plus missing-labels (5) and
    // missing-subtasks (6) — total 6 warnings + 1 error = 7 issues.
    expect(frame).toMatch(/cleaner issues?/);
    // Headline color-coded with the warning glyph ⚠.
    expect(frame).toMatch(/⚠/);
    // Top issue — the abandoned-running-task is error-severity and
    // ranks first.
    expect(frame).toMatch(/Run-without-lease/);
    expect(frame).toMatch(/abandoned-running-task|assignment lease/i);
  });

  it('renders nothing for a clean board (no findings → no badge)', async () => {
    // Construct a board where every task satisfies every audit rule —
    // description, assignee, criteria, labels, non-running status,
    // non-stale review — so the audit summary is empty and the badge
    // is hidden.
    const clean: KanbanBoard = {
      id: 'b-clean',
      title: 'Clean board',
      columns: [
        { id: 'todo', title: 'To Do', order: 0 },
        { id: 'review', title: 'Review', order: 1 },
      ],
      tasks: [
        task('c1', 'todo', 'Healthy task', {
          description: 'A well-formed task description.',
          assignedAgent: 'core-builder',
          status: 'pending',
          // Provide all the criteria the audit checks for.
          successCriteria: [{ id: 'c', description: 'x', type: 'manual', status: 'pending' }],
          labels: ['feature:ready'],
        }),
      ],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    };
    const { lastFrame, unmount } = renderPanel({ board: clean });
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/cleaner issues/);
    act(() => unmount());
  });
});

/**
 * Drain the microtask queue inside `act()` so React state updates that
 * arrive from a resolved promise trigger a re-render before the test
 * asserts on the frame. A bare `await Promise.resolve()` is not enough:
 * the resolver schedules the .then callback as a separate microtask and
 * `lastFrame()` may still capture the pre-resolve render.
 */
async function settle(): Promise<void> {
  await act(async () => {
    // Two microtask ticks cover: (1) `Promise.then` callback, (2) the
    // React state update it triggers.
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('KanbanPanel — Ink-mount regressions', () => {
  it('renders every visible column at a wide terminal width', async () => {
    const { lastFrame, unmount } = renderPanel({
      board: populatedBoard(),
      terminalWidth: 200,
    });
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Backlog');
    expect(frame).toContain('To Do');
    expect(frame).toContain('Review');
    // No overflow indicator when all columns fit.
    expect(frame).not.toMatch(/\+\s*\d+\s+more column/);
    act(() => unmount());
  });

  it('drops columns and shows the overflow indicator at narrow width', async () => {
    const wideBoard: KanbanBoard = {
      ...populatedBoard(),
      columns: Array.from({ length: 7 }, (_, i) => ({
        id: `col-${i}`,
        title: `Column ${i}`,
        order: i,
      })),
    };
    const { lastFrame, unmount } = renderPanel({
      board: wideBoard,
      terminalWidth: 80,
    });
    await settle();
    const frame = lastFrame() ?? '';
    // The narrow terminal forces fewer columns than 7 — the helper says at
    // most 2 fit, so the rest show up as overflow.
    expect(frame).toMatch(/\+\s*\d+\s+more column/);
    // First column title should still render even when narrowed.
    expect(frame).toContain('Column 0');
    // And the last column should NOT render — that's the visual
    // difference from "render everything, truncate, hide count".
    expect(frame).not.toContain('Column 6');
    act(() => unmount());
  });

  it('renders the populated TaskDetail fields after selecting a task', async () => {
    const board = populatedBoard();
    // Use an extra-wide terminal so the task-detail pane (34 cols) and the
    // board-list pane (24 cols) both render full titles without truncation.
    // We are asserting on field visibility, not on the narrow-width
    // truncation behavior (that's covered by the dedicated narrow test).
    const { lastFrame, unmount } = renderPanel({ board, terminalWidth: 400 });
    await settle();
    // Without selecting a task explicitly, the panel defaults to the first
    // task (selectedTask=0). The frame should already include the task
    // detail fields because `selectedTask=0` is the initial state.
    const frame = lastFrame() ?? '';
    // The task-detail pane has a fixed 34-col width — long titles get
    // truncated to "Wire kanban-slash com…" by Ink's wrap="truncate".
    // We match the stable prefix instead of the full title so this
    // assertion stays meaningful across narrow and wide renders.
    expect(frame).toMatch(/Wire kanban-slash/);
    expect(frame).toContain('HIGH / in_progress');
    expect(frame).toContain('Due 2026-08-01');
    expect(frame).toContain('Stage todo');
    expect(frame).toContain('Criteria 1/2 passed');
    // The metrics line wraps inside the 34-col detail pane, splitting
    // "Metrics 1 met · 1 missed" across two visual rows. Match the
    // rendered prefix and the "missed" suffix independently so the
    // assertion stays meaningful regardless of where Ink inserts the
    // line break.
    expect(frame).toContain('Metrics 1 met');
    expect(frame).toContain('missed');
    expect(frame).toContain('Spec'); // link title (literal)
    // The link-list header "Links (2)" plus the per-link type icons
    // (📄 for doc, 🔀 for pr) prove the Links section rendered both links.
    // The actual URL text gets truncated by the 34-col detail pane so
    // we don't pin it to a full string.
    expect(frame).toContain('Links (2)');
    expect(frame).toContain('📄');
    expect(frame).toContain('🔀');
    act(() => unmount());
  });

  it('selects the board named by initialBoardId rather than the session-tag fallback', async () => {
    // Two boards: one tagged with the session, one unrelated. initialBoardId
    // should win.
    const sessionTagged = summary('board-session', 'Session board');
    const unrelated = summary('board-other', 'Other board', 5);
    mockListBoards.mockResolvedValue([sessionTagged, unrelated]);

    const board = populatedBoard();
    mockGetBoard.mockImplementation(async (_root: string, id: string) => {
      if (id === 'board-other') {
        return { ...board, id: 'board-other', title: 'Other board' };
      }
      return { ...board, id, title: id };
    });

    const { lastFrame, unmount } = renderWithAct(
      React.createElement(KanbanPanel, {
        projectRoot: '/tmp/project',
        sessionId: 'abc123',
        onClose: () => {},
        // Wide terminal so the board-list pane shows the full title.
        terminalWidth: 400,
        initialBoardId: 'board-other',
      }),
    );
    await settle();
    const frame = lastFrame() ?? '';
    // The board-list pane is 24 cols wide and uses wrap="truncate" on the
    // title text — a 10-char "Other board" with the leading cursor
    // marker and a small gap leaves room for "Other boar" only, so we
    // match the truncated prefix instead of the full title.
    expect(frame).toMatch(/Other boar/);
    // The session-tagged board shows up as a non-focused entry ("  Session bo…")
    // AND as a footer "next board: Session board" line — that's a
    // valid UI behaviour, but the SELECTED row should be "Other board"
    // (the `> ` cursor marker). We assert the cursor marker didn't land
    // on Session.
    expect(frame).not.toMatch(/>\s*Session/);
    act(() => unmount());
  });

  it('routes "q" through useInput to the supplied onClose', async () => {
    const onClose = vi.fn();
    const board = populatedBoard();
    mockListBoards.mockResolvedValue([summary(board.id, board.title)]);
    mockGetBoard.mockResolvedValue(board);
    const { stdin, unmount } = renderWithAct(
      React.createElement(KanbanPanel, {
        projectRoot: '/tmp/project',
        sessionId: '2026-08-26/sess_01TESTKANBANPANEL0000000',
        onClose,
        terminalWidth: 200,
      }),
    );
    await settle();
    // Ink-testing-library exposes `stdin.write`; the KanbanPanel listens
    // for `q` and `key.escape` to invoke onClose. Pressing 'q' must
    // propagate through the panel's useInput handler.
    await act(async () => {
      stdin.write('q');
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => unmount());
  });
});
