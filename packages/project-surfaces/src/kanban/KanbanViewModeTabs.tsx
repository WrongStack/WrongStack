import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';

export type KanbanViewMode = 'focus' | 'board' | 'tree' | 'contracts' | 'dashboard';

const KANBAN_VIEW_MODES = [
  ['focus', 'activity:kanbanText.view.focus'],
  ['board', 'activity:kanbanText.view.board'],
  ['tree', 'activity:kanbanText.view.tree'],
  ['contracts', 'activity:kanbanText.contractMap'],
  ['dashboard', 'activity:kanbanText.view.verification'],
] as const satisfies ReadonlyArray<readonly [KanbanViewMode, string]>;

export function KanbanViewModeTabs({
  viewMode,
  onViewModeChange,
}: {
  viewMode: KanbanViewMode;
  onViewModeChange: (mode: KanbanViewMode) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="ws-toolbar flex shrink-0 items-center gap-1 overflow-x-auto border-b px-4 py-1.5">
      {KANBAN_VIEW_MODES.map(([mode, labelKey]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onViewModeChange(mode)}
          className={cn(
            'shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
            viewMode === mode
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
