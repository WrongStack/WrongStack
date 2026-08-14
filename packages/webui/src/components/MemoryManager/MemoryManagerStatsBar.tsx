import { BrainCircuit } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import type { SageEntry, SageStats } from '@/types';
import { MetricCard } from './shared';

export function MemoryManagerStatsBar({
  stats,
  memories,
  filteredCount,
  allTagsCount,
}: {
  stats: SageStats | null;
  memories: SageEntry[];
  filteredCount: number;
  allTagsCount: number;
}) {
  const { t } = useAppTranslation();

  const scopedCount = memories.filter((m) => m.audience).length;
  const roles = new Set<string>();
  if (scopedCount > 0) {
    for (const m of memories) {
      if (!m.audience) continue;
      for (const r of m.audience.roles ?? []) roles.add(r);
      for (const r of m.audience.taskTypes ?? []) roles.add(r);
      for (const r of m.audience.modes ?? []) roles.add(r);
    }
  }

  return (
    <>
      <div className="grid shrink-0 grid-cols-2 gap-px border-b border-border/70 bg-border/60 sm:grid-cols-4">
        <MetricCard
          label={t('activity:memoryManager.tabMemories')}
          value={stats?.total ?? memories.length}
          hint={`${filteredCount} visible`}
        />
        <MetricCard
          label={t('activity:memoryManager.tabActive')}
          value={
            stats?.byStatus.active ?? memories.filter((memory) => memory.status === 'active').length
          }
          hint="retrievable"
          tone="success"
        />
        <MetricCard
          label={t('activity:memoryManager.tabNeedsReview')}
          value={(stats?.byStatus.stale ?? 0) + (stats?.byStatus.contradicted ?? 0)}
          hint={t('activity:memoryManager.staleConflicts')}
          tone="warning"
        />
        <div className="hidden sm:block">
          <MetricCard
            label={t('activity:memoryManager.tabGraphEdges')}
            value={stats?.edges ?? 0}
            hint={`${allTagsCount} tags`}
            tone="info"
          />
        </div>
      </div>

      {scopedCount > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-primary/5 px-4 py-1.5">
          <BrainCircuit className="size-3.5 text-primary" />
          <span className="text-[11px] font-medium text-primary">
            {scopedCount} audience-scoped memory{scopedCount !== 1 ? 'ies' : ''}
          </span>
          {roles.size > 0 && (
            <span className="text-[10px] text-muted-foreground">
              ({[...roles].sort().join(', ')})
            </span>
          )}
        </div>
      )}
    </>
  );
}
