'use client';

import { useHqStore } from '@hq/data/store/index';

import {
  type HqKanbanBoardView,
  type HqKanbanTaskView,
  matchesKanbanTask,
} from '@hq/domain/kanban-model';
import { computeQueueCounts } from '@hq/domain/kanban-queue-health';
import type { HqProjectRecord } from '@wrongstack/hq';
import { Clock3, GitBranch, RefreshCw, Search, TriangleAlert, UserRound, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import { useScopedSnapshot } from '@/lib/use-scope';
import {
  columnLoad,
  dependenciesMet,
  needsAttention,
  statusLabel,
  TASK_STATUSES,
  taskIndex,
} from './model';
import { TaskPanel } from './task-panel';
import { useKanbanBoards } from './use-kanban-boards';

const EMPTY: readonly HqProjectRecord[] = [];
const PRIORITY_MARK: Record<string, string> = {
  critical: 'text-destructive',
  high: 'text-warning',
};

function useBoardParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return { get: (key: string) => params.get(key), set };
}

export function KanbanView(): ReactNode {
  const scopedProjects = useScopedSnapshot()?.projects ?? EMPTY;
  const allProjects = useHqStore((state) => state.snapshot?.projects ?? EMPTY);
  const url = useBoardParams();
  // A link to a project outside the scope still opens it; the picker lists the
  // scope plus that project, so the operator can see where they are.
  const linked = allProjects.find((p) => p.projectId === url.get('project'));
  const projects =
    linked !== undefined && !scopedProjects.includes(linked)
      ? [...scopedProjects, linked]
      : scopedProjects;
  const projectId = linked?.projectId ?? scopedProjects[0]?.projectId ?? null;
  const data = useKanbanBoards(projectId);
  const board = data.boards.find((b) => b.id === url.get('board')) ?? data.boards[0] ?? null;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const now = Date.now();

  const index = useMemo(
    () => (board === null ? new Map<string, HqKanbanTaskView>() : taskIndex(board)),
    [board],
  );
  const openTask = url.get('task') !== null ? (index.get(url.get('task') as string) ?? null) : null;

  if (projects.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h2 className="font-display text-2xl font-semibold">No project has reported yet</h2>
        <p className="mt-2 text-base text-muted-foreground">
          A connected WrongStack client publishes its project and Kanban boards here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <select
          aria-label="Project"
          value={projectId ?? ''}
          onChange={(event) => url.set({ project: event.target.value, board: null, task: null })}
          className="h-9 border border-border bg-background px-2 text-sm font-medium"
        >
          {projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.projectName}
            </option>
          ))}
        </select>
        <select
          aria-label="Board"
          value={board?.id ?? ''}
          disabled={data.boards.length === 0}
          onChange={(event) => url.set({ board: event.target.value, task: null })}
          className="h-9 border border-border bg-background px-2 text-sm"
        >
          {data.boards.length === 0 && <option value="">No boards</option>}
          {data.boards.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
        <label className="flex h-9 w-full items-center gap-2 border sm:w-64 border-border bg-background px-2.5 text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, id, assignee, label"
            aria-label="Search tasks"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
        <select
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-9 border border-border bg-background px-2 text-sm"
        >
          <option value="all">Every status</option>
          {TASK_STATUSES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {statusLabel(candidate)}
            </option>
          ))}
        </select>
        {(query !== '' || status !== 'all') && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setStatus('all');
            }}
            className="inline-flex h-9 items-center gap-1 px-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" /> Clear
          </button>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          {data.generatedAt !== undefined
            ? `Synced ${relativeTime(data.generatedAt, now)}`
            : 'Waiting for the board'}
        </span>
        <button
          type="button"
          onClick={data.refresh}
          disabled={data.refreshing}
          aria-label="Refresh board"
          className="grid size-9 place-items-center border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn('size-4', data.refreshing && 'animate-spin')} />
        </button>
      </div>

      {data.error !== null && (
        <p
          role="alert"
          className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-6 py-2.5 text-sm text-destructive"
        >
          <TriangleAlert className="size-4 shrink-0" />
          <span className="flex-1">The board could not be loaded: {data.error}</span>
          <button type="button" onClick={data.refresh} className="underline">
            Retry
          </button>
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {data.loading && board === null ? (
          <p className="p-6 text-sm text-muted-foreground">Loading boards…</p>
        ) : board === null ? (
          <div className="mx-auto max-w-2xl px-6 py-16">
            <h2 className="font-display text-xl font-semibold">This project has no Kanban board</h2>
            <p className="mt-2 text-base text-muted-foreground">
              Create one with /kanban from any connected clone.
            </p>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <BoardSummary board={board} />
            <Columns
              board={board}
              index={index}
              query={query}
              status={status}
              selectedId={openTask?.id ?? null}
              onOpen={(task) => url.set({ task: task.id })}
            />
          </div>
        )}
        {board !== null && openTask !== null && projectId !== null && (
          <TaskPanel
            task={openTask}
            board={board}
            projectId={projectId}
            onClose={() => url.set({ task: null })}
            onOpenTask={(taskId) => url.set({ task: taskId })}
          />
        )}
      </div>
    </div>
  );
}

function BoardSummary({ board }: { board: HqKanbanBoardView }): ReactNode {
  const counts = computeQueueCounts(board);
  const parts: { label: string; value: number; tone?: string }[] = [
    { label: 'tasks', value: board.taskCount },
    { label: 'ready to start', value: counts.startable },
    { label: 'running', value: counts.running },
    { label: 'in review', value: counts.review },
    {
      label: 'blocked',
      value: counts.blocked,
      tone: counts.blocked > 0 ? 'text-destructive' : undefined,
    },
    {
      label: 'failed',
      value: counts.failed,
      tone: counts.failed > 0 ? 'text-destructive' : undefined,
    },
    { label: 'done', value: board.completedTaskCount },
  ];
  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-5 gap-y-1 px-6 pb-3 pt-4">
      <h2 className="font-display text-lg font-semibold">{board.title}</h2>
      {parts.map((part) => (
        <span key={part.label} className={cn('text-sm text-muted-foreground', part.tone)}>
          <span className="tabular font-semibold text-foreground">{part.value}</span> {part.label}
        </span>
      ))}
      {board.activePresence > 0 && (
        <span className="text-sm text-success">
          {board.activePresence} people or agents on this board
        </span>
      )}
    </div>
  );
}

function Columns({
  board,
  index,
  query,
  status,
  selectedId,
  onOpen,
}: {
  board: HqKanbanBoardView;
  index: ReadonlyMap<string, HqKanbanTaskView>;
  query: string;
  status: string;
  selectedId: string | null;
  onOpen: (task: HqKanbanTaskView) => void;
}): ReactNode {
  if (board.columns.length === 0) {
    return <p className="px-6 text-sm text-muted-foreground">This board has no columns yet.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-6 pb-6">
      {board.columns.map((column) => {
        const load = columnLoad(column);
        const tasks = column.tasks.filter((task) => matchesKanbanTask(task, query, status));
        return (
          <section
            key={column.id}
            aria-label={column.title}
            className="flex w-80 shrink-0 flex-col bg-muted/40"
          >
            <header className="flex items-baseline gap-2 px-3 py-2.5">
              <h3 className="truncate text-sm font-semibold">{column.title}</h3>
              <span
                className={cn(
                  'tabular text-sm',
                  load.over ? 'font-semibold text-warning' : 'text-muted-foreground',
                )}
              >
                {load.count}
                {load.limit !== undefined && ` / ${load.limit}`}
              </span>
              {load.over && <span className="text-xs text-warning">over WIP limit</span>}
            </header>
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {tasks.length === 0 && (
                <li className="px-2 py-3 text-sm text-muted-foreground">
                  No tasks{query !== '' || status !== 'all' ? ' match' : ''}.
                </li>
              )}
              {tasks.map((task) => (
                <li key={task.id}>
                  <TaskCard
                    task={task}
                    waiting={!dependenciesMet(task, index)}
                    selected={task.id === selectedId}
                    onOpen={() => onOpen(task)}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  waiting,
  selected,
  onOpen,
}: {
  task: HqKanbanTaskView;
  waiting: boolean;
  selected: boolean;
  onOpen: () => void;
}): ReactNode {
  const attention = needsAttention(task);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      data-task={task.id}
      className={cn(
        'flex w-full flex-col gap-2 border bg-card p-3 text-left shadow-xs hover:border-foreground/30',
        selected ? 'border-primary' : attention ? 'border-destructive/50' : 'border-border',
      )}
    >
      <span className="text-sm font-medium leading-snug">{task.title}</span>
      {task.description !== undefined && (
        <span className="line-clamp-2 text-sm leading-snug text-muted-foreground">
          {task.description}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {attention && (
          <span className="font-medium text-destructive">{statusLabel(task.status)}</span>
        )}
        {PRIORITY_MARK[task.priority] !== undefined && (
          <span className={cn('font-medium', PRIORITY_MARK[task.priority])}>{task.priority}</span>
        )}
        {task.assignee !== undefined && (
          <span className="inline-flex items-center gap-1">
            <UserRound className="size-3.5" />
            {task.assignee}
          </span>
        )}
        {task.dependsOn.length > 0 && (
          <span
            className={cn('inline-flex items-center gap-1', waiting && 'text-warning')}
            title={waiting ? 'Waiting on unfinished dependencies' : 'Dependencies done'}
          >
            <GitBranch className="size-3.5" />
            {waiting ? 'waiting' : 'deps done'}
          </span>
        )}
        {task.dueDate !== undefined && (
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3.5" />
            {new Date(task.dueDate).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        )}
      </span>
      {task.labels.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {task.labels.slice(0, 4).map((label) => (
            <span key={label} className="bg-muted px-1.5 py-0.5 text-xs">
              {label}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
