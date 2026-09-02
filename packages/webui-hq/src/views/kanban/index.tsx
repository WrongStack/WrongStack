/**
 * Kanban — read-only project boards, synchronized across clones and machines.
 *
 * Data comes from `/api/projects/:id/kanban`, polled on a slow timer AND
 * refreshed whenever a `kanban.snapshot` event lands, so a board that changes
 * on another machine appears without waiting out the poll. Every fetch carries
 * a sequence number: switching projects while a request is in flight must not
 * paint the previous project's board.
 */
import type { HqKanbanSnapshotPayload, HqProjectRecord } from '@wrongstack/core/hq';
import { Clock3, Columns3, GitBranch, RefreshCw, TriangleAlert, UserRound } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Mono, StatTile } from '../../components/hq/primitives.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { fetchJson } from '../../data/api.js';
import { useHqStore } from '../../data/store/index.js';
import { relativeTime } from '../../domain/control-format.js';
import {
  type HqKanbanBoardView,
  type HqKanbanTaskView,
  projectKanbanBoards,
  projectKanbanUrl,
} from '../../domain/kanban-model.js';
import { cn } from '../../lib/utils.js';
import { KanbanQueueHealth } from './queue-health.js';
import { KanbanTaskInspector } from './task-inspector.js';
import { taskPriorityTone, taskStatusTone } from './task-tone.js';

const REFRESH_INTERVAL_MS = 10_000;
const EMPTY_PROJECTS: readonly HqProjectRecord[] = [];
const MAX_CARD_LABELS = 4;

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : value;
}

function TaskCard({
  task,
  selected,
  onSelect,
}: {
  task: HqKanbanTaskView;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid="kanban-task"
      data-priority={task.priority}
      data-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1.5 border bg-card p-2 text-left transition-colors',
        selected ? 'border-primary bg-accent/50' : 'border-border hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge tone={taskStatusTone(task.status)}>{task.status.replaceAll('_', ' ')}</Badge>
        <Badge tone={taskPriorityTone(task.priority)} className="ml-auto">
          {task.priority}
        </Badge>
      </div>

      <span className="text-xs font-medium leading-snug">{task.title}</span>
      {task.description !== undefined && (
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {task.description}
        </p>
      )}

      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {task.labels.slice(0, MAX_CARD_LABELS).map((label) => (
            <span key={label} className="bg-secondary px-1 text-[10px] text-secondary-foreground">
              {label}
            </span>
          ))}
        </div>
      )}

      {(task.assignee !== undefined || task.dependsOn.length > 0 || task.dueDate !== undefined) && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          {task.assignee !== undefined && (
            <span
              className="inline-flex items-center gap-1"
              title={task.assignmentStatus ?? 'assigned'}
            >
              <UserRound className="size-3" />
              {task.assignee}
            </span>
          )}
          {task.dependsOn.length > 0 && (
            <span
              className="inline-flex items-center gap-1"
              title={`${task.dependsOn.length} dependencies`}
            >
              <GitBranch className="size-3" />
              {task.dependsOn.length}
            </span>
          )}
          {task.dueDate !== undefined && (
            <span
              className="inline-flex items-center gap-1"
              title={`Due ${new Date(task.dueDate).toLocaleString()}`}
            >
              <Clock3 className="size-3" />
              {shortDate(task.dueDate)}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function Board({
  board,
  selectedTaskId,
  onSelect,
}: {
  board: HqKanbanBoardView;
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}): React.ReactElement {
  if (board.columns.length === 0) {
    return <EmptyState title="This board has no columns yet" />;
  }
  return (
    <section
      aria-label={`${board.title} board`}
      data-testid="kanban-board"
      className="flex gap-3 overflow-x-auto pb-2"
    >
      {board.columns.map((column) => {
        // WIP counts work in flight; completed cards parked in a column are
        // not consuming capacity and must not trip the limit.
        const inFlight = column.tasks.filter((task) => task.status !== 'completed').length;
        const overLimit = column.wipLimit !== undefined && inFlight > column.wipLimit;
        return (
          <div
            key={column.id}
            data-testid="kanban-column"
            data-over-limit={overLimit}
            className="flex w-64 shrink-0 flex-col border border-border bg-card/50"
          >
            <header
              className={cn(
                'flex items-center gap-2 border-b-2 px-2 py-1.5',
                overLimit ? 'border-b-destructive' : 'border-b-border',
              )}
              style={column.color !== undefined && !overLimit ? { borderBottomColor: column.color } : undefined}
            >
              <strong className="text-xs">{column.title}</strong>
              {column.wipLimit !== undefined && (
                <Badge tone={overLimit ? 'error' : 'idle'}>
                  WIP {inFlight}/{column.wipLimit}
                </Badge>
              )}
              <Mono className="tabular ml-auto">{column.tasks.length}</Mono>
            </header>
            <div className="flex flex-col gap-1.5 overflow-y-auto p-1.5">
              {column.tasks.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">No cards</p>
              ) : (
                column.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selected={task.id === selectedTaskId}
                    onSelect={() => onSelect(task.id)}
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

export function KanbanView(): React.ReactElement {
  const projects = useHqStore((state) => state.snapshot?.projects ?? EMPTY_PROJECTS);
  // The id of the newest kanban.snapshot event: a cheap change token that
  // tells us a board moved somewhere in the fleet.
  const kanbanEventId = useHqStore((state) => {
    for (let index = state.events.length - 1; index >= 0; index--) {
      const event = state.events[index];
      if (event?.type === 'kanban.snapshot') return event.id;
    }
    return null;
  });

  const [projectId, setProjectId] = useState('');
  const [boardId, setBoardId] = useState('');
  const [payload, setPayload] = useState<HqKanbanSnapshotPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Monotonic request id: a response from a project we have since navigated
  // away from must be dropped, not painted.
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
      if (projectId === '') return;
      const requestId = ++requestSequence.current;
      if (foreground) setLoading(true);
      else setRefreshing(true);
      try {
        const next = await fetchJson<HqKanbanSnapshotPayload>(projectKanbanUrl(projectId));
        if (requestId !== requestSequence.current) return;
        setPayload(next);
        setError(null);
      } catch (cause) {
        if (requestId !== requestSequence.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (requestId === requestSequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [projectId],
  );

  // Switching projects invalidates everything on screen immediately.
  useEffect(() => {
    requestSequence.current += 1;
    setPayload(null);
    setBoardId('');
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (projectId === '') return;
    void load(true);
    const timer = window.setInterval(() => void load(false), REFRESH_INTERVAL_MS);
    return () => {
      requestSequence.current += 1;
      window.clearInterval(timer);
    };
  }, [load, projectId]);

  useEffect(() => {
    if (kanbanEventId === null || kanbanEventId === lastKanbanEventId.current) return;
    lastKanbanEventId.current = kanbanEventId;
    if (projectId !== '') void load(false);
  }, [kanbanEventId, load, projectId]);

  const boards = useMemo(() => (payload ? projectKanbanBoards(payload) : []), [payload]);

  useEffect(() => {
    if (boards.length === 0) setBoardId('');
    else if (!boards.some((board) => board.id === boardId)) setBoardId(boards[0]!.id);
  }, [boardId, boards]);

  useEffect(() => {
    setSelectedTaskId(null);
  }, [boardId]);

  const board = boards.find((candidate) => candidate.id === boardId) ?? null;
  const project = projects.find((candidate) => candidate.projectId === projectId) ?? null;

  const selectedTask = useMemo<HqKanbanTaskView | null>(() => {
    if (board === null || selectedTaskId === null) return null;
    for (const column of board.columns) {
      const task = column.tasks.find((candidate) => candidate.id === selectedTaskId);
      if (task !== undefined) return task;
    }
    return null;
  }, [board, selectedTaskId]);

  const dependencyTitles = useMemo<ReadonlyMap<string, string>>(() => {
    const titles = new Map<string, string>();
    for (const column of board?.columns ?? []) {
      for (const task of column.tasks) titles.set(task.id, task.title);
    }
    return titles;
  }, [board]);

  if (projects.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Columns3}
          title="No HQ projects available"
          hint="Connect a WrongStack client to publish its project identity and Kanban snapshot."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="kanban-project">Project</Label>
          <Select
            id="kanban-project"
            aria-label="Kanban project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="w-56"
          >
            {projects.map((candidate) => (
              <option key={candidate.projectId} value={candidate.projectId}>
                {candidate.projectName}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="kanban-board">Board</Label>
          <Select
            id="kanban-board"
            aria-label="Kanban board"
            value={boardId}
            disabled={boards.length === 0}
            onChange={(event) => setBoardId(event.target.value)}
            className="w-56"
          >
            {boards.length === 0 && <option value="">No boards</option>}
            {boards.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Mono>
            {payload?.generatedAt !== undefined
              ? `Synced ${relativeTime(payload.generatedAt)}`
              : 'Waiting for snapshot'}
          </Mono>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(false)}
            disabled={refreshing}
            aria-label="Refresh Kanban"
          >
            <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        </div>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="flex items-center gap-2 border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <TriangleAlert className="size-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load(true)}>
            Retry
          </Button>
        </div>
      )}

      {loading && payload === null ? (
        <div role="status" className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          Loading project boards…
        </div>
      ) : board !== null ? (
        <>
          <section className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
                {project?.projectName ?? 'Project'} · Kanban
              </span>
              <h2 className="font-display text-lg leading-none">{board.title}</h2>
              <Mono className="tabular">rev {board.revision}</Mono>
              <Mono>{relativeTime(board.updatedAt)}</Mono>
              {board.activePresence > 0 && (
                <Badge tone="active">{board.activePresence} active</Badge>
              )}
            </div>
            {board.description !== undefined && (
              <p className="max-w-prose text-xs text-muted-foreground">{board.description}</p>
            )}
            {board.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {board.tags.map((tag) => (
                  <Badge key={tag} tone="info">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-6 pt-1">
              <StatTile label="Boards" value={boards.length} />
              <StatTile label="Tasks" value={board.taskCount} />
              <StatTile label="Active" value={board.activeTaskCount} tone="running" />
              <StatTile
                label="Blocked"
                value={board.blockedTaskCount}
                tone={board.blockedTaskCount > 0 ? 'error' : 'idle'}
              />
              <StatTile label="Done" value={board.completedTaskCount} tone="active" />
            </div>
          </section>

          <KanbanQueueHealth board={board} />

          <Board board={board} selectedTaskId={selectedTaskId} onSelect={setSelectedTaskId} />

          {selectedTask !== null && (
            <KanbanTaskInspector
              task={selectedTask}
              board={board}
              dependencyTitles={dependencyTitles}
              onClose={() => setSelectedTaskId(null)}
            />
          )}
        </>
      ) : (
        <EmptyState
          icon={Columns3}
          title="No Kanban board published for this project"
          hint="Create one with /kanban from any connected clone."
        />
      )}
    </div>
  );
}
