import type { WorktreeHandleView } from '@/types';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';

const STATUS_META: Record<string, { icon: string; labelKey: string; tint: string; dot: string }> = {
  allocating: {
    icon: '○',
    labelKey: 'statusAllocating',
    tint: 'border-muted-foreground/40',
    dot: 'bg-muted-foreground',
  },
  active: {
    icon: '●',
    labelKey: 'statusActive',
    tint: 'border-warning/40',
    dot: 'bg-warning animate-pulse',
  },
  committing: {
    icon: '◐',
    labelKey: 'statusCommitting',
    tint: 'border-primary/40',
    dot: 'bg-primary animate-pulse',
  },
  merging: {
    icon: '⇡',
    labelKey: 'statusMerging',
    tint: 'border-info/40',
    dot: 'bg-info animate-pulse',
  },
  merged: { icon: '✓', labelKey: 'statusMerged', tint: 'border-success/40', dot: 'bg-success' },
  'needs-review': {
    icon: '⚠',
    labelKey: 'statusConflict',
    tint: 'border-destructive/50',
    dot: 'bg-destructive',
  },
  failed: {
    icon: '✗',
    labelKey: 'statusFailed',
    tint: 'border-destructive/50',
    dot: 'bg-destructive',
  },
};

function meta(status: string) {
  return (
    STATUS_META[status] ?? {
      icon: '?',
      labelKey: '',
      tint: 'border-border',
      dot: 'bg-muted-foreground',
    }
  );
}

const shortBranch = (b: string) => b.replace(/^wstack\/ap\//, '');

/**
 * WorktreeLanes — one horizontal swim-lane per git worktree. Shows status,
 * branch, owner phase, live diff stats, and a flowing recent-activity strip.
 * Pure/props-driven; animations are Tailwind.
 */
export function WorktreeLanes({
  worktrees,
  baseBranch,
}: {
  worktrees: WorktreeHandleView[];
  baseBranch: string;
}): React.ReactElement | null {
  const { t } = useAppTranslation();
  const sorted = [...worktrees].sort((a, b) => a.allocatedAt - b.allocatedAt);
  // Worktrees are bounded (active worktrees), show all without pagination.
  return (
    <div className="rounded-lg border bg-card/50 backdrop-blur-sm px-3 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold tracking-wide uppercase text-[10px]">
          {t('activity:worktree.lanesHeading')}
        </span>
        <span className="opacity-60">· {t('activity:worktree.base')}</span>
        <code className="font-mono text-primary">{baseBranch || 'HEAD'}</code>
        <span className="opacity-60">
          · {t('activity:worktree.isolatedCount', { count: sorted.length })}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {sorted.map((w) => {
          const m = meta(w.status);
          const conflict = w.status === 'needs-review';
          const magnitude = Math.min(100, w.insertions + w.deletions);
          return (
            <div
              key={w.handleId}
              className={cn(
                'group relative flex items-center gap-3 rounded-lg border px-3 py-2 transition-all duration-500',
                'bg-background/60 hover:bg-accent/20',
                m.tint,
              )}
            >
              <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', m.dot)} aria-hidden />
              <code className="w-44 shrink-0 truncate font-mono text-sm">
                {shortBranch(w.branch)}
              </code>
              <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                ⟵ {w.ownerLabel}
              </span>

              {/* live diff-stat badge */}
              {conflict ? (
                <span className="font-mono text-xs font-bold text-destructive">
                  {t('activity:worktree.conflictBadge')}
                </span>
              ) : (
                <span className="flex items-center gap-1 font-mono text-xs transition-all duration-500">
                  <span className="text-success">+{w.insertions}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-destructive">-{w.deletions}</span>
                  <span className="ml-1 text-muted-foreground">{w.files}f</span>
                </span>
              )}

              {/* magnitude bar */}
              <div className="ml-auto hidden h-1 w-24 overflow-hidden rounded-full bg-muted sm:block">
                <div
                  className="h-full bg-gradient-to-r from-success to-destructive transition-all duration-700"
                  style={{ width: `${magnitude}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                {m.labelKey ? t(`activity:worktree.${m.labelKey}`) : w.status}
              </span>

              {/* flowing recent activity (last item) */}
              {w.recentActivity.length > 0 ? (
                <span className="absolute -bottom-2 left-9 max-w-[60%] truncate rounded bg-muted px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  {w.recentActivity[w.recentActivity.length - 1]?.kind}:{' '}
                  {w.recentActivity[w.recentActivity.length - 1]?.text}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
