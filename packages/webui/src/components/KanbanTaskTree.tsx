/**
 * KanbanTaskTree — the task hierarchy + verification tree view.
 * Renders the parent/child forest (parentTaskId/childTaskIds) as indented
 * rows: status icon, atomicity badge, verification state chip. Clicking a row
 * opens the task inspector.
 */
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDot,
  Loader2,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  X,
} from 'lucide-react';
import { useMemo } from 'react';
import {
  buildTaskTree,
  flattenTaskTree,
  type TaskVerificationState,
  verificationStateOf,
} from '@/lib/kanban-verification';
import { cn } from '@/lib/utils';
import { useKanbanStore } from '@/stores';
import { useAppTranslation } from '@/i18n';

const VERIFICATION_CHIP: Record<
  TaskVerificationState,
  { labelKey: string; className: string; icon: typeof ShieldCheck }
> = {
  unverified: {
    labelKey: 'activity:kanbanTree.verifyUnverified',
    className: 'bg-muted text-muted-foreground',
    icon: ShieldQuestion,
  },
  running: {
    labelKey: 'activity:kanbanTree.verifyVerifying',
    className: 'bg-info/10 text-info',
    icon: Loader2,
  },
  passed: {
    labelKey: 'activity:kanbanTree.verifyVerified',
    className: 'bg-success/10 text-success',
    icon: ShieldCheck,
  },
  failed: {
    labelKey: 'activity:kanbanTree.verifyFailed',
    className: 'bg-destructive/10 text-destructive',
    icon: ShieldX,
  },
  needs_human: {
    labelKey: 'activity:kanbanTree.verifyNeedsReview',
    className: 'bg-warning/10 text-warning',
    icon: AlertTriangle,
  },
  incomplete: {
    labelKey: 'activity:kanbanTree.verifyIncomplete',
    className: 'bg-warning/10 text-warning',
    icon: AlertTriangle,
  },
};

function StatusIcon({ task }: { task: KanbanTask }) {
  if (task.status === 'completed') return <Check size={13} className="text-success" />;
  if (task.status === 'failed') return <X size={13} className="text-destructive" />;
  if (task.status === 'in_progress')
    return <Loader2 size={13} className="animate-spin text-info" />;
  return <CircleDot size={13} className="text-muted-foreground" />;
}

export function KanbanTaskTree({
  board,
  selectedTaskId,
  onSelectTask,
}: {
  board: KanbanBoard;
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
}) {
  const { t } = useAppTranslation();
  const verificationActivity = useKanbanStore((state) => state.verificationActivity);
  // Same revision-keying as the column view: the 5s poll hands the store a
  // fresh board object with an unchanged per-write revision, so the tree
  // build must not re-run per poll. buildTaskTree reads only board.tasks —
  // revision covers it. Live verification spinners are store state, read
  // outside this memo per row.
  const rows = useMemo(() => flattenTaskTree(buildTaskTree(board)), [board.id, board.revision]);

  if (!rows.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('activity:kanbanTree.noTasksOnThisBoardYet')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <ul className="space-y-0.5">
        {rows.map(({ task, depth, children }) => {
          const verificationState = verificationStateOf(
            task,
            verificationActivity[`${board.id}:${task.id}`],
          );
          const verification = VERIFICATION_CHIP[verificationState];
          const VerificationIcon = verification.icon;
          const verdict = task.atomicityAssessment?.verdict;
          return (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onSelectTask(task.id)}
                style={{ paddingLeft: `${depth * 22 + 8}px` }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border py-1.5 pr-2 text-left text-xs transition-colors',
                  selectedTaskId === task.id
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent hover:border-primary/40 hover:bg-muted/40',
                )}
              >
                {children.length > 0 ? (
                  <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <StatusIcon task={task} />
                <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                {task.atomic && (
                  <span className="shrink-0 rounded bg-warning/15 px-1 py-0.5 text-[10px] text-warning">
                    atomic
                  </span>
                )}
                {verdict && verdict !== 'atomic' && (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 py-0.5 text-[10px]',
                      verdict === 'needs_decomposition'
                        ? 'bg-destructive/15 text-destructive'
                        : verdict === 'composite'
                          ? 'bg-info/15 text-info'
                          : 'bg-warning/15 text-warning',
                    )}
                  >
                    {verdict === 'needs_decomposition' ? 'split me' : verdict}
                  </span>
                )}
                {task.decomposition?.status === 'proposed' && (
                  <span className="shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[10px] text-warning">
                    {t('activity:kanbanTree.proposalPending')}
                  </span>
                )}
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                    verification.className,
                  )}
                >
                  <VerificationIcon
                    size={11}
                    className={verificationState === 'running' ? 'animate-spin' : undefined}
                  />
                  {t(verification.labelKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
