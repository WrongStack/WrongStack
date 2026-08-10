import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { CircleSlash, FileText, GitBranch, History, Play, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The inspector's tabs follow the card's own lifecycle: what the work is, who
 * runs it, what proves it is done, how it splits, and what already happened.
 * The order is the information — reading left to right walks the same path the
 * card walks, so "where is this stuck?" is answered by position, not by
 * hunting through one long scroll.
 */
export type TaskInspectorTab = 'definition' | 'execution' | 'evidence' | 'breakdown' | 'history';

export const TASK_INSPECTOR_TABS: ReadonlyArray<{
  key: TaskInspectorTab;
  icon: typeof FileText;
  labelKey: string;
}> = [
  { key: 'definition', icon: FileText, labelKey: 'activity:kanbanInspector.tabDefinition' },
  { key: 'execution', icon: Play, labelKey: 'activity:kanbanInspector.tabExecution' },
  { key: 'evidence', icon: ShieldCheck, labelKey: 'activity:kanbanInspector.tabEvidence' },
  { key: 'breakdown', icon: GitBranch, labelKey: 'activity:kanbanInspector.tabBreakdown' },
  { key: 'history', icon: History, labelKey: 'activity:kanbanInspector.tabHistory' },
];

/**
 * Titles of the unfinished cards this task waits on.
 *
 * Computed from the board in the browser rather than imported from the kanban
 * package: the readiness helpers live behind a Node-only entry point, and the
 * rule itself is one line — a dependency blocks until it is completed.
 */
export function blockingTaskTitles(board: KanbanBoard | null, task: KanbanTask): string[] {
  if (!board || !task.dependsOn?.length) return [];
  return task.dependsOn.flatMap((dependencyId) => {
    const dependency = board.tasks.find((candidate) => candidate.id === dependencyId);
    if (!dependency) return [`${dependencyId.slice(0, 8)} (missing)`];
    return dependency.status === 'completed' ? [] : [dependency.title];
  });
}

/** Per-tab counts, so the tab strip shows where the substance actually is. */
export function taskTabBadges(
  board: KanbanBoard | null,
  task: KanbanTask,
  taskEventCount: number,
): Partial<Record<TaskInspectorTab, number>> {
  const children = task.childTaskIds?.length ?? 0;
  const criteria = task.successCriteria?.length ?? 0;
  const attempts = task.assignment?.attempt ?? 0;
  void board;
  return {
    ...(attempts > 1 ? { execution: attempts } : {}),
    ...(criteria > 0 ? { evidence: criteria } : {}),
    ...(children > 0 ? { breakdown: children } : {}),
    ...(taskEventCount > 0 ? { history: taskEventCount } : {}),
  };
}

const STATUS_TONE: Record<string, string> = {
  in_progress: 'bg-warning/15 text-warning',
  review: 'bg-info/15 text-info',
  completed: 'bg-success/15 text-success',
  blocked: 'bg-destructive/15 text-destructive',
  failed: 'bg-destructive/15 text-destructive',
};

/**
 * The always-visible band above the tabs.
 *
 * Status, priority, the agent holding the card, and any unmet dependency are
 * the facts that decide whether to act at all. Putting them behind a tab would
 * mean the answer to "can this move?" depends on which tab happened to be
 * open, so they stay pinned regardless of the active tab.
 */
export function TaskStatusSpine({
  task,
  blockedBy,
  columnLabel,
  expanded,
  blockedLabel,
  regionLabel,
}: {
  task: KanbanTask;
  blockedBy: string[];
  columnLabel: string;
  expanded: boolean;
  blockedLabel: string;
  regionLabel: string;
}) {
  const chips: string[] = [
    columnLabel,
    task.priority,
    ...(task.assignment?.agentId ? [task.assignment.agentId] : []),
    ...(task.atomic ? ['atomic'] : []),
  ];

  return (
    <section
      aria-label={regionLabel}
      className={cn('border-b px-3 py-2', expanded && 'px-5 xl:px-7')}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            STATUS_TONE[task.status] ?? 'bg-muted text-muted-foreground',
          )}
        >
          {task.status}
        </span>
        {chips.map((chip) => (
          <span key={chip} className="text-[11px] text-muted-foreground">
            {chip}
          </span>
        ))}
      </div>
      {blockedBy.length > 0 && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-destructive">
          <CircleSlash size={13} className="mt-px shrink-0" />
          <span className="min-w-0">
            {blockedLabel} {blockedBy.join('; ')}
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * Tab strip. Scrolls horizontally instead of wrapping so the docked 420px
 * panel keeps every tab reachable without the row growing taller.
 */
export function TaskInspectorTabBar({
  active,
  onSelect,
  badges,
  labelFor,
  expanded,
}: {
  active: TaskInspectorTab;
  onSelect: (tab: TaskInspectorTab) => void;
  badges: Partial<Record<TaskInspectorTab, number>>;
  labelFor: (labelKey: string) => string;
  expanded: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={cn(
        'flex shrink-0 gap-0.5 overflow-x-auto border-b px-2',
        expanded && 'px-4 xl:px-6',
      )}
    >
      {TASK_INSPECTOR_TABS.map(({ key, icon: Icon, labelKey }) => {
        const isActive = key === active;
        const badge = badges[key];
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(key)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon size={14} className="shrink-0" />
            <span>{labelFor(labelKey)}</span>
            {badge !== undefined && (
              <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tab body. Expanded gets a reading column plus a metadata rail; docked stays
 * a single column, because a rail at 420px would starve both sides.
 */
export function TaskTabLayout({
  expanded,
  rail,
  children,
}: {
  expanded: boolean;
  rail?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!expanded || !rail) return <div className="space-y-3">{children}</div>;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-3">{children}</div>
      <div className="min-w-0 space-y-3 xl:border-l xl:pl-5">{rail}</div>
    </div>
  );
}
