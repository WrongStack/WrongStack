/**
 * TechStackView — dependency filter toolbar.
 *
 * Fully controlled, no internal state (mirrors `MemoryManager/MemoryFilters`).
 */

import { FilterX, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ecosystemLabel, statusMeta } from './shared';
import { useAppTranslation } from '@/i18n';

export type DependencySort = 'attention' | 'name' | 'drift';

interface TechStackToolbarProps {
  searchQuery: string;
  ecosystemFilter: string;
  statusFilter: string;
  directOnly: boolean;
  sort: DependencySort;
  hasFilters: boolean;
  ecosystems: Array<[string, number]>;
  statuses: Array<[string, number]>;
  visibleCount: number;
  totalCount: number;
  onSearchChange: (value: string) => void;
  onEcosystemFilterChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onToggleDirectOnly: () => void;
  onSortChange: (value: DependencySort) => void;
  onClearFilters: () => void;
}

export function TechStackToolbar({
  searchQuery,
  ecosystemFilter,
  statusFilter,
  directOnly,
  sort,
  hasFilters,
  ecosystems,
  statuses,
  visibleCount,
  totalCount,
  onSearchChange,
  onEcosystemFilterChange,
  onStatusFilterChange,
  onToggleDirectOnly,
  onSortChange,
  onClearFilters,
}: TechStackToolbarProps) {
  const { t } = useAppTranslation();
  return (
    <div className="shrink-0 space-y-2 border-b border-border/70 bg-card/45 p-3">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('activity:techStack.searchDependencies')}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('activity:techStack.searchByPackageName')}
            className="h-10 min-w-0 bg-background pl-9 pr-8 text-xs"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label={t('activity:techStack.clearSearch')}
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Button
          variant={directOnly ? 'default' : 'outline'}
          size="sm"
          onClick={onToggleDirectOnly}
          aria-pressed={directOnly}
          title={t('activity:techStack.showOnlyDependenciesThisProjectDeclaresItself')}
          className="shrink-0"
        >
          {t('activity:techStack.directOnly')}
        </Button>
        {hasFilters && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearFilters}
            aria-label={t('activity:techStack.clearAllFilters')}
            title={t('activity:techStack.clearAllFilters')}
            className="shrink-0"
          >
            <FilterX className="size-4" />
          </Button>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="sr-only" htmlFor="techstack-ecosystem-filter">
            {t('activity:techStack.filterByEcosystem')}
          </label>
          <select
            id="techstack-ecosystem-filter"
            value={ecosystemFilter}
            onChange={(event) => onEcosystemFilterChange(event.target.value)}
            className="h-9 w-full min-w-0 border border-input bg-background px-2 text-xs"
          >
            <option value="all">{t('activity:techStack.allEcosystems')}</option>
            {ecosystems.map(([ecosystem, count]) => (
              <option key={ecosystem} value={ecosystem}>
                {ecosystemLabel(ecosystem, t)} · {count}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="sr-only" htmlFor="techstack-status-filter">
            {t('activity:techStack.filterByStatus')}
          </label>
          <select
            id="techstack-status-filter"
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.target.value)}
            className="h-9 w-full min-w-0 border border-input bg-background px-2 text-xs"
          >
            <option value="all">{t('activity:techStack.allStatuses')}</option>
            {statuses.map(([status, count]) => (
              <option key={status} value={status}>
                {t(statusMeta(status).labelKey)} · {count}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="sr-only" htmlFor="techstack-sort">
            {t('activity:techStack.sortDependencies')}
          </label>
          <select
            id="techstack-sort"
            value={sort}
            onChange={(event) => onSortChange(event.target.value as DependencySort)}
            className="h-9 w-full min-w-0 border border-input bg-background px-2 text-xs"
          >
            <option value="attention">{t('activity:techStack.sortNeedsAttention')}</option>
            <option value="drift">{t('activity:techStack.sortMostOutOfDate')}</option>
            <option value="name">{t('activity:techStack.sortName')}</option>
          </select>
        </div>
      </div>

      <p className={cn('text-[10px] text-muted-foreground', hasFilters && 'text-info')}>
        {visibleCount === totalCount
          ? `${totalCount} dependencies`
          : `${visibleCount} of ${totalCount} dependencies`}
      </p>
    </div>
  );
}
