import type { Context } from '@wrongstack/core';
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
  updateTask,
} from '@wrongstack/kanban';
import { applySessionKanbanTaskToSource } from '@wrongstack/tools/session-kanban';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';

export interface KanbanPanelProps {
  projectRoot: string;
  sessionId?: string | null | undefined;
  sessionContext?: Context | undefined;
  onClose: () => void;
}

type PromptMode =
  | { kind: 'createBoard'; buffer: string }
  | { kind: 'addTask'; buffer: string }
  | { kind: 'confirmDeleteTask'; task: KanbanTask };

export function KanbanPanel({
  projectRoot,
  sessionId,
  sessionContext,
  onClose,
}: KanbanPanelProps): React.ReactElement {
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
        const nextBoard = await removeTask(projectRoot, board.id, prompt.task.id);
        await syncSource(nextBoard, prompt.task.id, true, prompt.task);
        return `Deleted task: ${prompt.task.title}`;
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
        const added = await addTask(projectRoot, board.id, {
          title: value,
          columnId: sortedColumns[0]?.id ?? 'backlog',
        });
        return added ? `Added task: ${added.task.title}` : 'Task add failed';
      },
      kind === 'createBoard' ? { boardIndex: 0, taskIndex: 0 } : { taskIndex: board?.tasks.length },
    );
  }

  useEffect(() => {
    void load(0, 0, { preferSession: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, sessionId]);

  // Todo/task/plan mirrors write directly to the shared board file. Keep the
  // TUI panel live without requiring the user to press R after every tool call.
  useEffect(() => {
    const interval = setInterval(() => {
      void load(selectedBoard, selectedTask, {
        quiet: true,
        boardId: board?.id,
        preferSession: !board,
      });
    }, 1_500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, sessionId, board?.id, selectedBoard, selectedTask]);

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

    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (input === 'r' || input === 'R') {
      void load(selectedBoard, selectedTask);
      return;
    }
    if (input === 'c') {
      setPrompt({ kind: 'createBoard', buffer: '' });
      return;
    }
    if (input === 'a' && board) {
      setPrompt({ kind: 'addTask', buffer: '' });
      return;
    }
    if ((input === 'n' || key.downArrow) && boards.length > 0) {
      void load(clamp(selectedBoard + 1, 0, boards.length - 1), 0);
      return;
    }
    if ((input === 'p' || key.upArrow) && boards.length > 0) {
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
      const nextColumn = adjacentColumn(sortedColumns, activeTask.columnId, 1);
      if (nextColumn) {
        void runMutation(async () => {
          const nextBoard = await moveTask(projectRoot, board.id, activeTask.id, nextColumn.id);
          await syncSource(nextBoard, activeTask.id);
          return `Moved to ${nextColumn.title}`;
        });
      }
      return;
    }
    if (key.leftArrow && board && activeTask) {
      const prevColumn = adjacentColumn(sortedColumns, activeTask.columnId, -1);
      if (prevColumn) {
        void runMutation(async () => {
          const nextBoard = await moveTask(projectRoot, board.id, activeTask.id, prevColumn.id);
          await syncSource(nextBoard, activeTask.id);
          return `Moved to ${prevColumn.title}`;
        });
      }
      return;
    }
    if ((input === ' ' || input === 'D') && board && activeTask) {
      void runMutation(async () => {
        const nextBoard = await updateTask(projectRoot, board.id, activeTask.id, {
          status: 'completed',
          columnId: doneColumnId(board) ?? activeTask.columnId,
        });
        await syncSource(nextBoard, activeTask.id);
        return `Completed task: ${activeTask.title}`;
      });
      return;
    }
    if (input === 'b' && board && activeTask) {
      void runMutation(async () => {
        const nextBoard = await updateTask(projectRoot, board.id, activeTask.id, {
          status: 'blocked',
        });
        await syncSource(nextBoard, activeTask.id);
        return `Blocked task: ${activeTask.title}`;
      });
      return;
    }
    if (input === 'x' && activeTask) {
      setPrompt({ kind: 'confirmDeleteTask', task: activeTask });
      return;
    }
    if (input === 'd' && board) {
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
    if (input === 'C' && board && activeTask && transferTarget) {
      void runMutation(async () => {
        await copyTaskToBoard(projectRoot, board.id, activeTask.id, transferTarget.id);
        return `Copied task to ${transferTarget.title}`;
      });
      return;
    }
    if (input === 'T' && board && activeTask && transferTarget) {
      void runMutation(async () => {
        await transferTaskToBoard(projectRoot, board.id, activeTask.id, transferTarget.id, {
          preserveAssignment: true,
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
          | n/p board | Tab task | left/right move | c/a/d create/add/dup | C/T copy/transfer | Esc
          close
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
            Press <Text color={theme.accent}>c</Text> to create one, or use{' '}
            <Text color={theme.accent}>/kanban create &lt;title&gt;</Text>.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <BoardSummary board={board} target={transferTarget} />
          <Box flexDirection="row" gap={1}>
            <BoardList boards={boards} selected={selectedBoard} />
            <BoardColumns board={board} activeTaskId={activeTask?.id} />
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

function BoardColumns({
  board,
  activeTaskId,
}: {
  board: KanbanBoard;
  activeTaskId?: string | undefined;
}): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      {[...board.columns]
        .sort((a, b) => a.order - b.order)
        .slice(0, 5)
        .map((column) => {
          const allTasks = board.tasks
            .filter((task) => task.columnId === column.id)
            .sort((a, b) => a.order - b.order);
          return (
            <Box key={column.id} flexDirection="column" width={26}>
              <Text bold color="cyan" wrap="truncate">
                {column.title} ({allTasks.length})
              </Text>
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
    </Box>
  );
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
          {task.description ? <Text wrap="truncate">{task.description}</Text> : null}
          {task.assignment ? (
            <Text wrap="truncate">
              Agent {task.assignment.agentId ?? task.assignedAgent ?? task.assignment.role ?? '-'} /{' '}
              {task.assignment.status}
            </Text>
          ) : task.assignedAgent ? (
            <Text wrap="truncate">Agent {task.assignedAgent}</Text>
          ) : null}
          {task.dependsOn?.length ? <Text dimColor>Depends on {task.dependsOn.length}</Text> : null}
          {target ? <Text dimColor>C/T target: {target.title}</Text> : null}
          <Text dimColor>space done | b block | x delete</Text>
        </>
      )}
    </Box>
  );
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
