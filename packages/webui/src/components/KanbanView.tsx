import type { KanbanBoard, KanbanColumn, KanbanTask } from '@wrongstack/core';
import {
  ArrowLeft,
  Check,
  Columns3,
  Copy,
  MoveRight,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useKanbanStore } from '@/stores';

export function KanbanView({ onClose }: { onClose?: (() => void) | undefined }) {
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const { boards, activeBoardId, activeBoard, loading, error, queueHealth, setLoading, setActiveBoardId } =
    useKanbanStore();
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);

  const ws = useMemo(() => getWSClient(wsUrl), [wsUrl]);
  const selectedTask = activeBoard?.tasks.find((task) => task.id === selectedTaskId) ?? null;

  const runningCostTotal = useMemo(() => {
    if (!activeBoard) return 0;
    return activeBoard.tasks
      .filter(
        (t) =>
          t.status === 'in_progress' || t.assignment?.status === 'running' || t.assignment?.status === 'queued',
      )
      .reduce((sum, t) => sum + (t.costCeilingUsd ?? 0), 0);
  }, [activeBoard]);

  const sendKanban = (type: `kanban.${string}`, payload: Record<string, unknown> = {}) => {
    setLoading(true);
    ws.send({ type, payload });
  };

  const refreshBoards = () => sendKanban('kanban.list');
  const refreshBoard = (boardId = activeBoardId) => {
    if (boardId) sendKanban('kanban.get', { boardId });
  };

  useEffect(() => {
    refreshBoards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeBoardId && boards[0]?.id) {
      setActiveBoardId(boards[0].id);
      sendKanban('kanban.get', { boardId: boards[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards, activeBoardId, setActiveBoardId]);

  useEffect(() => {
    if (
      activeBoard &&
      selectedTaskId &&
      !activeBoard.tasks.some((task) => task.id === selectedTaskId)
    ) {
      setSelectedTaskId(null);
    }
  }, [activeBoard, selectedTaskId]);

  useEffect(() => {
    if (activeBoardId) sendKanban('kanban.health', { boardId: activeBoardId });
  }, [activeBoardId]);

  const createBoard = () => {
    const title = newBoardTitle.trim();
    if (!title) return;
    setNewBoardTitle('');
    sendKanban('kanban.create', { title });
  };

  const createTask = () => {
    if (!activeBoard) return;
    const title = newTaskTitle.trim();
    if (!title) return;
    setNewTaskTitle('');
    sendKanban('kanban.task.add', {
      boardId: activeBoard.id,
      title,
      columnId: activeBoard.columns[0]?.id ?? 'backlog',
    });
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
  };

  const createColumn = () => {
    if (!activeBoard) return;
    const title = newColumnTitle.trim();
    if (!title) return;
    setNewColumnTitle('');
    sendKanban('kanban.column.add', { boardId: activeBoard.id, title });
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
  };

  const deleteBoard = () => {
    if (!activeBoard) return;
    sendKanban('kanban.delete', { boardId: activeBoard.id });
    window.setTimeout(refreshBoards, 150);
  };

  const duplicateBoard = () => {
    if (!activeBoard) return;
    sendKanban('kanban.duplicate', {
      boardId: activeBoard.id,
      title: `${activeBoard.title} Copy`,
    });
    window.setTimeout(refreshBoards, 150);
  };

  const deleteTask = (task: KanbanTask) => {
    if (!activeBoard) return;
    sendKanban('kanban.task.remove', { boardId: activeBoard.id, taskId: task.id });
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
  };

  const moveTask = (taskId: string, columnId: string) => {
    if (!activeBoard) return;
    sendKanban('kanban.task.move', { boardId: activeBoard.id, taskId, columnId });
    window.setTimeout(() => refreshBoard(activeBoard.id), 150);
  };

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="flex w-[280px] shrink-0 flex-col border-r bg-card/40">
        <div className="flex h-12 items-center gap-2 border-b px-3">
          <button
            type="button"
            title="Back"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft size={16} />
          </button>
          <Columns3 size={17} className="text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">Kanban</div>
            <div className="truncate text-[11px] text-muted-foreground">{boards.length} boards</div>
          </div>
          <button
            type="button"
            title="Refresh"
            onClick={refreshBoards}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>

        <div className="flex gap-1 border-b p-2">
          <input
            value={newBoardTitle}
            onChange={(e) => setNewBoardTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createBoard();
            }}
            placeholder="New board"
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
          <button
            type="button"
            title="Create board"
            onClick={createBoard}
            className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {boards.map((board) => (
            <button
              key={board.id}
              type="button"
              onClick={() => {
                setActiveBoardId(board.id);
                sendKanban('kanban.get', { boardId: board.id });
              }}
              className={cn(
                'mb-1 w-full rounded-md px-2 py-2 text-left transition-colors',
                activeBoardId === board.id
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <div className="truncate text-sm font-medium">{board.title}</div>
              <div className="mt-0.5 flex items-center justify-between text-[11px]">
                <span>{board.taskCount} tasks</span>
                <span>{board.completedTaskCount} done</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">
              {activeBoard?.title ?? 'No board selected'}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {activeBoard
                ? `${activeBoard.columns.length} columns / ${activeBoard.tasks.length} tasks`
                : 'Create or select a board'}
            </div>
          </div>
          {activeBoard && (
            <>
              <input
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createTask();
                }}
                placeholder="New task"
                className="h-8 w-56 rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                title="Add task"
                onClick={createTask}
                className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Plus size={16} />
              </button>
              <input
                value={newColumnTitle}
                onChange={(e) => setNewColumnTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createColumn();
                }}
                placeholder="New column"
                className="h-8 w-44 rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                title="Add column"
                onClick={createColumn}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Columns3 size={16} />
              </button>
              <button
                type="button"
                title="Duplicate board"
                onClick={duplicateBoard}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Copy size={16} />
              </button>
              <button
                type="button"
                title="Delete board"
                onClick={deleteBoard}
                className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 size={16} />
              </button>
            </>
          )}
        </header>

        {error && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 text-sm text-destructive">
            <X size={15} />
            <span className="truncate">{error}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
          {activeBoard ? (
            <>
              {queueHealth && (
                <div className="flex shrink-0 items-center gap-4 border-b px-4 py-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Queue health</span>
                  {queueHealth.counts.ready > 0 && (
                    <span title="Claimable tasks" className="inline-flex items-center gap-1 text-emerald-500">
                      {queueHealth.counts.ready} ready
                    </span>
                  )}
                  {queueHealth.counts.running > 0 && (
                    <span title="Running assignments" className="inline-flex items-center gap-1 text-amber-500">
                      {queueHealth.counts.running} running
                    </span>
                  )}
                  {queueHealth.counts.review > 0 && (
                    <span title="In review" className="inline-flex items-center gap-1 text-violet-500">
                      {queueHealth.counts.review} review
                    </span>
                  )}
                  {queueHealth.counts.blocked > 0 && (
                    <span title="Manually blocked" className="inline-flex items-center gap-1 text-red-500">
                      {queueHealth.counts.blocked} blocked
                    </span>
                  )}
                  {queueHealth.counts.failed > 0 && (
                    <span title="Failed tasks" className="inline-flex items-center gap-1 text-orange-500">
                      {queueHealth.counts.failed} failed
                    </span>
                  )}
                  {queueHealth.dependencyBlocked.count > 0 && (
                    <span title="Ready/pending tasks blocked by dependencies" className="inline-flex items-center gap-1 rounded bg-yellow-500/10 px-1.5 py-0.5 text-yellow-600">
                      {queueHealth.dependencyBlocked.count} blocked by deps
                    </span>
                  )}
                  {queueHealth.staleAssignments.count > 0 && (
                    <span title="Expired lease assignments" className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-red-600">
                      {queueHealth.staleAssignments.count} stale
                    </span>
                  )}
                  {queueHealth.heartbeatDue.count === 0 &&
                    queueHealth.staleAssignments.count === 0 &&
                    queueHealth.dependencyBlocked.count === 0 && (
                      <span className="text-emerald-600">healthy</span>
                    )}
                  {runningCostTotal > 0 && (
                    <span title="Sum of costCeilingUsd for running/queued tasks" className="inline-flex items-center gap-1 text-cyan-600">
                      ~${runningCostTotal.toFixed(2)} running cost
                    </span>
                  )}
                </div>
              )}
              <div className="flex h-full min-w-max gap-3 p-4">
              {[...activeBoard.columns]
                .sort((a, b) => a.order - b.order)
                .map((column) => (
                  <KanbanColumnView
                    key={column.id}
                    board={activeBoard}
                    column={column}
                    selectedTaskId={selectedTaskId}
                    dragTaskId={dragTaskId}
                    setDragTaskId={setDragTaskId}
                    onSelectTask={setSelectedTaskId}
                    onDeleteTask={deleteTask}
                    onMoveTask={moveTask}
                  />
                ))}
            </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No kanban board selected.
            </div>
          )}
        </div>
      </main>

      <TaskInspector
        boards={boards}
        board={activeBoard}
        task={selectedTask}
        onClose={() => setSelectedTaskId(null)}
        sendKanban={sendKanban}
        refreshBoard={refreshBoard}
      />
    </div>
  );
}

function KanbanColumnView({
  board,
  column,
  selectedTaskId,
  dragTaskId,
  setDragTaskId,
  onSelectTask,
  onDeleteTask,
  onMoveTask,
}: {
  board: KanbanBoard;
  column: KanbanColumn;
  selectedTaskId: string | null;
  dragTaskId: string | null;
  setDragTaskId: (id: string | null) => void;
  onSelectTask: (id: string) => void;
  onDeleteTask: (task: KanbanTask) => void;
  onMoveTask: (taskId: string, columnId: string) => void;
}) {
  const tasks = board.tasks
    .filter((task) => task.columnId === column.id)
    .sort((a, b) => a.order - b.order);
  return (
    <section
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (dragTaskId) onMoveTask(dragTaskId, column.id);
        setDragTaskId(null);
      }}
      className="flex h-full w-[310px] shrink-0 flex-col rounded-md border bg-muted/25"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: column.color ?? 'hsl(var(--primary))' }}
        />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{column.title}</div>
        <span className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {tasks.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {tasks.map((task) => (
          <article
            key={task.id}
            draggable
            onDragStart={() => setDragTaskId(task.id)}
            onDragEnd={() => setDragTaskId(null)}
            onClick={() => onSelectTask(task.id)}
            className={cn(
              'cursor-pointer rounded-md border bg-background p-3 shadow-sm transition-colors',
              selectedTaskId === task.id ? 'border-primary' : 'hover:border-primary/50',
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-sm font-medium leading-5">{task.title}</div>
                {task.description && (
                  <div className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
                    {task.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                title="Delete task"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteTask(task);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className={priorityClass(task.priority)}>{task.priority}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                {task.status}
              </span>
              {task.assignedAgent && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  {task.assignedAgent}
                </span>
              )}
              {task.assignment?.model && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                  {task.assignment.model}
                </span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function TaskInspector({
  boards,
  board,
  task,
  onClose,
  sendKanban,
  refreshBoard,
}: {
  boards: Array<{ id: string; title: string }>;
  board: KanbanBoard | null;
  task: KanbanTask | null;
  onClose: () => void;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
  refreshBoard: (boardId?: string | null) => void;
}) {
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [fallbackProfile, setFallbackProfile] = useState('');
  const [fallbackModels, setFallbackModels] = useState('');
  const [tools, setTools] = useState('');
  const [allowedCapabilities, setAllowedCapabilities] = useState('');
  const [targetBoardId, setTargetBoardId] = useState('');

  useEffect(() => {
    setAgentId(task?.assignment?.agentId ?? task?.assignedAgent ?? '');
    setName(task?.assignment?.name ?? '');
    setRole(task?.assignment?.role ?? '');
    setProvider(task?.assignment?.provider ?? '');
    setModel(task?.assignment?.model ?? '');
    setFallbackProfile(task?.assignment?.fallbackProfile ?? '');
    setFallbackModels(task?.assignment?.fallbackModels?.join(', ') ?? '');
    setTools(task?.assignment?.tools?.join(', ') ?? '');
    setAllowedCapabilities(task?.assignment?.allowedCapabilities?.join(', ') ?? '');
    setTargetBoardId(boards.find((candidate) => candidate.id !== board?.id)?.id ?? '');
  }, [board?.id, boards, task]);

  const payload = () => ({
    boardId: board?.id,
    taskId: task?.id,
    ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(role.trim() ? { role: role.trim() } : {}),
    ...(provider.trim() ? { provider: provider.trim() } : {}),
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(fallbackProfile.trim() ? { fallbackProfile: fallbackProfile.trim() } : {}),
    ...(fallbackModels.trim() ? { fallbackModels: splitCsv(fallbackModels) } : {}),
    ...(tools.trim() ? { tools: splitCsv(tools) } : {}),
    ...(allowedCapabilities.trim() ? { allowedCapabilities: splitCsv(allowedCapabilities) } : {}),
  });

  const assign = () => {
    if (!board || !task) return;
    sendKanban('kanban.task.assign', payload());
    window.setTimeout(() => refreshBoard(board.id), 150);
  };

  const dispatch = () => {
    if (!board || !task) return;
    sendKanban('kanban.task.dispatch', payload());
    window.setTimeout(() => refreshBoard(board.id), 200);
  };

  const copyTask = () => {
    if (!board || !task || !targetBoardId) return;
    sendKanban('kanban.task.copy', { boardId: board.id, taskId: task.id, targetBoardId });
  };

  const transferTask = () => {
    if (!board || !task || !targetBoardId) return;
    sendKanban('kanban.task.transfer', { boardId: board.id, taskId: task.id, targetBoardId });
  };

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l bg-card/40">
      <div className="flex h-12 items-center gap-2 border-b px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{task ? 'Task' : 'Selection'}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {task?.id.slice(0, 8) ?? 'No task selected'}
          </div>
        </div>
        <button
          type="button"
          title="Close"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
      {task ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="text-sm font-semibold leading-5">{task.title}</div>
          {task.description && (
            <div className="mt-2 text-xs leading-5 text-muted-foreground">{task.description}</div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label="Status" value={task.status} />
            <Metric label="Priority" value={task.priority} />
            <Metric label="Run" value={task.assignment?.status ?? 'unassigned'} />
            <Metric label="Column" value={task.columnId} />
          </div>

          <div className="mt-4 space-y-2">
            <Field label="Agent" value={agentId} onChange={setAgentId} />
            <Field label="Name" value={name} onChange={setName} />
            <Field label="Role" value={role} onChange={setRole} />
            <Field label="Provider" value={provider} onChange={setProvider} />
            <Field label="Model" value={model} onChange={setModel} />
            <Field label="Fallback profile" value={fallbackProfile} onChange={setFallbackProfile} />
            <Field label="Fallback models" value={fallbackModels} onChange={setFallbackModels} />
            <Field label="Tools" value={tools} onChange={setTools} />
            <Field
              label="Capabilities"
              value={allowedCapabilities}
              onChange={setAllowedCapabilities}
            />
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={assign}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted"
            >
              <UserPlus size={15} />
              Assign
            </button>
            <button
              type="button"
              onClick={dispatch}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary text-sm text-primary-foreground hover:bg-primary/90"
            >
              <Send size={15} />
              Dispatch
            </button>
          </div>

          {boards.length > 1 ? (
            <div className="mt-4 space-y-2 rounded-md border bg-background p-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Target board
                </span>
                <select
                  value={targetBoardId}
                  onChange={(event) => setTargetBoardId(event.target.value)}
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
                >
                  {boards
                    .filter((candidate) => candidate.id !== board?.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={copyTask}
                  disabled={!targetBoardId}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Copy size={15} />
                  Copy
                </button>
                <button
                  type="button"
                  onClick={transferTask}
                  disabled={!targetBoardId}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted disabled:opacity-50"
                >
                  <MoveRight size={15} />
                  Transfer
                </button>
              </div>
            </div>
          ) : null}

          {task.successCriteria?.length ? (
            <div className="mt-5">
              <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Checks
              </div>
              <div className="space-y-1.5">
                {task.successCriteria.map((check) => (
                  <div
                    key={check.id}
                    className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs"
                  >
                    <Check
                      size={13}
                      className={
                        check.status === 'passed' ? 'text-green-600' : 'text-muted-foreground'
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{check.description}</span>
                    <span className="text-muted-foreground">{check.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Select a task to edit assignment and dispatch settings.
        </div>
      )}
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-2 py-1.5">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium">{value}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
      />
    </label>
  );
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function priorityClass(priority: KanbanTask['priority']): string {
  const base = 'rounded px-1.5 py-0.5';
  if (priority === 'critical') return `${base} bg-destructive/10 text-destructive`;
  if (priority === 'high') return `${base} bg-amber-500/10 text-amber-700 dark:text-amber-300`;
  if (priority === 'low') return `${base} bg-muted text-muted-foreground`;
  return `${base} bg-blue-500/10 text-blue-700 dark:text-blue-300`;
}
