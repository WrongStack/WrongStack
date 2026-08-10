import { cn } from '@/lib/utils';

export type KanbanViewMode = 'focus' | 'board' | 'tree' | 'contracts' | 'dashboard';

const KANBAN_VIEW_MODES = [
  ['focus', 'Focus'],
  ['board', 'Board'],
  ['tree', 'Tree'],
  ['contracts', 'Contract Map'],
  ['dashboard', 'Verification'],
] as const satisfies ReadonlyArray<readonly [KanbanViewMode, string]>;

export function KanbanViewModeTabs({
  viewMode,
  onViewModeChange,
}: {
  viewMode: KanbanViewMode;
  onViewModeChange: (mode: KanbanViewMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-4 py-1.5">
      {KANBAN_VIEW_MODES.map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onViewModeChange(mode)}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
            viewMode === mode
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
