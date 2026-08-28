import type { KanbanManualActivityKind, KanbanManualActivityOutcome } from '@wrongstack/kanban';
import { Plus } from 'lucide-react';
import { useAppTranslation } from '@/i18n';

type KanbanTaskActivityRecorderProps = {
  activityKind: KanbanManualActivityKind;
  activityOutcome: KanbanManualActivityOutcome;
  note: string;
  details: string;
  onActivityKindChange: (value: KanbanManualActivityKind) => void;
  onActivityOutcomeChange: (value: KanbanManualActivityOutcome) => void;
  onNoteChange: (value: string) => void;
  onDetailsChange: (value: string) => void;
  onRecordActivity: () => void;
};

export function KanbanTaskActivityRecorder({
  activityKind,
  activityOutcome,
  note,
  details,
  onActivityKindChange,
  onActivityOutcomeChange,
  onNoteChange,
  onDetailsChange,
  onRecordActivity,
}: KanbanTaskActivityRecorderProps) {
  const { t } = useAppTranslation();
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
        {t('activity:kanbanRecorder.recordDecisionOutcome')}
      </div>
      <div className="mb-1.5 grid grid-cols-2 gap-1.5">
        <select
          value={activityKind}
          onChange={(event) => onActivityKindChange(event.target.value as KanbanManualActivityKind)}
          aria-label={t('activity:kanbanRecorder.taskActivityKind')}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          {['decision', 'attempt', 'result', 'blocker', 'observation'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={activityOutcome}
          onChange={(event) =>
            onActivityOutcomeChange(event.target.value as KanbanManualActivityOutcome)
          }
          aria-label={t('activity:kanbanRecorder.taskActivityOutcome')}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          {['unknown', 'succeeded', 'failed', 'partial', 'skipped'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-1.5">
        <input
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && onRecordActivity()}
          placeholder={t('activity:kanbanRecorder.whatWasDecidedAttemptedOrProduced')}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={onRecordActivity}
          className="h-8 rounded-md border px-2 hover:bg-muted"
          aria-label={t('activity:kanbanRecorder.recordTaskDecisionOrOutcome')}
        >
          <Plus size={14} />
        </button>
      </div>
      <input
        value={details}
        onChange={(event) => onDetailsChange(event.target.value)}
        placeholder={t('activity:kanbanRecorder.optionalEvidenceRationaleCommandLinkOrFailureDetail')}
        aria-label={t('activity:kanbanRecorder.taskActivityDetails')}
        className="mt-1.5 h-8 w-full rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
      />
    </div>
  );
}
