import { useAppTranslation } from '@/i18n';
import type { KanbanBoard, KanbanColumn, KanbanTask } from '@wrongstack/kanban';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { kanbanMetadataText } from '@/lib/kanban-metadata';
import { type TaskVerificationState, verificationStateOf } from '@/lib/kanban-verification';
import { cn } from '@/lib/utils';
import { useKanbanStore } from '@/stores';
import { priorityClass } from './KanbanTaskFields.js';
import { analyzeTaskRisk } from './TaskRiskPanel';

export interface TaskCardIntelligence {
  owner: string;
  route: string;
  blockers: number;
  attempts: string;
  fallbackCount: number;
  activeUsers: number;
  failed: boolean;
  criticalRisks: number;
  warningRisks: number;
  /** Verification display state derived from the persisted report. */
  verification: TaskVerificationState;
  /** Completed/total resolved child tasks, or null for leaf tasks. */
  subtaskCounts: { done: number; total: number } | null;
  /** Atomicity verdict when an assessment exists. */
  atomicityVerdict: 'atomic' | 'borderline' | 'needs_decomposition' | 'composite' | null;
  /** Evidence attachments on the verification report. */
  evidenceCount: number;
  /** A decomposition proposal awaiting approval. */
  pendingDecomposition: boolean;
}

export function deriveTaskCardIntelligence(
  board: KanbanBoard,
  task: KanbanTask,
  verificationActivity?: Record<string, { startedAt: number }>,
): TaskCardIntelligence {
  const assignment = task.assignment;
  const operationalFindings = analyzeTaskRisk(board, task, []).findings.filter(
    (finding) => finding.category === 'operational',
  );
  const provider = kanbanMetadataText(assignment?.provider);
  const model = kanbanMetadataText(assignment?.model);
  return {
    owner:
      kanbanMetadataText(assignment?.name) ??
      kanbanMetadataText(assignment?.agentId) ??
      kanbanMetadataText(assignment?.role) ??
      kanbanMetadataText(task.assignee) ??
      kanbanMetadataText(task.assignedAgent) ??
      'Unassigned',
    route:
      provider || model
        ? `${provider ? `${provider}/` : ''}${model ?? 'default'}`
        : assignment?.modelRouting === 'session'
          ? 'session default'
          : 'default route',
    blockers: (task.dependsOn ?? []).filter((dependencyId) => {
      const dependency = board.tasks.find((candidate) => candidate.id === dependencyId);
      return !dependency || !['completed', 'archived'].includes(dependency.status);
    }).length,
    attempts: assignment?.attempt
      ? `${assignment.attempt}${assignment.maxAttempts ? `/${assignment.maxAttempts}` : ''}`
      : '0',
    fallbackCount:
      (assignment?.fallbackProfile ? 1 : 0) + (assignment?.fallbackModels?.length ?? 0),
    activeUsers: (board.presence ?? []).filter((entry) => entry.taskId === task.id && entry.active)
      .length,
    failed: task.status === 'failed' || assignment?.status === 'failed' || !!assignment?.error,
    criticalRisks: operationalFindings.filter((finding) => finding.severity === 'critical').length,
    warningRisks: operationalFindings.filter((finding) => finding.severity === 'warning').length,
    verification: verificationStateOf(task, verificationActivity?.[`${board.id}:${task.id}`]),
    subtaskCounts: (() => {
      const childIds = task.childTaskIds ?? [];
      if (!childIds.length) return null;
      const children = childIds
        .map((childId) => board.tasks.find((candidate) => candidate.id === childId))
        .filter((child): child is KanbanTask => Boolean(child));
      if (!children.length) return null;
      return {
        done: children.filter((child) => ['completed', 'review', 'archived'].includes(child.status))
          .length,
        total: children.length,
      };
    })(),
    atomicityVerdict: task.atomicityAssessment?.verdict ?? null,
    evidenceCount: task.verificationReport?.attachments.length ?? 0,
    pendingDecomposition: task.decomposition?.status === 'proposed',
  };
}

/**
 * Signature of every BOARD-level input the per-card derivation reads:
 * dependency/child task statuses and the presence map. Task-envelope merges
 * (kanban.task.update / kanban.task.verification_completed, task removal)
 * swap a task WITHOUT bumping board.revision, so revision alone cannot
 * invalidate the cache — this signature changes exactly when the
 * derivation's board inputs change, and stays byte-identical across the
 * 5 s poll (same content). Keep this list in sync with
 * deriveTaskCardIntelligence / analyzeTaskRisk when they grow a new input.
 */
function boardIntelligenceSignature(board: KanbanBoard): string {
  const tasks = board.tasks
    .map((candidate) => `${candidate.id}:${candidate.status}`)
    .sort()
    .join('|');
  const presence = (board.presence ?? [])
    .filter((entry) => entry.active)
    .map((entry) => entry.taskId)
    .sort()
    .join('|');
  return `${board.id}|${tasks}|${presence}`;
}

/**
 * Compact key for the TASK-side inputs deriveTaskCardIntelligence reads.
 * The board-side inputs are covered by boardIntelligenceSignature; the
 * combined key must stay stable across the 5 s board poll (same content)
 * and change on any real input change.
 *
 * Keep in sync with deriveTaskCardIntelligence AND analyzeTaskRisk: the
 * task fields read there (dueDate, successCriteria check statuses, the
 * assignment lease/heartbeat/lastResult fields) all appear here.
 */
function taskIntelligenceKey(task: KanbanTask): string {
  const assignment = task.assignment;
  return [
    task.id,
    task.status,
    task.dueDate ?? '',
    task.assignee ?? '',
    task.assignedAgent ?? '',
    JSON.stringify(task.dependsOn ?? null),
    JSON.stringify(task.childTaskIds ?? null),
    JSON.stringify((task.successCriteria ?? []).map((check) => `${check.id}:${check.status}`)),
    task.atomicityAssessment?.verdict ?? '',
    task.verificationReport?.attachments.length ?? 0,
    task.decomposition?.status ?? '',
    assignment
      ? JSON.stringify({
          provider: assignment.provider,
          model: assignment.model,
          name: assignment.name,
          agentId: assignment.agentId,
          role: assignment.role,
          attempt: assignment.attempt,
          maxAttempts: assignment.maxAttempts,
          fallbackProfile: assignment.fallbackProfile,
          fallbackModels: assignment.fallbackModels,
          status: assignment.status,
          error: assignment.error,
          lastFailureKind: assignment.lastFailureKind,
          lastResult: assignment.lastResult,
          leaseExpiresAt: assignment.leaseExpiresAt,
          heartbeatAt: assignment.heartbeatAt,
          modelRouting: assignment.modelRouting,
        })
      : '',
  ].join(':');
}

export function KanbanColumnView({
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
  const { t } = useAppTranslation();
  const verificationActivity = useKanbanStore((state) => state.verificationActivity);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(null);

  // A drag that ends outside the board never fires the column's drop, so
  // reset the highlight whenever the parent clears the active drag.
  useEffect(() => {
    if (dragTaskId === null) {
      dragDepthRef.current = 0;
      setDragOver(false);
    }
  }, [dragTaskId]);

  // Two-step delete: disarm the armed trash button after a pause so a stray
  // click can't delete a card the user has moved away from.
  useEffect(() => {
    if (pendingDeleteTaskId === null) return;
    const timer = window.setTimeout(() => setPendingDeleteTaskId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [pendingDeleteTaskId]);

  // Per-card intelligence derives from the whole board (dependencies,
  // presence, assignment) and used to re-run analyzeTaskRisk for every card
  // on every render — including the 5 s board poll, which hands the store a
  // fresh board object with the SAME content. The cache key pairs the
  // board-content signature (see boardIntelligenceSignature) with a
  // fingerprint of the task inputs the derivation reads (see
  // taskIntelligenceKey), so poll renders serve the cached derivation while
  // a real change to any input (statuses, presence, the task itself)
  // re-derives. Envelope merges that skip a revision bump are caught by the
  // signatures themselves. Time-relative findings (overdue, lease-expired,
  // heartbeat-stale) flip on clock crossing with no field change, so a
  // coarse minute bucket bounds their staleness to ≤60 s and triggers a
  // one-time per-minute rebuild.
  const intelligenceCacheRef = useRef(new Map<string, TaskCardIntelligence>());
  const boardSignature = boardIntelligenceSignature(board);
  const timeBucket = Math.floor(Date.now() / 60_000);
  useEffect(() => {
    intelligenceCacheRef.current.clear();
  }, [boardSignature, timeBucket]);

  const tasks = board.tasks
    .filter((task) => task.columnId === column.id)
    .sort((a, b) => a.order - b.order);
  const empty = tasks.length === 0;

  // Cache lookup with a live verification override: spinner state lives in
  // the store (verificationActivity), not the board, so its verdict is
  // re-derived outside the cache even on a hit.
  const cachedCardIntelligence = (task: KanbanTask): TaskCardIntelligence => {
    const cache = intelligenceCacheRef.current;
    const key = `${boardSignature}|${timeBucket}|${taskIntelligenceKey(task)}`;
    const cached = cache.get(key);
    if (cached) {
      const activity = verificationActivity?.[`${board.id}:${task.id}`];
      const freshVerification = verificationStateOf(task, activity);
      if (freshVerification === cached.verification) return cached;
      // Persist the merge so the next poll render doesn't re-derive it: a
      // spinner start/stop can happen without a board revision bump.
      const merged = { ...cached, verification: freshVerification };
      cache.set(key, merged);
      return merged;
    }
    const intelligence = deriveTaskCardIntelligence(board, task, verificationActivity);
    cache.set(key, intelligence);
    return intelligence;
  };
  return (
    <section
      className={cn(
        'flex h-full shrink-0 flex-col rounded-md border bg-muted/25 transition-[width] duration-200',
        dragOver && 'border-primary/70 bg-primary/5',
        empty ? 'w-[180px]' : 'w-[310px]',
      )}
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
      <ul
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2 [scrollbar-gutter:stable]"
        onDragEnter={(event) => {
          event.preventDefault();
          // dragenter/dragleave fire on every child boundary, so count
          // nesting depth instead of toggling on each leave.
          dragDepthRef.current += 1;
          setDragOver(true);
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragOver(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepthRef.current = 0;
          setDragOver(false);
          if (board.lifecycle?.mode === 'managed') {
            setDragTaskId(null);
            return;
          }
          // Prefer the id carried by the drop event: it survives re-renders
          // (the 5s board poll) that can stale the React state copy.
          const droppedTaskId = event.dataTransfer.getData('text/plain') || dragTaskId;
          // The dataTransfer payload is UNTRUSTED — a foreign drag (text from
          // another window/app) can carry arbitrary content. Only honor ids
          // that name a task on this board; anything else is a no-op drop.
          if (droppedTaskId && board.tasks.some((candidate) => candidate.id === droppedTaskId)) {
            onMoveTask(droppedTaskId, column.id);
          }
          setDragTaskId(null);
        }}
      >
        {tasks.map((task) => {
          const intelligence = cachedCardIntelligence(task);
          return (
            <li
              key={task.id}
              draggable={board.lifecycle?.mode !== 'managed'}
              onDragStart={(event) => {
                if (board.lifecycle?.mode === 'managed') return;
                setDragTaskId(task.id);
                // Firefox only initiates an HTML5 drag after setData; the id
                // is also readable by the drop target even if this component
                // re-renders mid-drag.
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', task.id);
              }}
              onDragEnd={() => setDragTaskId(null)}
              className={cn(
                'relative rounded-md border bg-background p-3 shadow-sm transition-colors',
                selectedTaskId === task.id ? 'border-primary' : 'hover:border-primary/50',
              )}
            >
              <button
                type="button"
                aria-label={`Select task: ${task.title}`}
                onClick={() => onSelectTask(task.id)}
                className="absolute inset-0 cursor-pointer rounded-md"
              />
              <div className="pointer-events-none relative flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {(task.atomic || intelligence.atomicityVerdict) && (
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 py-0.5 text-[10px] font-medium',
                          intelligence.atomicityVerdict === 'needs_decomposition'
                            ? 'bg-destructive/15 text-destructive'
                            : intelligence.atomicityVerdict === 'composite'
                              ? 'bg-info/15 text-info'
                              : intelligence.atomicityVerdict === 'borderline'
                                ? 'bg-warning/15 text-warning'
                                : task.atomic
                                  ? 'bg-warning/15 text-warning'
                                  : 'bg-muted text-muted-foreground',
                        )}
                        title={
                          intelligence.atomicityVerdict
                            ? `Atomicity: ${intelligence.atomicityVerdict}`
                            : 'Atomic task (subtree verification required)'
                        }
                      >
                        {task.atomic
                          ? 'atomic'
                          : intelligence.atomicityVerdict === 'needs_decomposition'
                            ? 'split me'
                            : intelligence.atomicityVerdict}
                      </span>
                    )}
                    <span className="line-clamp-2 text-sm font-medium leading-5">{task.title}</span>
                  </div>
                  {task.description && (
                    <div className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
                      {task.description}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  title={
                    pendingDeleteTaskId === task.id
                      ? t('activity:kanban.confirmDeleteTask')
                      : t('activity:kanban.deleteTask')
                  }
                  aria-label={
                    pendingDeleteTaskId === task.id
                      ? t('activity:kanban.confirmDeleteTaskAria', { title: task.title })
                      : t('activity:kanban.deleteTaskAria', { title: task.title })
                  }
                  onClick={() => {
                    if (pendingDeleteTaskId === task.id) {
                      setPendingDeleteTaskId(null);
                      onDeleteTask(task);
                    } else {
                      setPendingDeleteTaskId(task.id);
                    }
                  }}
                  onBlur={() =>
                    setPendingDeleteTaskId((value) => (value === task.id ? null : value))
                  }
                  className={cn(
                    'pointer-events-auto relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                    pendingDeleteTaskId === task.id
                      ? 'bg-destructive/15 text-destructive ring-1 ring-destructive/40'
                      : 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                  )}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="pointer-events-none relative mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                {board.lifecycle?.mode !== 'managed' && (
                  <select
                    aria-label={t('activity:kanban.moveTaskToColumn', { title: task.title })}
                    value={task.columnId}
                    draggable={false}
                    // The card's li is draggable; a drag initiated on the
                    // select would start a card drag. Stop propagation so
                    // the select keeps its native behavior, and ignore a
                    // "move" back to the card's own column.
                    onDragStart={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      if (event.target.value !== task.columnId)
                        onMoveTask(task.id, event.target.value);
                    }}
                    className="pointer-events-auto relative max-w-28 cursor-pointer rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    {board.columns.map((columnOption) => (
                      <option key={columnOption.id} value={columnOption.id}>
                        {columnOption.title}
                      </option>
                    ))}
                  </select>
                )}
                <span className={priorityClass(task.priority)}>{task.priority}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                  {task.status}
                </span>
                {intelligence.owner !== 'Unassigned' && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                    {intelligence.owner}
                  </span>
                )}
                {task.assignment && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {intelligence.route}
                  </span>
                )}
                {task.assignment?.attempt ? (
                  <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">
                    attempt {intelligence.attempts}
                  </span>
                ) : null}
                {intelligence.fallbackCount > 0 && (
                  <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">
                    {intelligence.fallbackCount} fallback
                  </span>
                )}
                {intelligence.blockers > 0 ? (
                  <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                    {intelligence.blockers} blocker
                  </span>
                ) : null}
                {intelligence.activeUsers > 0 && (
                  <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">
                    {intelligence.activeUsers} active
                  </span>
                )}
                {intelligence.failed && (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                    {t('activity:kanban.runFailed')}
                  </span>
                )}
                {intelligence.criticalRisks > 0 && (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                    {intelligence.criticalRisks} critical risk
                  </span>
                )}
                {intelligence.warningRisks > 0 && (
                  <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                    {intelligence.warningRisks} warning
                  </span>
                )}
                {task.chain && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                    chain {task.chain.order + 1}
                  </span>
                )}
                {task.assignment?.skills?.length ? (
                  <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">
                    {task.assignment.skills.length} skills
                  </span>
                ) : null}
                {intelligence.verification !== 'unverified' && (
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5',
                      intelligence.verification === 'passed'
                        ? 'bg-success/10 text-success'
                        : intelligence.verification === 'failed'
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-warning/10 text-warning',
                    )}
                  >
                    ✓ {intelligence.verification}
                  </span>
                )}
                {intelligence.subtaskCounts && (
                  <span className="rounded bg-info/10 px-1.5 py-0.5 text-info">
                    {intelligence.subtaskCounts.done}/{intelligence.subtaskCounts.total} subtasks
                  </span>
                )}
                {intelligence.evidenceCount > 0 && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                    {intelligence.evidenceCount} evidence
                  </span>
                )}
                {intelligence.pendingDecomposition && (
                  <span className="rounded bg-warning/10 px-1.5 py-0.5 text-warning">
                    {t('activity:kanban.splitPendingApproval')}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
