import type { HqKanbanSnapshotPayload, HqProjectRecord } from '@wrongstack/core/hq';
import { AlertTriangle, CheckCircle2, Clock3, GitBranch, RefreshCw, UserRound } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, useHqStore } from '../store.js';
import { HqKanbanInspector } from './kanban-inspector.js';
import {
  type HqKanbanBoardView,
  type HqKanbanTaskView,
  projectKanbanBoards,
  projectKanbanUrl,
} from './kanban-model.js';

const REFRESH_INTERVAL_MS = 10_000;
const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];

export function KanbanView(): React.ReactElement {
  const projects = useHqStore((state) => state.snapshot?.projects ?? EMPTY_PROJECTS);
  const kanbanEventId = useHqStore((state) => {
    for (let index = state.events.length - 1; index >= 0; index--) {
      const event = state.events[index];
      if (event?.type === 'kanban.snapshot') return event.id;
    }
    return null;
  });
  const [projectId, setProjectId] = useState<string>('');
  const [boardId, setBoardId] = useState<string>('');
  const [payload, setPayload] = useState<HqKanbanSnapshotPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const lastKanbanEventId = useRef(kanbanEventId);

  useEffect(() => {
    if (projects.length === 0) {
      setProjectId('');
      setPayload(null);
      return;
    }
    if (!projects.some((project) => project.projectId === projectId)) {
      setProjectId(projects[0]!.projectId);
    }
  }, [projectId, projects]);

  const load = useCallback(
    async (foreground = false): Promise<void> => {
      if (!projectId) return;
      const requestId = ++requestSequence.current;
      foreground ? setLoading(true) : setRefreshing(true);
      try {
        const next = await fetchJson<HqKanbanSnapshotPayload>(projectKanbanUrl(projectId));
        if (requestId !== requestSequence.current) return;
        setPayload(next);
        setError(null);
      } catch (loadError) {
        if (requestId !== requestSequence.current) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (requestId === requestSequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    requestSequence.current++;
    setPayload(null);
    setBoardId('');
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    void load(true);
    const timer = window.setInterval(() => void load(false), REFRESH_INTERVAL_MS);
    return () => {
      requestSequence.current++;
      window.clearInterval(timer);
    };
  }, [load, projectId]);

  useEffect(() => {
    if (kanbanEventId === null || kanbanEventId === lastKanbanEventId.current) return;
    lastKanbanEventId.current = kanbanEventId;
    if (projectId) void load(false);
  }, [kanbanEventId, load, projectId]);

  const boards = useMemo(() => (payload ? projectKanbanBoards(payload) : []), [payload]);
  useEffect(() => {
    if (boards.length === 0) {
      setBoardId('');
    } else if (!boards.some((board) => board.id === boardId)) {
      setBoardId(boards[0]!.id);
    }
  }, [boardId, boards]);

  const board = boards.find((candidate) => candidate.id === boardId) ?? null;
  const project = projects.find((candidate) => candidate.projectId === projectId) ?? null;

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Clear selection when board changes
  useEffect(() => {
    setSelectedTaskId(null);
  }, [boardId]);

  const selectedTask = useMemo<HqKanbanTaskView | null>(() => {
    if (!board || !selectedTaskId) return null;
    for (const column of board.columns) {
      const task = column.tasks.find((t) => t.id === selectedTaskId);
      if (task) return task;
    }
    return null;
  }, [board, selectedTaskId]);

  // Resolve dependency titles for the inspector
  const dependencyTitles = useMemo<ReadonlyMap<string, string>>(() => {
    if (!board) return new Map();
    const map = new Map<string, string>();
    for (const column of board.columns) {
      for (const task of column.tasks) {
        map.set(task.id, task.title);
      }
    }
    return map;
  }, [board]);

  if (projects.length === 0) {
    return (
      <div className="hq-empty">
        No HQ projects are available. Connect a WrongStack client to publish its project identity
        and Kanban snapshot.
      </div>
    );
  }

  return (
    <div className="hq-kanban-view">
      <KanbanToolbar
        projects={projects}
        projectId={projectId}
        onProjectChange={(nextProjectId) => setProjectId(nextProjectId)}
        boards={boards}
        boardId={boardId}
        onBoardChange={setBoardId}
        generatedAt={payload?.generatedAt}
        refreshing={refreshing}
        onRefresh={() => void load(false)}
      />

      {error ? (
        <div className="hq-kanban-error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button type="button" onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      ) : null}

      {loading && payload === null ? (
        <div className="hq-view-loading" role="status">
          <RefreshCw size={18} />
          <span>Loading project boards…</span>
        </div>
      ) : board ? (
        <>
          <KanbanSummary project={project} board={board} boardCount={boards.length} />
          <div className="hq-kanban-main">
            <Board board={board} onTaskClick={setSelectedTaskId} selectedTaskId={selectedTaskId} />
            {selectedTask ? (
              <HqKanbanInspector
                task={selectedTask}
                board={board}
                dependencyTitles={dependencyTitles}
                onClose={() => setSelectedTaskId(null)}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="hq-empty">
          This project has not published a Kanban board yet. Create one with <code>/kanban</code>{' '}
          from any connected clone.
        </div>
      )}
    </div>
  );
}

function KanbanToolbar({
  projects,
  projectId,
  onProjectChange,
  boards,
  boardId,
  onBoardChange,
  generatedAt,
  refreshing,
  onRefresh,
}: {
  projects: readonly HqProjectRecord[];
  projectId: string;
  onProjectChange: (value: string) => void;
  boards: readonly HqKanbanBoardView[];
  boardId: string;
  onBoardChange: (value: string) => void;
  generatedAt?: string | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}): React.ReactElement {
  return (
    <div className="hq-kanban-toolbar">
      <label>
        <span>Project</span>
        <select
          className="hq-select"
          aria-label="Kanban project"
          value={projectId}
          onChange={(event) => onProjectChange(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.projectName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Board</span>
        <select
          className="hq-select"
          aria-label="Kanban board"
          value={boardId}
          disabled={boards.length === 0}
          onChange={(event) => onBoardChange(event.target.value)}
        >
          {boards.length === 0 ? <option value="">No boards</option> : null}
          {boards.map((board) => (
            <option key={board.id} value={board.id}>
              {board.title}
            </option>
          ))}
        </select>
      </label>
      <div className="hq-kanban-sync">
        <span>{generatedAt ? `Synced ${relativeTime(generatedAt)}` : 'Waiting for snapshot'}</span>
        <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh Kanban">
          <RefreshCw size={14} className={refreshing ? 'is-spinning' : undefined} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function KanbanSummary({
  project,
  board,
  boardCount,
}: {
  project: HqProjectRecord | null;
  board: HqKanbanBoardView;
  boardCount: number;
}): React.ReactElement {
  return (
    <section className="hq-kanban-summary">
      <div className="hq-kanban-heading">
        <div>
          <span>{project?.projectName ?? 'Project'} · Kanban</span>
          <h2>{board.title}</h2>
          {board.description ? <p>{board.description}</p> : null}
        </div>
        <div className="hq-kanban-board-meta">
          <span className="hq-mono">rev {board.revision}</span>
          <span>{relativeTime(board.updatedAt)}</span>
          {board.activePresence > 0 ? (
            <span className="hq-pill active">{board.activePresence} active</span>
          ) : null}
        </div>
      </div>
      {board.tags.length > 0 ? (
        <div className="hq-kanban-tags">
          {board.tags.map((tag) => (
            <span className="hq-pill info" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="hq-kanban-stats">
        <KanbanStat label="Boards" value={boardCount} />
        <KanbanStat label="Tasks" value={board.taskCount} />
        <KanbanStat label="Active" value={board.activeTaskCount} tone="active" />
        <KanbanStat label="Blocked" value={board.blockedTaskCount} tone="blocked" />
        <KanbanStat label="Done" value={board.completedTaskCount} tone="done" />
      </div>
    </section>
  );
}

function KanbanStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string | undefined;
}): React.ReactElement {
  return (
    <div className="hq-kanban-stat" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Board({
  board,
  onTaskClick,
  selectedTaskId,
}: {
  board: HqKanbanBoardView;
  onTaskClick: (taskId: string) => void;
  selectedTaskId: string | null;
}): React.ReactElement {
  if (board.columns.length === 0) {
    return <div className="hq-empty">This board does not have any columns yet.</div>;
  }
  return (
    <section
      className="hq-kanban-board"
      aria-label={`${board.title} Kanban board`}
      style={{ '--hq-kanban-columns': Math.max(1, board.columns.length) } as React.CSSProperties}
    >
      {board.columns.map((column) => {
        const overLimit =
          column.wipLimit !== undefined &&
          column.tasks.filter((task) => task.status !== 'completed').length > column.wipLimit;
        return (
          <div className="hq-kanban-column" data-over-limit={overLimit} key={column.id}>
            <header style={column.color ? { borderTopColor: column.color } : undefined}>
              <div>
                <strong>{column.title}</strong>
                {column.wipLimit !== undefined ? (
                  <span>
                    WIP {column.tasks.length}/{column.wipLimit}
                  </span>
                ) : null}
              </div>
              <span className="hq-kanban-column-count">{column.tasks.length}</span>
            </header>
            <div className="hq-kanban-column-body">
              {column.tasks.length === 0 ? (
                <div className="hq-kanban-column-empty">No cards</div>
              ) : (
              column.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  isSelected={task.id === selectedTaskId}
                  onClick={() => onTaskClick(task.id)}
                />
              ))
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function TaskCard({
  task,
  isSelected = false,
  onClick,
}: {
  task: HqKanbanTaskView;
  isSelected?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <article
      className="hq-kanban-task"
      data-priority={task.priority}
      data-selected={isSelected}
      onClick={onClick}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      }}
    >
      <div className="hq-kanban-task-topline">
        <span className={`hq-pill ${task.status}`}>{task.status.replaceAll('_', ' ')}</span>
        <span className={`hq-kanban-priority ${task.priority}`}>{task.priority}</span>
      </div>
      <h3>{task.title}</h3>
      {task.description ? <p>{task.description}</p> : null}
      {task.labels.length > 0 ? (
        <div className="hq-kanban-task-labels">
          {task.labels.slice(0, 4).map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      ) : null}
      <footer>
        {task.assignee ? (
          <span title={task.assignmentStatus ?? 'assigned'}>
            <UserRound size={12} />
            {task.assignee}
          </span>
        ) : null}
        {task.dependsOn.length > 0 ? (
          <span title={`${task.dependsOn.length} dependencies`}>
            <GitBranch size={12} />
            {task.dependsOn.length}
          </span>
        ) : null}
        {task.dueDate ? (
          <span title={`Due ${new Date(task.dueDate).toLocaleString()}`}>
            <Clock3 size={12} />
            {shortDate(task.dueDate)}
          </span>
        ) : null}
        {task.status === 'completed' ? <CheckCircle2 size={13} className="is-done" /> : null}
      </footer>
    </article>
  );
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : value;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
