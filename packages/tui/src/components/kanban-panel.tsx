import type { Context } from '@wrongstack/core/agent';
import {
  addTask,
  copyTaskToBoard,
  createBoard,
  duplicateBoard,
  getBoard,
  type KanbanBoard,
  type KanbanBoardSummary,
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
import { Box, Text } from '../ink.js';
import { auditKanbanBoard, type KanbanAuditSummary } from '../kanban-audit.js';
import { isLeakedMouseInput } from '../mouse.js';
import { theme } from '../theme.js';
import type { PromptMode } from './kanban-panel-presentation.js';
import {
  AuditAlert,
  adjacentColumn,
  BoardColumns,
  BoardList,
  BoardSummary,
  CompactBoard,
  clamp,
  doneColumnId,
  isManagedBoard,
  nextBoard,
  nextManagedStage,
  PromptLine,
  stageForColumn,
  TaskDetail,
} from './kanban-panel-presentation.js';
import {
  KeyCap,
  MonitorShell,
  usePanelInput as useInput,
  useMonitorSize,
  usePanelShortcutsEnabled,
} from './monitor-shell.js';

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

export function KanbanPanel({
  projectRoot,
  sessionId,
  sessionContext,
  onClose,
  terminalWidth: widthOverride,
  initialBoardId,
}: KanbanPanelProps): React.ReactElement {
  const size = useMonitorSize();
  const terminalWidth = widthOverride ?? size.columns;
  const [showKeys, setShowKeys] = useState(false);
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
  // is pure, deterministic, and mirrors `packages/project-surfaces/src/kanban/kanban-cleaner.ts`.
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
  // Poll every 4 s. External changes are visible only after reading the shared
  // board; comparing the captured local updatedAt with itself skips all polls.
  useEffect(() => {
    const interval = setInterval(() => {
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
    if (key.ctrl || key.meta) return;
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
      if (input && !key.ctrl && !key.meta && input >= ' ' && !isLeakedMouseInput(input)) {
        setPrompt({ ...prompt, buffer: `${prompt.buffer}${input}` });
      }
      return;
    }

    // Letter/space shortcuts stay inert while the composer holds a draft
    // (broadcast useInput — the user is typing a message, not driving the
    // board). Esc, arrows, and Tab keep working either way.
    if (shortcutsEnabled && input === '?') {
      setShowKeys((value) => !value);
      return;
    }
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
    <MonitorShell
      accent={theme.accent}
      icon="▦"
      title="KANBAN"
      right={<Text dimColor>{boards.length} boards</Text>}
      footer={
        <Box gap={1} flexWrap="wrap">
          <KeyCap keepTogether keyName="n/p" label="board" />
          <KeyCap keepTogether keyName="Tab" label="task" />
          <KeyCap keepTogether keyName="?" label="keys" />
          <KeyCap keepTogether keyName="F12/Esc" label="close" />
        </Box>
      }
    >
      {board ? <Text wrap="truncate-end">{board.title}</Text> : null}

      {prompt ? <PromptLine prompt={prompt} /> : null}
      {notice && !prompt ? (
        <Text color="green" wrap="truncate">
          {notice}
        </Text>
      ) : null}
      {showKeys ? (
        <Box flexDirection="column">
          <Text>n/p board · Tab/Shift+Tab task</Text>
          <Text>←→ move · Space/D complete</Text>
          <Text>c create board · a add task</Text>
          <Text>d duplicate board · x delete task</Text>
          <Text>C copy · T transfer · r refresh</Text>
          <Text>? back · Ctrl+Y toggle · F12/Esc close</Text>
        </Box>
      ) : loading ? (
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
      ) : terminalWidth < 110 ? (
        <CompactBoard
          board={board}
          activeTaskId={activeTask?.id}
          rows={Math.max(1, size.rows - 8)}
          width={size.contentWidth}
        />
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
    </MonitorShell>
  );
}
export {
  computeBoardColumnLayout,
  nextManagedStage,
  stageForColumn,
  summarizeGoalMetrics,
  summarizeSuccessCriteria,
} from './kanban-panel-presentation.js';
