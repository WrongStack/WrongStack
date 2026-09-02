/**
 * KanbanVerificationDashboard — board-wide Definition-of-Done quality view:
 * verified/unverified/failed counts, failing checks, missing evidence, and
 * atomicity debt (tasks needing decomposition, pending proposals).
 * Every row clicks through to the task inspector.
 */
import { useAppTranslation } from '@/i18n';
import type { KanbanBoard } from '@wrongstack/kanban';
import { AlertTriangle, ShieldCheck, ShieldQuestion, ShieldX, Scissors } from 'lucide-react';
import { useMemo } from 'react';
import { selectVerificationSummary } from '@/lib/kanban-verification';
import { cn } from '@/lib/utils';
import { ProgressRing } from './ui/progress-ring';

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'destructive' | 'warning' | 'muted';
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div
        className={cn(
          'text-xl font-bold',
          tone === 'success' && 'text-success',
          tone === 'destructive' && 'text-destructive',
          tone === 'warning' && 'text-warning',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function TaskRowList({
  title,
  icon: Icon,
  tone,
  rows,
  onSelectTask,
}: {
  title: string;
  icon: typeof ShieldX;
  tone: string;
  rows: Array<{ id: string; taskId: string; primary: string; secondary?: string | undefined }>;
  onSelectTask: (id: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <div className="rounded-md border bg-background">
      <div className={cn('flex items-center gap-2 border-b px-3 py-2 text-xs font-semibold', tone)}>
        <Icon size={14} />
        {title}
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {rows.length}
        </span>
      </div>
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onSelectTask(row.taskId)}
              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs hover:bg-muted/40"
            >
              <span className="font-medium">{row.primary}</span>
              {row.secondary && (
                <span className="text-[11px] text-muted-foreground">{row.secondary}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function KanbanVerificationDashboard({
  board,
  onSelectTask,
}: {
  board: KanbanBoard;
  onSelectTask: (id: string) => void;
}) {
  const { t } = useAppTranslation();
  // Keyed on the board's per-write revision (bumped by every mutateBoard
  // write, stable across the 5s poll's fresh board identities) instead of the
  // object itself — poll churn otherwise re-derived the whole summary on
  // every render. selectVerificationSummary reads only board.tasks, which
  // revision covers exactly.
  const summary = useMemo(() => selectVerificationSummary(board), [board.id, board.revision]);
  const verifiedPct = summary.gradedTasks ? (summary.passed / summary.gradedTasks) * 100 : 0;

  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="flex items-center gap-4 rounded-md border bg-background p-4">
        <ProgressRing pct={verifiedPct} />
        <div>
          <div className="text-sm font-semibold">{t('activity:kanban.definitionOfDone')}</div>
          <div className="text-xs text-muted-foreground">
            {summary.passed} of {summary.gradedTasks} graded tasks verified passed ·{' '}
            {summary.totalTasks} tasks total
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="verified" value={summary.passed} tone="success" />
        <Stat label="failed" value={summary.failed} tone="destructive" />
        <Stat
          label={t('activity:verifyReport.verdictNeedsHuman')}
          value={summary.needsHuman}
          tone="warning"
        />
        <Stat label="incomplete" value={summary.incomplete} tone="warning" />
        <Stat label="unverified" value={summary.unverified} tone="muted" />
      </div>

      <TaskRowList
        title={t('activity:kanban.failingChecks')}
        icon={ShieldX}
        tone="text-destructive"
        onSelectTask={onSelectTask}
        rows={summary.failingChecks.map(({ task, check }) => ({
          id: `${task.id}:${check.checkId}`,
          taskId: task.id,
          primary: task.title,
          secondary: `${check.description}${check.error ? ` — ${check.error}` : ''}`,
        }))}
      />

      <TaskRowList
        title={t('activity:kanban.evidenceMissing')}
        icon={AlertTriangle}
        tone="text-warning"
        onSelectTask={onSelectTask}
        rows={summary.missingEvidence.map(({ task, check }) => ({
          id: `${task.id}:${check.checkId}`,
          taskId: task.id,
          primary: task.title,
          secondary: check.description,
        }))}
      />

      <TaskRowList
        title={t('activity:kanban.needsDecomposition')}
        icon={Scissors}
        tone="text-warning"
        onSelectTask={onSelectTask}
        rows={summary.needsDecomposition.map((task) => ({
          id: task.id,
          taskId: task.id,
          primary: task.title,
          secondary: `atomicity score ${task.atomicityAssessment?.score ?? '?'} — split before dispatch`,
        }))}
      />

      <TaskRowList
        title={t('activity:kanban.decompositionPending')}
        icon={ShieldQuestion}
        tone="text-info"
        onSelectTask={onSelectTask}
        rows={summary.pendingProposals.map((task) => ({
          id: task.id,
          taskId: task.id,
          primary: task.title,
          secondary: `${task.decomposition?.proposedSubtasks.length ?? 0} proposed subtasks`,
        }))}
      />

      {summary.failingChecks.length === 0 &&
        summary.missingEvidence.length === 0 &&
        summary.needsDecomposition.length === 0 &&
        summary.pendingProposals.length === 0 && (
          <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 p-3 text-xs text-success">
            <ShieldCheck size={14} />
            {t('activity:kanban.noOutstanding')}
          </div>
        )}
    </div>
  );
}
