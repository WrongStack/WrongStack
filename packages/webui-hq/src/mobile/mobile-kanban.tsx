import type { HqKanbanSnapshotPayload, HqSnapshot } from '@wrongstack/core/hq';
import { Clock3, Columns3, Play, RefreshCw, Send, TriangleAlert, UserRoundCog } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Select, Textarea } from '../components/ui/input.js';
import { fetchJson, postCommand } from '../data/api.js';
import { useHqStore } from '../data/store/index.js';
import {
  type HqKanbanTaskView,
  projectKanbanBoards,
  projectKanbanUrl,
} from '../domain/kanban-model.js';

type LifecycleStage = 'backlog' | 'todo' | 'running' | 'review' | 'done';

const STAGES: readonly LifecycleStage[] = ['backlog', 'todo', 'running', 'review', 'done'];
const REFRESH_MS = 10_000;

export interface MobileKanbanAssignmentTarget {
  key: string;
  agentId: string;
  label: string;
}

export function mobileKanbanAssignmentTargets(
  snapshot: HqSnapshot | null,
  projectId: string,
): MobileKanbanAssignmentTarget[] {
  const targets = new Map<string, MobileKanbanAssignmentTarget>();
  for (const session of snapshot?.liveSessions ?? []) {
    if (session.projectId !== projectId) continue;
    for (const agent of session.agents) {
      const key = `${session.sessionId}:${agent.id}`;
      targets.set(key, {
        key,
        agentId: agent.id,
        label: `${agent.name} · ${session.hostname ?? session.machineId} · ${agent.status}`,
      });
    }
  }
  return [...targets.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function stageFromTask(task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage'>): LifecycleStage {
  if (task.lifecycleStage !== undefined) return task.lifecycleStage;
  if (task.status === 'ready') return 'todo';
  if (task.status === 'in_progress') return 'running';
  if (task.status === 'review') return 'review';
  if (task.status === 'completed') return 'done';
  return 'backlog';
}

export function kanbanTransitionOptions(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage'>,
): LifecycleStage[] {
  const currentIndex = STAGES.indexOf(stageFromTask(task));
  if (currentIndex < 0 || currentIndex === STAGES.length - 1) return [];
  return STAGES.filter((_, index) => Math.abs(index - currentIndex) === 1);
}

export function suggestedKanbanStage(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage'>,
): LifecycleStage {
  return kanbanTransitionOptions(task).at(-1) ?? stageFromTask(task);
}

export function canAssignKanbanTask(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage' | 'assignmentStatus'>,
): boolean {
  return (
    stageFromTask(task) !== 'done' &&
    task.status !== 'archived' &&
    task.assignmentStatus !== 'queued' &&
    task.assignmentStatus !== 'running'
  );
}

export function canDispatchKanbanTask(
  task: Pick<HqKanbanTaskView, 'status' | 'lifecycleStage' | 'assignmentStatus'>,
): boolean {
  return (
    stageFromTask(task) === 'todo' &&
    task.assignmentStatus !== 'queued' &&
    task.assignmentStatus !== 'running'
  );
}

export function MobileKanban(): React.ReactElement {
  const snapshot = useHqStore((state) => state.snapshot);
  const projects = snapshot?.projects ?? [];
  const [projectId, setProjectId] = useState('');
  const [payload, setPayload] = useState<HqKanbanSnapshotPayload | null>(null);
  const [boardId, setBoardId] = useState('');
  const [selectedTask, setSelectedTask] = useState<HqKanbanTaskView | null>(null);
  const [assignmentTask, setAssignmentTask] = useState<HqKanbanTaskView | null>(null);
  const [assignmentTargetKey, setAssignmentTargetKey] = useState('');
  const [assignmentComment, setAssignmentComment] = useState('');
  const [dispatchTask, setDispatchTask] = useState<HqKanbanTaskView | null>(null);
  const [dispatchComment, setDispatchComment] = useState('');
  const [stage, setStage] = useState<LifecycleStage>('todo');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (projects.length === 0) setProjectId('');
    else if (!projects.some((project) => project.projectId === projectId)) {
      setProjectId(projects[0]!.projectId);
    }
  }, [projectId, projects]);

  const load = useCallback(async (): Promise<void> => {
    if (projectId === '') return;
    const requestId = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await fetchJson<HqKanbanSnapshotPayload>(projectKanbanUrl(projectId));
      if (requestId !== requestSeq.current) return;
      setPayload(next);
      setError(null);
    } catch (cause) {
      if (requestId === requestSeq.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === requestSeq.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setPayload(null);
    setBoardId('');
    setSelectedTask(null);
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      requestSeq.current += 1;
      window.clearInterval(timer);
    };
  }, [load]);

  const boards = useMemo(() => (payload === null ? [] : projectKanbanBoards(payload)), [payload]);
  useEffect(() => {
    if (boards.length === 0) setBoardId('');
    else if (!boards.some((board) => board.id === boardId)) setBoardId(boards[0]!.id);
  }, [boardId, boards]);
  const board = boards.find((candidate) => candidate.id === boardId) ?? null;
  const assignmentTargets = useMemo(
    () => mobileKanbanAssignmentTargets(snapshot, projectId),
    [projectId, snapshot],
  );
  const controlClient =
    snapshot?.clients.find(
      (client) =>
        client.connected &&
        client.projectId === projectId &&
        client.capabilities.includes('control.receive'),
    ) ?? null;
  const dispatchClient =
    snapshot?.clients.find(
      (client) =>
        client.connected &&
        client.projectId === projectId &&
        client.capabilities.includes('control.receive') &&
        client.capabilities.includes('kanban.dispatch'),
    ) ?? null;

  const openTransition = (task: HqKanbanTaskView): void => {
    setSelectedTask(task);
    setStage(suggestedKanbanStage(task));
    setComment(`HQ mobile: transition “${task.title}” from ${task.status}`);
    setError(null);
    setStatus(null);
  };

  const openAssignment = (task: HqKanbanTaskView): void => {
    const firstTarget = assignmentTargets[0];
    if (firstTarget === undefined) return;
    setAssignmentTask(task);
    setAssignmentTargetKey(firstTarget.key);
    setAssignmentComment(`HQ mobile: assign “${task.title}” to ${firstTarget.label}`);
    setError(null);
    setStatus(null);
  };

  const dispatch = async (): Promise<void> => {
    if (
      selectedTask === null ||
      board === null ||
      controlClient === null ||
      comment.trim() === ''
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await postCommand(controlClient.clientId, 'kanban-transition', {
        boardId: board.id,
        taskId: selectedTask.id,
        to: stage,
        comment: comment.trim(),
      });
      setStatus(`Transition queued · ${result.commandId}`);
      setSelectedTask(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const transitionOptions = selectedTask === null ? [] : kanbanTransitionOptions(selectedTask);
  const assign = async (): Promise<void> => {
    const target = assignmentTargets.find((candidate) => candidate.key === assignmentTargetKey);
    if (
      assignmentTask === null ||
      board === null ||
      controlClient === null ||
      target === undefined ||
      assignmentComment.trim() === ''
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await postCommand(controlClient.clientId, 'kanban-assign', {
        boardId: board.id,
        taskId: assignmentTask.id,
        agentId: target.agentId,
        assignee: target.label,
        comment: assignmentComment.trim(),
      });
      setStatus(`Assignment queued · ${result.commandId}`);
      setAssignmentTask(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const openDispatch = (task: HqKanbanTaskView): void => {
    setDispatchTask(task);
    setDispatchComment(`HQ mobile: dispatch “${task.title}” through the project Director`);
    setError(null);
    setStatus(null);
  };
  const dispatchWork = async (): Promise<void> => {
    if (
      dispatchTask === null ||
      board === null ||
      dispatchClient === null ||
      dispatchComment.trim() === ''
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await postCommand(dispatchClient.clientId, 'kanban-dispatch', {
        boardId: board.id,
        taskId: dispatchTask.id,
        comment: dispatchComment.trim(),
      });
      setStatus(`Dispatch queued · ${result.commandId}`);
      setDispatchTask(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="mobile-kanban" className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <div>
          <h2 className="font-display text-base font-semibold">Kanban control</h2>
          <p className="text-[11px] text-muted-foreground">
            Lifecycle-gated transitions through the project IPC owner
          </p>
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Refresh mobile Kanban"
          disabled={loading}
          onClick={() => void load()}
          className="ml-auto"
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <Select
          aria-label="Mobile Kanban project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.projectName}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Mobile Kanban board"
          value={boardId}
          disabled={boards.length === 0}
          onChange={(event) => setBoardId(event.target.value)}
        >
          {boards.length === 0 && <option value="">No boards</option>}
          {boards.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </Select>
      </div>

      {status !== null && <p className="mb-2 text-[11px] text-success">{status}</p>}
      {error !== null && (
        <p className="mb-2 flex items-center gap-1 text-[11px] text-destructive">
          <TriangleAlert className="size-3" />
          {error}
        </p>
      )}

      {board === null ? (
        <div className="border border-border p-6 text-center text-xs text-muted-foreground">
          <Columns3 className="mx-auto mb-2 size-5" />
          {loading ? 'Loading boards…' : 'No board snapshot is available.'}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <strong className="font-display text-sm">{board.title}</strong>
            <Badge tone={controlClient === null ? 'idle' : 'active'} className="ml-auto">
              {controlClient === null ? 'read only' : 'control ready'}
            </Badge>
            <Badge tone={dispatchClient === null ? 'idle' : 'active'}>
              {dispatchClient === null ? 'dispatch unavailable' : 'dispatch ready'}
            </Badge>
          </div>
          {board.columns.map((column) => (
            <div key={column.id} className="space-y-1.5">
              <div className="flex items-center gap-2 border-b border-border pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em]">
                  {column.title}
                </span>
                <Badge tone="idle" className="ml-auto">
                  {column.tasks.length}
                </Badge>
              </div>
              {column.tasks.map((task) => (
                <div key={task.id} className="flex border border-border bg-card">
                  <button
                    type="button"
                    data-testid="mobile-kanban-task"
                    disabled={controlClient === null || kanbanTransitionOptions(task).length === 0}
                    onClick={() => openTransition(task)}
                    className="min-w-0 flex-1 space-y-1 p-2.5 text-left disabled:opacity-60"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 text-xs font-medium">{task.title}</span>
                      <Badge
                        tone={
                          task.status === 'failed' || task.status === 'blocked' ? 'error' : 'info'
                        }
                      >
                        {task.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <Clock3 className="size-3" />
                      {task.assignee ?? 'unassigned'}
                      <span className="ml-auto">
                        {kanbanTransitionOptions(task).length === 0
                          ? 'terminal stage'
                          : 'tap to transition'}
                      </span>
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Assign ${task.title}`}
                    disabled={
                      controlClient === null ||
                      assignmentTargets.length === 0 ||
                      !canAssignKanbanTask(task)
                    }
                    onClick={() => openAssignment(task)}
                    className="m-1 self-center"
                  >
                    <UserRoundCog />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Dispatch ${task.title}`}
                    disabled={dispatchClient === null || !canDispatchKanbanTask(task)}
                    onClick={() => openDispatch(task)}
                    className="m-1 ml-0 self-center"
                  >
                    <Play />
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={selectedTask !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedTask(null);
        }}
      >
        <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>Transition task?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedTask?.title} · every lifecycle and completion gate remains active.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Select
            aria-label="Kanban transition target"
            value={stage}
            onChange={(event) => setStage(event.target.value as LifecycleStage)}
          >
            {transitionOptions.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </Select>
          <Textarea
            aria-label="Kanban transition audit comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || comment.trim() === ''}
              onClick={() => void dispatch()}
            >
              <Send />
              {busy ? 'Queueing…' : 'Confirm transition'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={dispatchTask !== null}
        onOpenChange={(open) => {
          if (!open) setDispatchTask(null);
        }}
      >
        <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>Dispatch task?</AlertDialogTitle>
            <AlertDialogDescription>
              {dispatchTask?.title} · the Director will claim the ready card, create a fenced lease,
              spawn its worker and advance it to Running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            aria-label="Kanban dispatch reason"
            value={dispatchComment}
            onChange={(event) => setDispatchComment(event.target.value)}
            rows={3}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || dispatchComment.trim() === ''}
              onClick={() => void dispatchWork()}
            >
              <Play />
              {busy ? 'Queueing…' : 'Confirm dispatch'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={assignmentTask !== null}
        onOpenChange={(open) => {
          if (!open) setAssignmentTask(null);
        }}
      >
        <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>Assign task?</AlertDialogTitle>
            <AlertDialogDescription>
              {assignmentTask?.title} · active queued/running owners cannot be replaced.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Select
            aria-label="Kanban assignment target"
            value={assignmentTargetKey}
            onChange={(event) => {
              const key = event.target.value;
              setAssignmentTargetKey(key);
              const target = assignmentTargets.find((candidate) => candidate.key === key);
              if (assignmentTask !== null && target !== undefined) {
                setAssignmentComment(
                  `HQ mobile: assign “${assignmentTask.title}” to ${target.label}`,
                );
              }
            }}
          >
            {assignmentTargets.map((target) => (
              <option key={target.key} value={target.key}>
                {target.label}
              </option>
            ))}
          </Select>
          <Textarea
            aria-label="Kanban assignment audit comment"
            value={assignmentComment}
            onChange={(event) => setAssignmentComment(event.target.value)}
            rows={3}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || assignmentComment.trim() === ''}
              onClick={() => void assign()}
            >
              <UserRoundCog />
              {busy ? 'Queueing…' : 'Confirm assignment'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
