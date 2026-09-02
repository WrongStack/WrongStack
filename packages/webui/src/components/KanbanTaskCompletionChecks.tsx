import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { Check, Plus } from 'lucide-react';
import { useAppTranslation } from '@/i18n';

interface KanbanTaskCompletionChecksProps {
  board: KanbanBoard | null;
  task: KanbanTask;
  newCheck: string;
  onNewCheckChange: (value: string) => void;
  onAddCheck: () => void;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
}

export function KanbanTaskCompletionChecks({
  board,
  task,
  newCheck,
  onNewCheckChange,
  onAddCheck,
  sendKanban,
}: KanbanTaskCompletionChecksProps): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <div className="mt-5">
      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
        {t('activity:kanbanTaskCompletionChecks.completionChecks')}
      </div>
      <div className="space-y-1.5">
        {(task.successCriteria ?? []).map((check) => (
          <div
            key={check.id}
            className="grid grid-cols-[auto_1fr_92px] items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs"
          >
            <Check
              size={13}
              className={check.status === 'passed' ? 'text-success' : 'text-muted-foreground'}
            />
            <span className="min-w-0 truncate">{check.description}</span>
            <select
              value={check.status}
              onChange={(event) =>
                sendKanban('kanban.task.check.update', {
                  boardId: board?.id,
                  taskId: task.id,
                  checkId: check.id,
                  status: event.target.value,
                })
              }
              className="h-7 rounded border bg-background px-1 text-[11px]"
            >
              {['pending', 'passed', 'failed', 'skipped'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="flex gap-1.5">
          <input
            value={newCheck}
            onChange={(event) => onNewCheckChange(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && onAddCheck()}
            placeholder={t('activity:kanbanTaskCompletionChecks.addAVerifiableCompletionCheck')}
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
          />
          <button
            type="button"
            onClick={onAddCheck}
            className="h-8 rounded-md border px-2 hover:bg-muted"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
