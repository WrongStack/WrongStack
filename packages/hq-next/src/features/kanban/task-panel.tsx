'use client';

/**
 * One task: what it is, what it waits on, and what can be done with it.
 *
 * Actions are commands, not edits. Each is queued to a connected client of the
 * project and applied by the project's own Kanban owner through its lifecycle
 * gate, so an illegal move is refused on the machine rather than trusted from
 * here. Moving and assigning are single clicks; dispatching starts a worker
 * agent and spends budget, so it takes an explicit confirmation.
 */
import { postCommand } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import {
  canAssignKanbanTask,
  canDispatchKanbanTask,
  kanbanControlClients,
  kanbanTransitionOptions,
  type LifecycleStage,
  suggestedKanbanStage,
} from '@hq/domain/kanban-actions';
import type { HqKanbanBoardView, HqKanbanTaskView } from '@hq/domain/kanban-model';
import { Check, CircleDashed, Play, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  assignmentTargets,
  dependencyStates,
  needsAttention,
  statusLabel,
  taskIndex,
} from './model';

type CommandType = 'kanban-transition' | 'kanban-assign' | 'kanban-dispatch';

export function TaskPanel({
  task,
  board,
  projectId,
  onClose,
  onOpenTask,
}: {
  task: HqKanbanTaskView;
  board: HqKanbanBoardView;
  projectId: string;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}): ReactNode {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const index = useMemo(() => taskIndex(board), [board]);
  const dependencies = dependencyStates(task, index);
  const column = board.columns.find((candidate) => candidate.id === task.columnId);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected === true) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(480px,100%)] flex-col overflow-y-auto border-l border-border bg-card shadow-2xl"
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">
            {statusLabel(task.status)} · {task.priority} priority
            {column !== undefined && ` · ${column.title}`}
          </p>
          <h2 id={titleId} className="mt-1 font-display text-xl font-semibold leading-snug">
            {task.title}
          </h2>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{task.id}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close task"
          className="grid size-9 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex flex-col gap-6 px-5 py-5">
        {needsAttention(task) && (
          <p className="flex items-center gap-2 border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <TriangleAlert className="size-4 shrink-0" />
            This task is {task.status} and needs a decision.
          </p>
        )}

        {task.description !== undefined && (
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{task.description}</p>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Assignee</dt>
            <dd className="mt-0.5">
              {task.assignee ?? '—'}
              {task.assignmentStatus !== undefined && (
                <span className="text-muted-foreground"> · {task.assignmentStatus}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Due</dt>
            <dd className="mt-0.5">
              {task.dueDate !== undefined ? new Date(task.dueDate).toLocaleString() : '—'}
            </dd>
          </div>
        </dl>

        {task.labels.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {task.labels.map((label) => (
              <li key={label} className="bg-muted px-2 py-0.5 text-xs">
                {label}
              </li>
            ))}
          </ul>
        )}

        {dependencies.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold">
              Waits on {dependencies.filter((d) => !d.done).length} of {dependencies.length}
            </h3>
            <ul className="mt-2 flex flex-col gap-1">
              {dependencies.map((dependency) => (
                <li key={dependency.id}>
                  <button
                    type="button"
                    disabled={dependency.missing}
                    onClick={() => onOpenTask(dependency.id)}
                    className="flex w-full items-center gap-2.5 px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    {dependency.done ? (
                      <Check aria-label="Done" className="size-4 shrink-0 text-success" />
                    ) : (
                      <CircleDashed
                        aria-label="Not done"
                        className="size-4 shrink-0 text-warning"
                      />
                    )}
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        dependency.done && 'text-muted-foreground',
                      )}
                    >
                      {dependency.title}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {dependency.missing
                        ? 'not on this board'
                        : statusLabel(dependency.status ?? '')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <TaskActions task={task} board={board} projectId={projectId} />
      </div>
    </aside>
  );
}

function TaskActions({
  task,
  board,
  projectId,
}: {
  task: HqKanbanTaskView;
  board: HqKanbanBoardView;
  projectId: string;
}): ReactNode {
  const snapshot = useHqStore((state) => state.snapshot);
  const { control, dispatch } = useMemo(
    () => kanbanControlClients(snapshot, projectId),
    [snapshot, projectId],
  );
  const targets = useMemo(() => assignmentTargets(snapshot, projectId), [snapshot, projectId]);
  const stages = kanbanTransitionOptions(task);
  const unfinished = useMemo(
    () => dependencyStates(task, taskIndex(board)).filter((dependency) => !dependency.done).length,
    [task, board],
  );
  const [stage, setStage] = useState<LifecycleStage>(suggestedKanbanStage(task));
  const [targetKey, setTargetKey] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDispatch, setConfirmDispatch] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // A different task is a different decision: nothing carries over.
  useEffect(() => {
    setStage(suggestedKanbanStage(task));
    setComment('');
    setResult(null);
    setConfirmDispatch(false);
  }, [task]);
  useEffect(() => {
    if (!targets.some((target) => target.key === targetKey)) setTargetKey(targets[0]?.key ?? '');
  }, [targets, targetKey]);

  if (control === null) {
    return (
      <p className="border-t border-border pt-5 text-sm text-muted-foreground">
        Read only — no client of this project accepts commands right now.
      </p>
    );
  }
  const target = targets.find((candidate) => candidate.key === targetKey);

  const run = async (
    clientId: string,
    type: CommandType,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      await postCommand(clientId, type, {
        boardId: board.id,
        taskId: task.id,
        comment: comment.trim() || `HQ: ${label} “${task.title}”`,
        ...payload,
      });
      setResult({
        tone: 'ok',
        text: `${label.charAt(0).toUpperCase()}${label.slice(1)} queued. The project applies it through its lifecycle checks.`,
      });
    } catch (cause) {
      setResult({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const field =
    'h-9 min-w-0 flex-1 border border-border bg-background px-2 text-sm disabled:opacity-50';
  const secondary =
    'h-9 shrink-0 border border-border px-3 text-sm hover:bg-muted disabled:opacity-50';

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="text-sm font-semibold">Actions</h3>
      <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        rows={2}
        aria-label="Comment recorded with the change"
        placeholder="Comment recorded with the change (optional)"
        className="resize-y border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <select
          aria-label="Move to stage"
          value={stage}
          disabled={stages.length === 0 || busy}
          onChange={(event) => setStage(event.target.value as LifecycleStage)}
          className={field}
        >
          {stages.length === 0 && <option value={stage}>No further stage</option>}
          {stages.map((candidate) => (
            <option key={candidate} value={candidate}>
              Move to {candidate}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={stages.length === 0 || busy}
          onClick={() => void run(control.clientId, 'kanban-transition', { to: stage }, 'move')}
          className="h-9 shrink-0 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Move
        </button>
      </div>
      <div className="flex gap-2">
        <select
          aria-label="Assign to agent"
          value={targetKey}
          disabled={targets.length === 0 || busy}
          onChange={(event) => setTargetKey(event.target.value)}
          className={field}
        >
          {targets.length === 0 && <option value="">No live agent in this project</option>}
          {targets.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {candidate.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={target === undefined || !canAssignKanbanTask(task) || busy}
          title={
            !canAssignKanbanTask(task) ? 'Queued or running work cannot be reassigned' : undefined
          }
          onClick={() =>
            target !== undefined &&
            void run(
              control.clientId,
              'kanban-assign',
              { agentId: target.agentId, assignee: target.assignee },
              'assign',
            )
          }
          className={secondary}
        >
          Assign
        </button>
      </div>

      {!confirmDispatch ? (
        <button
          type="button"
          disabled={dispatch === null || !canDispatchKanbanTask(task) || busy}
          title={dispatch === null ? 'No client of this project runs a Director' : undefined}
          onClick={() => setConfirmDispatch(true)}
          className={cn(secondary, 'inline-flex items-center gap-2 self-start')}
        >
          <Play className="size-4" />
          Start a worker on this task…
        </button>
      ) : (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border border-warning/50 bg-warning/10 px-4 py-3 text-sm"
        >
          <p className="basis-full">
            The project’s Director reserves this task and starts a worker agent for it. The worker
            spends budget until it finishes or is interrupted.
          </p>
          {unfinished > 0 && (
            <p className="basis-full font-medium text-warning">
              {unfinished === 1
                ? 'One dependency is not finished yet'
                : `${unfinished} dependencies are not finished yet`}{' '}
              — the worker would start without their results.
            </p>
          )}
          <button
            type="button"
            disabled={busy || dispatch === null}
            onClick={() => {
              if (dispatch === null) return;
              setConfirmDispatch(false);
              void run(dispatch.clientId, 'kanban-dispatch', {}, 'dispatch');
            }}
            className="h-9 bg-foreground px-4 font-medium text-background disabled:opacity-50"
          >
            Confirm: start worker
          </button>
          <button
            type="button"
            onClick={() => setConfirmDispatch(false)}
            className="h-9 border border-border px-4 hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      )}

      {result !== null && (
        <p
          role="status"
          className={cn('text-sm', result.tone === 'ok' ? 'text-success' : 'text-destructive')}
        >
          {result.text}
        </p>
      )}
    </section>
  );
}
