import type { Context } from '@wrongstack/core/agent';
import {
  addTask,
  copyTaskToBoard,
  createBoard,
  describeKanbanBoundary,
  duplicateBoard,
  getBoard,
  type KanbanBoard,
  type KanbanBoardSummary,
  type KanbanLifecycleStage,
  type KanbanLink,
  type KanbanTask,
  listBoards,
  moveTask,
  removeTask,
  transferTaskToBoard,
  transitionTask,
  updateTask,
} from '@wrongstack/kanban';
import { applySessionKanbanTaskToSource } from '@wrongstack/tools/session-kanban';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import {
  auditKanbanBoard,
  type KanbanAuditSeverity,
  type KanbanAuditSummary,
  summarizeAuditHeadline,
  topAuditIssues,
} from '../kanban-audit.js';
import { theme } from '../theme.js';
import { usePanelShortcutsEnabled } from './monitor-shell.js';

interface KanbanPanelProps {
  projectRoot: string;
  /**
   * Session driving the panel. Required: every board mutation the panel makes
   * writes a durable event attributed to this session.
   */
  sessionId: string;
  sessionContext?: Context | undefined;
  onClose: () => void;
  /**
   * Host terminal width in columns. Used to choose how many columns the
   * board view shows side-by-side. Defaults to a comfortable 100-col layout.
   */
  terminalWidth?: number | undefined;
  /**
   * When the panel opens, the board whose id matches this prefix is
   * auto-selected. Wired by the App via the `onBoardFocus` ref so
   * `/kanban use <boardId>` and the Goal → Kanban bridge land on the
   * right board without manual `n`/`p` navigation.
   */
  initialBoardId?: string | undefined;
}

type PromptMode =
  | { kind: 'createBoard'; buffer: string }
  | { kind: 'addTask'; buffer: string }
  | { kind: 'confirmDeleteTask'; task: KanbanTask }
  | { kind: 'transitionTask'; task: KanbanTask; to: KanbanLifecycleStage; buffer: string };

export function KanbanPanel({
  projectRoot,
  sessionId,
  sessionContext,
  onClose,
  terminalWidth = 100,
  initialBoardId,
}: KanbanPanelProps): React.ReactElement {
  // Every mutation below stamps its event with the session driving the panel.
  const eventContext = { sessionId, actor: 'tui-operator' };
  const [boards, setBoards] = useState<KanbanBoardSummary[]>([]);
  const [selectedBoard, setSelectedBoard] = useState(0);
  const [selectedTask, setSelectedTask] = useState(0);
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptMode | null>(null);

  const sortedColumns = useMemo(
    () => [...(board?.columns ?? [])].sort((a, b) => a.order - b.order),
    [board],
  );
  const visibleTasks = useMemo(() => {
    if (!board) return [];
    return sortedColumns.flatMap((column) =>
      board.tasks.filter((task) => task.columnId === column.id).sort((a, b) => a.order - b.order),
    );
  }, [board, sortedColumns]);
  const activeTask = visibleTasks[selectedTask] ?? null;
  const transferTarget = nextBoard(boards, board?.id);

  // Kanban Cleaner audit — computed once per board change so the header
  // badge and top-issue list stay in sync with the loaded data. The audit
  // is pure, deterministic, and mirrors `packages/webui/src/lib/kanban-cleaner.ts`.
  const audit: KanbanAuditSummary | null = useMemo(() => {
    if (!board) return null;
    // `now` is captured at memoization time; tests pin deterministic clocks.
    return auditKanbanBoard(board, { now: new Date() });
  }, [board]);

  async function load(
    nextBoardIndex = selectedBoard,
    nextTaskIndex = selectedTask,
    options: {
      preferSession?: boolean | undefined;
      quiet?: boolean | undefined;
      boardId?: string | undefined;
    } = {},
  ) {
    if (!options.quiet) setLoading(true);
    setError(null);
    try {
      const summaries = await listBoards(projectRoot);
      setBoards(summaries);
      const preferredIndex = options.boardId
        ? summaries.findIndex((candidate) => candidate.id === options.boardId)
        : options.preferSession && sessionId
          ? summaries.findIndex((candidate) => candidate.tags?.includes(`session:${sessionId}`))
          : -1;
      const clampedBoard =
        preferredIndex >= 0
          ? preferredIndex
          : clamp(nextBoardIndex, 0, Math.max(0, summaries.length - 1));
      setSelectedBoard(clampedBoard);
      const active = summaries[clampedBoard];
      const loaded = active ? await getBoard(projectRoot, active.id) : null;
      setBoard(loaded);
      const taskCount = loaded?.tasks.length ?? 0;
      setSelectedTask(clamp(nextTaskIndex, 0, Math.max(0, taskCount - 1)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options.quiet) setLoading(false);
    }
  }

  async function syncSource(
    nextBoard: KanbanBoard | null,
    taskId: string,
    remove = false,
    fallbackTask: KanbanTask | null = activeTask,
  ) {
    if (!sessionContext) return;
    const task = nextBoard?.tasks.find((candidate) => candidate.id === taskId) ?? fallbackTask;
    if (task) await applySessionKanbanTaskToSource(sessionContext, task, { remove });
  }

  async function runMutation(
    fn: () => Promise<string | null | undefined>,
    selection: { boardIndex?: number | undefined; taskIndex?: number | undefined } = {},
  ) {
    setLoading(true);
    setError(null);
    try {
      const message = await fn();
      setNotice(message ?? null);
      await load(selection.boardIndex ?? selectedBoard, selection.taskIndex ?? selectedTask);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function commitPrompt() {
    if (!prompt) return;
    if (prompt.kind === 'confirmDeleteTask') {
      setPrompt(null);
      await runMutation(async () => {
        if (!board) return null;
        const nextBoard = await removeTask(projectRoot, board.id, prompt.task.id, eventContext);
        await syncSource(nextBoard, prompt.task.id, true, prompt.task);
        return `Deleted task: ${prompt.task.title}`;
      });
      return;
    }
    if (prompt.kind === 'transitionTask') {
      const comment = prompt.buffer.trim();
      if (!comment) return; // empty comment keeps the prompt open
      const target = prompt.to;
      const task = prompt.task;
      setPrompt(null);
      await runMutation(async () => {
        if (!board) return null;
        const result = await transitionTask(projectRoot, board.id, task.id, {
          to: target,
          sessionId,
          actor: 'tui-operator',
          comment,
        });
        if (result) await syncSource(result.board, task.id, false, task);
        return result
          ? `Transitioned "${task.title}" → ${target}`
          : 'Transition failed (task or board not found)';
      });
      return;
    }
    const value = prompt.buffer.trim();
    if (!value) return;
    const kind = prompt.kind;
    setPrompt(null);
    await runMutation(
      async () => {
        if (kind === 'createBoard') {
          const created = await createBoard(projectRoot, { title: value });
          return `Created board: ${created.title}`;
        }
        if (!board) return null;
        const added = await addTask(
          projectRoot,
          board.id,
          { title: value, columnId: sortedColumns[0]?.id ?? 'backlog' },
          eventContext,
        );
        return added ? `Added task: ${added.task.title}` : 'Task add failed';
      },
      kind === 'createBoard' ? { boardIndex: 0, taskIndex: 0 } : { taskIndex: board?.tasks.length },
    );
  }

  useEffect(() => {
    // When a caller (slash command / Goal bridge) hands us an explicit
    // `initialBoardId`, prefer it over the session-tag fallback so the
    // panel opens on the requested board. The `boardId` option in `load`
    // lets `loadBoardSummaries` jump straight to the matching summary's
    // index without requiring the user to navigate.
    if (initialBoardId) {
      void load(0, 0, { boardId: initialBoardId });
    } else {
      void load(0, 0, { preferSession: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, sessionId, initialBoardId]);

  // Todo/task/plan mirrors write directly to the shared board file. Keep the
  // TUI panel live without requiring the user to press R after every tool call.
  // Throttled to 4 s (was 1.5 s) and skipped when the board's `updatedAt`
  // matches the last-seen value, so an idle board costs zero IPC traffic.
  useEffect(() => {
    let lastSeenUpdatedAt = board?.updatedAt;
    const interval = setInterval(() => {
      const current = board?.updatedAt;
      if (current && current === lastSeenUpdatedAt) return;
      lastSeenUpdatedAt = current;
      void load(selectedBoard, selectedTask, {
        quiet: true,
        boardId: board?.id,
        preferSession: !board,
      });
    }, 4_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, sessionId, board?.id, selectedBoard, selectedTask]);

  const shortcutsEnabled = usePanelShortcutsEnabled();
  useInput((input, key) => {
    if (prompt) {
      if (key.escape) {
        setPrompt(null);
        return;
      }
      if (prompt.kind === 'confirmDeleteTask') {
        if (input.toLowerCase() === 'y') void commitPrompt();
        else if (input.toLowerCase() === 'n') setPrompt(null);
        return;
      }
      if (key.return || input === '\r' || input === '\n') {
        void commitPrompt();
        return;
      }
      if (key.backspace || key.delete) {
        setPrompt({ ...prompt, buffer: prompt.buffer.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta && input >= ' ') {
        setPrompt({ ...prompt, buffer: `${prompt.buffer}${input}` });
      }
      return;
    }

    // Letter/space shortcuts stay inert while the composer holds a draft
    // (broadcast useInput — the user is typing a message, not driving the
    // board). Esc, arrows, and Tab keep working either way.
    if (key.escape || (shortcutsEnabled && input === 'q')) {
      onClose();
      return;
    }
    if (shortcutsEnabled && (input === 'r' || input === 'R')) {
      void load(selectedBoard, selectedTask);
      return;
    }
    if (shortcutsEnabled && input === 'c') {
      setPrompt({ kind: 'createBoard', buffer: '' });
      return;
    }
    if (shortcutsEnabled && input === 'a' && board) {
      setPrompt({ kind: 'addTask', buffer: '' });
      return;
    }
    if (((shortcutsEnabled && input === 'n') || key.downArrow) && boards.length > 0) {
      void load(clamp(selectedBoard + 1, 0, boards.length - 1), 0);
      return;
    }
    if (((shortcutsEnabled && input === 'p') || key.upArrow) && boards.length > 0) {
      void load(clamp(selectedBoard - 1, 0, boards.length - 1), 0);
      return;
    }
    if (key.shift && key.tab && visibleTasks.length > 0) {
      setSelectedTask((idx) => (idx - 1 + visibleTasks.length) % visibleTasks.length);
      return;
    }
    if (key.tab && visibleTasks.length > 0) {
      setSelectedTask((idx) => (idx + 1) % visibleTasks.length);
      return;
    }
    if (key.rightArrow && board && activeTask) {
      if (isManagedBoard(board)) {
        // Managed cards advance one stage at a time via transitionTask; the
        // comment prompt collects the required audit comment before we call.
        const current = stageForColumn(board, activeTask.columnId);
        const target = current ? nextManagedStage(current) : null;
        if (target) {
          setPrompt({ kind: 'transitionTask', task: activeTask, to: target, buffer: '' });
        } else {
          setNotice('Task is already at the final stage (done).');
        }
      } else {
        const nextColumn = adjacentColumn(sortedColumns, activeTask.columnId, 1);
        if (nextColumn) {
          void runMutation(async () => {
            const nextBoard = await moveTask(
              projectRoot,
              board.id,
              activeTask.id,
              nextColumn.id,
              undefined,
              eventContext,
            );
            await syncSource(nextBoard, activeTask.id);
            return `Moved to ${nextColumn.title}`;
          });
        }
      }
      return;
    }
    if (key.leftArrow && board && activeTask) {
      if (isManagedBoard(board)) {
        setNotice('Managed boards advance forward only; use the kanban tool to repair backward.');
      } else {
        const prevColumn = adjacentColumn(sortedColumns, activeTask.columnId, -1);
        if (prevColumn) {
          void runMutation(async () => {
            const nextBoard = await moveTask(
              projectRoot,
              board.id,
              activeTask.id,
              prevColumn.id,
              undefined,
              eventContext,
            );
            await syncSource(nextBoard, activeTask.id);
            return `Moved to ${prevColumn.title}`;
          });
        }
      }
      return;
    }
    if (shortcutsEnabled && (input === ' ' || input === 'D') && board && activeTask) {
      if (isManagedBoard(board)) {
        setNotice(
          'Managed cards advance via → or t (transition). Use a non-managed board for direct status edits.',
        );
        return;
      }
      void runMutation(async () => {
        const nextBoard = await updateTask(
          projectRoot,
          board.id,
          activeTask.id,
          { status: 'completed', columnId: doneColumnId(board) ?? activeTask.columnId },
          eventContext,
        );
        await syncSource(nextBoard, activeTask.id);
        return `Completed task: ${activeTask.title}`;
      });
      return;
    }
    if (shortcutsEnabled && input === 'b' && board && activeTask) {
      if (isManagedBoard(board)) {
        setNotice(
          'Managed cards advance via → or t (transition); "blocked" is a status, not a lifecycle stage.',
        );
        return;
      }
      void runMutation(async () => {
        const nextBoard = await updateTask(
          projectRoot,
          board.id,
          activeTask.id,
          { status: 'blocked' },
          eventContext,
        );
        await syncSource(nextBoard, activeTask.id);
        return `Blocked task: ${activeTask.title}`;
      });
      return;
    }
    // `t` opens the transition prompt for the active managed card. It mirrors
    // the right-arrow path so users have an explicit shortcut regardless of
    // the column cursor position.
    if (shortcutsEnabled && input === 't' && board && activeTask && isManagedBoard(board)) {
      const current = stageForColumn(board, activeTask.columnId);
      const target = current ? nextManagedStage(current) : null;
      if (!target) {
        setNotice('Task is already at the final stage (done).');
      } else {
        setPrompt({ kind: 'transitionTask', task: activeTask, to: target, buffer: '' });
      }
      return;
    }
    if (shortcutsEnabled && input === 'x' && activeTask) {
      setPrompt({ kind: 'confirmDeleteTask', task: activeTask });
      return;
    }
    if (shortcutsEnabled && input === 'd' && board) {
      void runMutation(
        async () => {
          const duplicated = await duplicateBoard(projectRoot, board.id, {
            title: `${board.title} Copy`,
            preserveAssignment: true,
          });
          return duplicated ? `Duplicated board: ${duplicated.title}` : 'Board duplicate failed';
        },
        { boardIndex: 0, taskIndex: selectedTask },
      );
      return;
    }
    if (shortcutsEnabled && input === 'C' && board && activeTask && transferTarget) {
      void runMutation(async () => {
        await copyTaskToBoard(projectRoot, board.id, activeTask.id, transferTarget.id, {
          eventContext,
        });
        return `Copied task to ${transferTarget.title}`;
      });
      return;
    }
    if (shortcutsEnabled && input === 'T' && board && activeTask && transferTarget) {
      void runMutation(async () => {
        await transferTaskToBoard(projectRoot, board.id, activeTask.id, transferTarget.id, {
          preserveAssignment: true,
          eventContext,
        });
        return `Transferred task to ${transferTarget.title}`;
      });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color="cyan">
          KANBAN
        </Text>
        <Text dimColor>|</Text>
        <Text dimColor>
          {boards.length} board{boards.length === 1 ? '' : 's'}
        </Text>
        {board ? (
          <>
            <Text dimColor>|</Text>
            <Text>{board.title}</Text>
          </>
        ) : null}
        <Text dimColor>
          | n/p board | Tab task | ←→ move | c/a/d create/add/dup | C/T copy/transfer | Ctrl+Y
          toggle | Esc close
        </Text>
      </Box>

      {prompt ? <PromptLine prompt={prompt} /> : null}
      {notice && !prompt ? (
        <Text color="green" wrap="truncate">
          {notice}
        </Text>
      ) : null}
      {loading ? (
        <Text dimColor>Loading kanban...</Text>
      ) : error ? (
        <Text color="red">Error: {error}</Text>
      ) : !board ? (
        <Box flexDirection="column">
          <Text dimColor>No kanban boards yet.</Text>
          <Text dimColor>
            Press <Text color={theme.accent}>c</Text> to create one, or run{' '}
            <Text color={theme.accent}>/kanban create &lt;title&gt;</Text> in the composer.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <BoardSummary board={board} target={transferTarget} />
          {audit ? <AuditAlert summary={audit} /> : null}
          <Box flexDirection="row" gap={1}>
            <BoardList boards={boards} selected={selectedBoard} />
            <BoardColumns
              board={board}
              activeTaskId={activeTask?.id}
              terminalWidth={terminalWidth}
            />
            <TaskDetail board={board} task={activeTask} target={transferTarget} />
          </Box>
        </Box>
      )}
    </Box>
  );
}

function PromptLine({ prompt }: { prompt: PromptMode }): React.ReactElement {
  if (prompt.kind === 'confirmDeleteTask') {
    return <Text color="yellow">Delete "{prompt.task.title}"? y/n</Text>;
  }
  if (prompt.kind === 'transitionTask') {
    return (
      <Text>
        <Text color="magenta">
          {prompt.to.toUpperCase()} "{prompt.task.title}":{' '}
        </Text>
        {prompt.buffer}
        <Text dimColor>
          _ <Text dimColor>(Esc cancel · Enter confirm — comment required)</Text>
        </Text>
      </Text>
    );
  }
  const label = prompt.kind === 'createBoard' ? 'New board title' : 'New task title';
  return (
    <Text>
      <Text color="cyan">{label}: </Text>
      {prompt.buffer}
      <Text dimColor>_</Text>
    </Text>
  );
}

function BoardList({
  boards,
  selected,
}: {
  boards: KanbanBoardSummary[];
  selected: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={24} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        Boards
      </Text>
      {boards.slice(0, 12).map((item, index) => (
        <Text key={item.id} color={index === selected ? 'cyan' : undefined} wrap="truncate">
          {index === selected ? '>' : ' '} {item.title} ({item.taskCount})
        </Text>
      ))}
      {boards.length > 12 ? <Text dimColor>... {boards.length - 12} more</Text> : null}
    </Box>
  );
}

/**
 * Pure, deterministic layout math for the kanban board's column view.
 *
 * Reserves horizontal space for the chrome that surrounds the columns
 * (board list panel + task detail panel + gaps + outer border), then
 * picks the largest column count that still keeps every column at least
 * `minColumnWidth` cols wide, and finally shrinks each column's width to
 * match the available budget (never below `minColumnWidth`).
 *
 * Exported so Sprint 2's regression tests can pin the math down without
 * mounting Ink.
 */
export function computeBoardColumnLayout(
  totalColumns: number,
  terminalWidth: number,
): { visibleColumnCount: number; columnWidth: number; overflow: number } {
  const chromeCols = 24 + 1 + 34 + 1 + 4;
  const minColumnWidth = 16;
  const preferredColumnWidth = 26;
  const maxColumnsForWidth = Math.max(
    2,
    Math.floor((terminalWidth - chromeCols + 1) / (minColumnWidth + 1)),
  );
  const visibleColumnCount = Math.max(2, Math.min(totalColumns, Math.min(5, maxColumnsForWidth)));
  const columnWidth = Math.max(
    minColumnWidth,
    Math.min(
      preferredColumnWidth,
      Math.floor((terminalWidth - chromeCols - (visibleColumnCount - 1)) / visibleColumnCount),
    ),
  );
  const overflow = Math.max(0, totalColumns - visibleColumnCount);
  return { visibleColumnCount, columnWidth, overflow };
}

function BoardColumns({
  board,
  activeTaskId,
  terminalWidth = 100,
}: {
  board: KanbanBoard;
  activeTaskId?: string | undefined;
  terminalWidth?: number | undefined;
}): React.ReactElement {
  const { visibleColumnCount, columnWidth, overflow } = computeBoardColumnLayout(
    board.columns.length,
    terminalWidth,
  );
  const isManaged = board.lifecycle?.mode === 'managed';

  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {[...board.columns]
        .sort((a, b) => a.order - b.order)
        .slice(0, visibleColumnCount)
        .map((column) => {
          const allTasks = board.tasks
            .filter((task) => task.columnId === column.id)
            .sort((a, b) => a.order - b.order);
          const stage = isManaged ? stageForColumn(board, column.id) : null;
          const indicator = stage ? stageToIndicator(stage) : null;
          return (
            <Box key={column.id} flexDirection="column" width={columnWidth}>
              <Box flexDirection="row" gap={1}>
                <Text bold color="cyan" wrap="truncate">
                  {column.title} ({allTasks.length})
                </Text>
                {indicator ? (
                  <Text color={indicator.color} wrap="truncate">
                    {indicator.glyph} {stage}
                  </Text>
                ) : null}
              </Box>
              {allTasks.length === 0 ? (
                <Text dimColor> empty</Text>
              ) : (
                allTasks.slice(0, 8).map((task) => (
                  <Text
                    key={task.id}
                    color={task.id === activeTaskId ? 'cyan' : undefined}
                    wrap="truncate"
                  >
                    {task.id === activeTaskId ? '>' : ' '} {statusIcon(task.status)} {task.title}
                    {task.assignedAgent ? <Text dimColor> @{task.assignedAgent}</Text> : null}
                  </Text>
                ))
              )}
              {allTasks.length > 8 ? <Text dimColor> ... {allTasks.length - 8} more</Text> : null}
            </Box>
          );
        })}
      {overflow > 0 ? (
        <Box flexDirection="column" width={columnWidth}>
          <Text dimColor wrap="truncate">
            + {overflow} more column{overflow === 1 ? '' : 's'}
          </Text>
          <Text dimColor>(resize terminal or use n/p)</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Whether a board enforces the managed Kanban Agent lifecycle. Managed boards
 * reject free-form status/column writes (see `assertManagedTaskPatchAllowed`
 * in `@wrongstack/kanban`), so the TUI must route progress through
 * `transitionTask` rather than `moveTask`/`updateTask`.
 */
function isManagedBoard(board: KanbanBoard | null): boolean {
  return board?.lifecycle?.mode === 'managed';
}

const MANAGED_STAGE_ORDER: readonly KanbanLifecycleStage[] = [
  'backlog',
  'todo',
  'running',
  'review',
  'done',
];

/**
 * The next stage a managed card may advance to, or null when the card is
 * already at the terminal `done` stage (or the current stage is unknown).
 * The domain only allows one-step forward transitions; callers must keep
 * this in lockstep with `KANBAN_AGENT_STAGES` in `@wrongstack/kanban`.
 *
 * Exported so unit tests can pin the stage order without rendering the panel.
 */
export function nextManagedStage(current: KanbanLifecycleStage): KanbanLifecycleStage | null {
  const idx = MANAGED_STAGE_ORDER.indexOf(current);
  return idx >= 0 && idx < MANAGED_STAGE_ORDER.length - 1 ? MANAGED_STAGE_ORDER[idx + 1]! : null;
}

/**
 * Look up the lifecycle stage that owns the given column under a managed
 * Kanban Agent board. Returns null when the board is not managed, or when
 * the column is not mapped to any of the five canonical stages (treated
 * as a legacy/custom column by the renderer).
 */
export function stageForColumn(
  board: Pick<KanbanBoard, 'lifecycle'>,
  columnId: string,
): KanbanLifecycleStage | null {
  const policy = board.lifecycle;
  if (policy?.mode !== 'managed') return null;
  const stages: readonly KanbanLifecycleStage[] = ['backlog', 'todo', 'running', 'review', 'done'];
  return stages.find((stage) => policy.columns[stage] === columnId) ?? null;
}

/**
 * Map a lifecycle stage to the visual indicator shown in the column
 * header. Mirrors the WebUI palette so the same board reads the same in
 * either surface.
 */
function stageToIndicator(stage: KanbanLifecycleStage): {
  glyph: string;
  color: string;
} {
  switch (stage) {
    case 'backlog':
      return { glyph: '◷', color: 'gray' };
    case 'todo':
      return { glyph: '◳', color: 'blue' };
    case 'running':
      return { glyph: '◍', color: 'yellow' };
    case 'review':
      return { glyph: '◑', color: 'magenta' };
    case 'done':
      return { glyph: '✓', color: 'green' };
  }
}

function TaskDetail({
  board,
  task,
  target,
}: {
  board: KanbanBoard;
  task: KanbanTask | null;
  target?: KanbanBoardSummary | undefined;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width={34} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">
        Task
      </Text>
      {!task ? (
        <Text dimColor>No task selected.</Text>
      ) : (
        <>
          <Text wrap="truncate">{task.title}</Text>
          <Text dimColor>ID {task.id.slice(0, 8)}</Text>
          <Text>
            {task.priority.toUpperCase()} / {task.status}
          </Text>
          <Text dimColor>Column {columnTitle(board, task.columnId)}</Text>
          {task.dueDate ? <Text dimColor>Due {task.dueDate}</Text> : null}
          {task.lifecycle ? (
            <Text dimColor>
              Stage {task.lifecycle.currentStage} (since {task.lifecycle.stageEnteredAt})
            </Text>
          ) : null}
          {task.description ? <Text wrap="truncate">{task.description}</Text> : null}
          <Text color={task.boundary?.enabled || board.boundary?.enabled ? 'yellow' : 'gray'}>
            Scope {describeKanbanBoundary(task.boundary)}
            {board.boundary?.enabled ? ' + board ceiling' : ''}
          </Text>
          {(task.boundary?.allow ?? board.boundary?.allow)?.slice(0, 3).map((selector) => (
            <Text
              key={`${selector.kind}:${selector.path}:${selector.access}`}
              dimColor
              wrap="truncate"
            >
              {selector.access} {selector.kind}:{selector.path}
            </Text>
          ))}
          {task.assignment ? (
            <Text wrap="truncate">
              Agent {task.assignment.agentId ?? task.assignedAgent ?? task.assignment.role ?? '-'} /{' '}
              {task.assignment.status}
            </Text>
          ) : task.assignedAgent ? (
            <Text wrap="truncate">Agent {task.assignedAgent}</Text>
          ) : null}
          {task.dependsOn?.length ? <Text dimColor>Depends on {task.dependsOn.length}</Text> : null}
          {renderSuccessCriteria(task)}
          {renderGoalMetrics(task)}
          {renderLinks(task)}
          {target ? <Text dimColor>C/T target: {target.title}</Text> : null}
          <Text dimColor>
            {board.lifecycle?.mode === 'managed'
              ? '→/t transition | x delete'
              : 'space done | b block | x delete'}
          </Text>
        </>
      )}
    </Box>
  );
}

/**
 * Pure success-criteria summary string. Returns null when there are no
 * checks. Format: "Criteria N/M passed".
 */
export function summarizeSuccessCriteria(task: KanbanTask): string | null {
  if (!task.successCriteria || task.successCriteria.length === 0) return null;
  const passed = task.successCriteria.filter((c) => c.status === 'passed').length;
  const total = task.successCriteria.length;
  return `Criteria ${passed}/${total} passed`;
}

/** Render the success-criteria summary line, e.g. "Criteria 2/3 passed". */
function renderSuccessCriteria(task: KanbanTask): React.ReactElement | null {
  const summary = summarizeSuccessCriteria(task);
  if (!summary) return null;
  return <Text dimColor>{summary}</Text>;
}

/**
 * Pure goal-metrics rollup string. Returns null when there are no metrics.
 * Format: "Metrics 2 met · 1 missed · 0 waived · 0 pending" (zero counts
 * are skipped to keep the line short).
 */
export function summarizeGoalMetrics(task: KanbanTask): string | null {
  if (!task.goalMetrics || task.goalMetrics.length === 0) return null;
  const counts = { met: 0, missed: 0, waived: 0, pending: 0 };
  for (const metric of task.goalMetrics) {
    if (metric.status === 'met') counts.met++;
    else if (metric.status === 'missed') counts.missed++;
    else if (metric.status === 'waived') counts.waived++;
    else counts.pending++;
  }
  const parts: string[] = [];
  if (counts.met > 0) parts.push(`${counts.met} met`);
  if (counts.missed > 0) parts.push(`${counts.missed} missed`);
  if (counts.waived > 0) parts.push(`${counts.waived} waived`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  return `Metrics ${parts.join(' · ')}`;
}

/** Render a compact goal-metrics rollup — counts per status. */
function renderGoalMetrics(task: KanbanTask): React.ReactElement | null {
  const summary = summarizeGoalMetrics(task);
  if (!summary) return null;
  return <Text dimColor>{summary}</Text>;
}

/** Render each link on its own line, prefixed by its type icon. */
function renderLinks(task: KanbanTask): React.ReactElement | null {
  if (!task.links || task.links.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor>Links ({task.links.length})</Text>
      {task.links.slice(0, 4).map((link, i) => (
        <Text key={`${link.url}-${i}`} wrap="truncate">
          {linkIcon(link.type)} {link.title ?? link.url}
        </Text>
      ))}
      {task.links.length > 4 ? <Text dimColor>... {task.links.length - 4} more</Text> : null}
    </Box>
  );
}

function linkIcon(type: KanbanLink['type']): string {
  switch (type) {
    case 'issue':
      return '🐞';
    case 'pr':
      return '🔀';
    case 'doc':
      return '📄';
    case 'commit':
      return '📌';
    case 'design':
      return '🎨';
    case 'file':
      return '📎';
    case 'url':
      return '🔗';
    default:
      return '·';
  }
}

/**
 * Inline Kanban Cleaner summary — mirrors the WebUI's `KanbanCleanerAlert`
 * but pinned to the project root. Shows the headline counts at the top
 * of the panel and the top-3 issues, scoped per board so users see what
 * the Cleaner would flag without leaving the TUI.
 *
 * The component renders nothing when the audit is empty so a clean
 * board doesn't add visual noise.
 */
function AuditAlert({
  summary,
  topN = 3,
}: {
  summary: KanbanAuditSummary;
  topN?: number | undefined;
}): React.ReactElement | null {
  const headline = summarizeAuditHeadline(summary);
  if (!headline) return null;
  const issues = topAuditIssues(summary, topN);
  const badgeColor: string =
    summary.counts.error > 0 ? 'red' : summary.counts.warning > 0 ? 'yellow' : 'gray';

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={badgeColor}
      paddingX={1}
      marginBottom={1}
    >
      <Box flexDirection="row" gap={1}>
        <Text color={badgeColor} bold>
          ⚠ {headline}
        </Text>
      </Box>
      {issues.length > 0 ? (
        <Box flexDirection="column">
          {issues.map((issue, index) => (
            <Text
              key={`${issue.id}-${index}`}
              color={severityToneColor(issue.severity)}
              wrap="truncate"
            >
              {'  '}
              {severityGlyph(issue.severity)} {issue.taskTitle}: {issue.message}
            </Text>
          ))}
          {summary.issues.length > issues.length ? (
            <Text dimColor>{`  … and ${summary.issues.length - issues.length} more`}</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function severityGlyph(severity: KanbanAuditSeverity): string {
  return severity === 'error' ? '⨯' : '!';
}

function severityToneColor(severity: KanbanAuditSeverity): string {
  return severity === 'error' ? 'red' : 'yellow';
}

function BoardSummary({
  board,
  target,
}: {
  board: KanbanBoard;
  target?: KanbanBoardSummary | undefined;
}): React.ReactElement {
  const done = board.tasks.filter((task) => task.status === 'completed').length;
  return (
    <Box flexDirection="row" gap={1} marginBottom={1}>
      <Text dimColor>ID {board.id.slice(0, 8)}</Text>
      <Text dimColor>|</Text>
      <Text dimColor>{board.columns.length} columns</Text>
      <Text dimColor>|</Text>
      <Text dimColor>{board.tasks.length} tasks</Text>
      <Text dimColor>|</Text>
      <Text color={done === board.tasks.length && done > 0 ? 'green' : 'yellow'}>{done} done</Text>
      <Text dimColor>|</Text>
      <Text color={board.boundary?.enabled ? 'yellow' : 'gray'}>
        scope {describeKanbanBoundary(board.boundary)}
      </Text>
      {target ? (
        <>
          <Text dimColor>|</Text>
          <Text dimColor>next board: {target.title}</Text>
        </>
      ) : null}
    </Box>
  );
}

function nextBoard(
  boards: KanbanBoardSummary[],
  boardId: string | undefined,
): KanbanBoardSummary | undefined {
  if (!boardId || boards.length < 2) return undefined;
  const index = boards.findIndex((item) => item.id === boardId);
  if (index === -1) return boards.find((item) => item.id !== boardId);
  for (let offset = 1; offset < boards.length; offset++) {
    const candidate = boards[(index + offset) % boards.length];
    if (candidate && candidate.id !== boardId) return candidate;
  }
  return undefined;
}

function adjacentColumn(
  columns: KanbanBoard['columns'],
  columnId: string,
  delta: -1 | 1,
): KanbanBoard['columns'][number] | undefined {
  const index = columns.findIndex((column) => column.id === columnId);
  if (index === -1) return undefined;
  return columns[index + delta];
}

function doneColumnId(board: KanbanBoard): string | undefined {
  return board.columns.find((column) =>
    ['done', 'completed', 'finished'].includes(column.id.toLowerCase()),
  )?.id;
}

function columnTitle(board: KanbanBoard, columnId: string): string {
  return board.columns.find((column) => column.id === columnId)?.title ?? columnId;
}

function statusIcon(status: string): string {
  if (status === 'completed') return 'x';
  if (status === 'blocked') return '!';
  if (status === 'in_progress') return '>';
  if (status === 'failed') return '!';
  if (status === 'review') return '?';
  return '-';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
