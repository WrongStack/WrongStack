import { AlertTriangle, ChevronDown, CircleAlert, Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { KanbanAuditIssue, KanbanAuditSummary } from '@/lib/kanban-cleaner';
import { cn } from '@/lib/utils';

export function KanbanCleanerAlert({
  audit,
  onSelectTask,
}: {
  audit: KanbanAuditSummary;
  onSelectTask: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  // Issue ids seen on the previous audit pass. Auto-expanding on a count
  // *change* (old behavior) fought the user's collapse whenever an issue
  // appeared or vanished; only a genuinely NEW issue deserves attention.
  const seenIssueIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    const ids = new Set(audit.issues.map((issue) => issue.id));
    const previous = seenIssueIdsRef.current;
    seenIssueIdsRef.current = ids;
    if (previous === null) return;
    if ([...ids].some((id) => !previous.has(id))) setExpanded(true);
  }, [audit.issues]);

  if (audit.issues.length === 0) return null;

  const grouped = groupByTask(audit.issues);
  return (
    <section
      aria-labelledby={`${contentId}-title`}
      className="shrink-0 border-b border-warning/25 bg-card/95 shadow-[inset_0_1px_0_hsl(var(--warning)/0.08)]"
    >
      <div className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2" role="status" aria-live="polite">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-warning/25 bg-warning/10 text-warning">
            <Sparkles size={14} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id={`${contentId}-title`} className="text-xs font-semibold text-foreground">
              Kanban Cleaner found {audit.issues.length}{' '}
              {audit.issues.length === 1 ? 'issue' : 'issues'}
            </h2>
            <p className="truncate text-[10px] text-muted-foreground">
              {audit.affectedTaskCount}{' '}
              {audit.affectedTaskCount === 1 ? 'card needs' : 'cards need'} attention
            </p>
          </div>
        </div>
        {audit.counts.error > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-destructive/25 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
            <CircleAlert size={11} aria-hidden="true" /> {audit.counts.error} critical
          </span>
        )}
        {audit.counts.warning > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
            <AlertTriangle size={11} aria-hidden="true" /> {audit.counts.warning} warning
          </span>
        )}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={expanded ? 'Collapse Kanban Cleaner issues' : 'Expand Kanban Cleaner issues'}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn('transition-transform', expanded && 'rotate-180')}
          />
        </button>
      </div>

      {expanded && (
        <ul
          id={contentId}
          className="grid max-h-36 gap-1 overflow-y-auto px-3 pb-2 sm:grid-cols-2 sm:px-4 xl:grid-cols-3"
        >
          {grouped.map(({ taskId, taskTitle, issues }) => (
            <li key={taskId}>
              <button
                type="button"
                onClick={() => onSelectTask(taskId)}
                aria-label={`Open ${taskTitle}: ${issues.map((issue) => issue.message).join(', ')}`}
                className="group flex w-full items-start gap-2 rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span
                  className={cn(
                    'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                    issues.some((issue) => issue.severity === 'error')
                      ? 'bg-destructive shadow-[0_0_8px_hsl(var(--destructive)/0.55)]'
                      : 'bg-warning shadow-[0_0_8px_hsl(var(--warning)/0.45)]',
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-foreground group-hover:text-primary">
                    {taskTitle}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                    {issues.map((issue) => issue.message).join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function groupByTask(issues: readonly KanbanAuditIssue[]): Array<{
  taskId: string;
  taskTitle: string;
  issues: KanbanAuditIssue[];
}> {
  const groups = new Map<
    string,
    { taskId: string; taskTitle: string; issues: KanbanAuditIssue[] }
  >();
  for (const issue of issues) {
    const existing = groups.get(issue.taskId);
    if (existing) {
      existing.issues.push(issue);
    } else {
      groups.set(issue.taskId, {
        taskId: issue.taskId,
        taskTitle: issue.taskTitle,
        issues: [issue],
      });
    }
  }
  return [...groups.values()];
}
