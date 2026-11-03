import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { useAppTranslation } from '../lib/i18n';
import { ChipMultiSelect } from '../ui/ChipMultiSelect';
import { Field, SelectField } from './KanbanTaskFields';

interface KanbanTaskContractFieldsProps {
  board: KanbanBoard | null;
  task: KanbanTask;
  status: KanbanTask['status'];
  setStatus: (status: KanbanTask['status']) => void;
  priority: KanbanTask['priority'];
  setPriority: (priority: KanbanTask['priority']) => void;
  taskType: NonNullable<KanbanTask['type']>;
  setTaskType: (type: NonNullable<KanbanTask['type']>) => void;
  labelsText: string;
  setLabelsText: (text: string) => void;
  dueDate: string;
  setDueDate: (date: string) => void;
  estimatedHours: string;
  setEstimatedHours: (hours: string) => void;
  actualHours: string;
  setActualHours: (hours: string) => void;
  dependsOn: string[];
  setDependsOn: (ids: string[]) => void;
  chainMembers: string[];
  setChainMembers: (ids: string[]) => void;
  enforceChainDependencies: boolean;
  setEnforceChainDependencies: (on: boolean) => void;
}

/** Status, priority, type, schedule, dependency and chain fields of a task's contract. */
export function KanbanTaskContractFields({
  board,
  task,
  status,
  setStatus,
  priority,
  setPriority,
  taskType,
  setTaskType,
  labelsText,
  setLabelsText,
  dueDate,
  setDueDate,
  estimatedHours,
  setEstimatedHours,
  actualHours,
  setActualHours,
  dependsOn,
  setDependsOn,
  chainMembers,
  setChainMembers,
  enforceChainDependencies,
  setEnforceChainDependencies,
}: KanbanTaskContractFieldsProps) {
  const { t } = useAppTranslation();
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {board?.lifecycle?.mode === 'managed' ? (
          <div className="rounded-md border bg-muted/30 px-2 py-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('activity:kanban.managedStage')}
            </div>
            <div className="mt-1 text-xs font-semibold capitalize">
              {task.lifecycle?.currentStage ?? 'Backlog'}
            </div>
          </div>
        ) : (
          <SelectField
            label={t('activity:kanban.status')}
            value={status}
            options={[
              'pending',
              'ready',
              'in_progress',
              'blocked',
              'review',
              'completed',
              'failed',
              'archived',
            ]}
            onChange={(value) => setStatus(value as KanbanTask['status'])}
          />
        )}
        <SelectField
          label={t('activity:kanban.priority')}
          value={priority}
          options={['critical', 'high', 'medium', 'low']}
          onChange={(value) => setPriority(value as KanbanTask['priority'])}
        />
        <SelectField
          label={t('activity:kanban.type')}
          value={taskType}
          options={['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore']}
          onChange={(value) => setTaskType(value as NonNullable<KanbanTask['type']>)}
        />
        <Field
          label={t('activity:kanban.labelsCommaSeparated')}
          value={labelsText}
          onChange={setLabelsText}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('activity:kanban.dueDatePlaceholder')}
          value={dueDate}
          onChange={setDueDate}
        />
        <Field
          label={t('activity:kanban.estimatedHours')}
          value={estimatedHours}
          onChange={setEstimatedHours}
        />
        <Field
          label={t('activity:kanban.actualHours')}
          value={actualHours}
          onChange={setActualHours}
        />
      </div>
      <div>
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
          {t('activity:kanbanInspector.dependencies')}
        </span>
        <ChipMultiSelect
          options={(board?.tasks ?? [])
            .filter((candidate) => candidate.id !== task.id)
            .map((candidate) => ({
              value: candidate.id,
              label: candidate.title,
              description: candidate.status,
            }))}
          selected={dependsOn}
          onChange={setDependsOn}
          placeholder={t('activity:kanban.selectBlockingTasks')}
        />
      </div>
      <div>
        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
          {t('activity:kanbanInspector.taskChainSelectionOrder')}
        </span>
        <ChipMultiSelect
          options={(board?.tasks ?? []).map((candidate) => ({
            value: candidate.id,
            label: candidate.title,
            description: candidate.status,
          }))}
          selected={chainMembers}
          onChange={(next) => setChainMembers(next.includes(task.id) ? next : [task.id, ...next])}
          placeholder={t('activity:kanban.selectSequentialChain')}
        />
        <label className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={enforceChainDependencies}
            onChange={(event) => setEnforceChainDependencies(event.target.checked)}
          />
          {t('activity:kanban.enforceChainOrder')}
        </label>
      </div>
    </>
  );
}
