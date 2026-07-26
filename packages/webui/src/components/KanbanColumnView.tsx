import type { KanbanBoard, KanbanColumn, KanbanTask } from '@wrongstack/kanban';
import { Trash2 } from 'lucide-react';
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
  const verificationActivity = useKanbanStore((state) => state.verificationActivity);
  const tasks = board.tasks
    .filter((task) => task.columnId === column.id)
    .sort((a, b) => a.order - b.order);
  const empty = tasks.length === 0;
  return (
    <section
      className={cn(
        'flex h-full shrink-0 flex-col rounded-md border bg-muted/25 transition-[width] duration-200',
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
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (board.lifecycle?.mode !== 'managed' && dragTaskId) {
            onMoveTask(dragTaskId, column.id);
          }
          setDragTaskId(null);
        }}
      >
        {tasks.map((task) => {
          const intelligence = deriveTaskCardIntelligence(board, task, verificationActivity);
          return (
            <li
              key={task.id}
              draggable={board.lifecycle?.mode !== 'managed'}
              onDragStart={() => {
                if (board.lifecycle?.mode !== 'managed') setDragTaskId(task.id);
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
                  title="Delete task"
                  aria-label={`Delete task: ${task.title}`}
                  onClick={() => onDeleteTask(task)}
                  className="pointer-events-auto relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="pointer-events-none relative mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
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
                    run failed
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
                    split pending approval
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
