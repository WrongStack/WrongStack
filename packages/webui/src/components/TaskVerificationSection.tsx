/**
 * TaskVerificationSection — the verification surface rendered for EVERY task
 * (not only those that already carry a report):
 *   - report present  → the existing VerificationReportPanel, unchanged;
 *   - verification running → spinner state;
 *   - no report       → explicit "Unverified" empty state + a "Run
 *     verification" action (kanban.task.verify round-trip).
 */
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { Loader2, ShieldQuestion } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAppTranslation } from '@/i18n';
import { verificationStateOf } from '@/lib/kanban-verification';
import { useKanbanStore } from '@/stores';
import { KanbanContractGraphPanel } from './KanbanContractGraphPanel';
import { VerificationReportPanel } from './VerificationReportPanel';

export function TaskVerificationSection({
  board,
  task,
  sendKanban,
}: {
  board: KanbanBoard;
  task: KanbanTask;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
}) {
  const { t } = useAppTranslation();
  const boardId = board.id;
  const activity = useKanbanStore((state) => state.verificationActivity[`${boardId}:${task.id}`]);
  const state = verificationStateOf(task, activity);

  let verification: ReactNode;
  if (state === 'running') {
    verification = (
      <div className="mt-4 flex items-center gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info">
        <Loader2 size={14} className="animate-spin" />
        {t('activity:taskVerify.verificationRunningChecksAreBeingExecuted')}
      </div>
    );
  } else if (task.verificationReport) {
    verification = (
      <div className="mt-4">
        <VerificationReportPanel report={task.verificationReport} />
        <button
          type="button"
          onClick={() => sendKanban('kanban.task.verify', { boardId, taskId: task.id })}
          className="mt-1.5 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
        >
          {t('activity:taskVerify.reRunVerification')}
        </button>
      </div>
    );
  } else {
    verification = (
      <div className="mt-4 rounded-md border border-dashed p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldQuestion size={14} />
          <span className="font-medium">{t('activity:taskVerify.unverified')}</span>
          <span>{t('activity:taskVerify.noVerificationReportExistsForThis')}</span>
        </div>
        <button
          type="button"
          onClick={() => sendKanban('kanban.task.verify', { boardId, taskId: task.id })}
          className="mt-2 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
        >
          {t('activity:taskVerify.runVerification')}
        </button>
      </div>
    );
  }

  return (
    <>
      <KanbanContractGraphPanel board={board} task={task} sendKanban={sendKanban} />
      {verification}
    </>
  );
}
