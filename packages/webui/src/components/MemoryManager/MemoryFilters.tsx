import { useAppTranslation } from '@/i18n';
import { BrainCircuit, ChevronDown, FilterX, Search, Tag, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { SageStats, SageStatus } from '@/types';
import { KIND_LABELS, MEMORY_KINDS, MEMORY_STATUSES } from './shared';

interface MemoryFiltersProps {
  searchQuery: string;
  statusFilter: 'all' | SageStatus;
  kindFilter: string;
  audienceOnly: boolean;
  tagFilter: string | null;
  hasFilters: boolean;
  allTags: Array<[string, number]>;
  stats: SageStats | null;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: 'all' | SageStatus) => void;
  onKindFilterChange: (value: string) => void;
  onToggleAudienceOnly: () => void;
  onTagFilterChange: (value: string | null) => void;
  onClearFilters: () => void;
}

export function MemoryFilters({
  searchQuery,
  statusFilter,
  kindFilter,
  audienceOnly,
  tagFilter,
  hasFilters,
  allTags,
  stats,
  onSearchChange,
  onStatusFilterChange,
  onKindFilterChange,
  onToggleAudienceOnly,
  onTagFilterChange,
  onClearFilters,
}: MemoryFiltersProps) {
  const { t } = useAppTranslation();
  // The tag-chip row is the largest filter-area consumer. We collapse it by
  // default so the memory list gets the vertical space on first paint, but
  // auto-expand it when a tag is currently active (so the user can see and
  // toggle the chip that produced the filtered list).
  const [tagsExpanded, setTagsExpanded] = useState(Boolean(tagFilter));
  const tagsVisible = tagsExpanded || Boolean(tagFilter);
  const hasTags = allTags.length > 0;

  return (
    <div className="shrink-0 space-y-2 overflow-hidden border-b border-border/70 bg-card/45 p-3">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('activity:memoryManager.searchAria')}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t('activity:memoryManager.searchPlaceholder')}
            className="h-10 min-w-0 bg-background pl-9 pr-8 text-xs"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label={t('activity:memoryManager.clearSearchAria')}
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Button
          variant={audienceOnly ? 'default' : 'ghost'}
          size="icon"
          onClick={onToggleAudienceOnly}
          aria-label={t('activity:memoryManager.audienceFilterAria')}
          title={t('activity:memoryManager.audienceFilterTitle')}
          className="shrink-0"
        >
          <BrainCircuit className="size-4" />
        </Button>
        {hasFilters && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearFilters}
            aria-label={t('activity:memoryManager.clearFiltersAria')}
            title={t('activity:memoryManager.clearFiltersTitle')}
          >
            <FilterX className="size-4" />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="sr-only" htmlFor="memory-status-filter">
          {t('activity:memoryManager.filterByStatus')}
        </label>
        <select
          id="memory-status-filter"
          value={statusFilter}
          onChange={(event) =>
            onStatusFilterChange(event.target.value as 'all' | SageStatus)
          }
          className="h-9 min-w-0 border border-input bg-background px-2 text-xs"
        >
          <option value="all">{t('activity:memoryManager.allStatuses')}</option>
          {MEMORY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status} · {stats?.byStatus[status] ?? 0}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="memory-kind-filter">
          {t('activity:memoryManager.filterByKind')}
        </label>
        <select
          id="memory-kind-filter"
          value={kindFilter}
          onChange={(event) => onKindFilterChange(event.target.value)}
          className="h-9 min-w-0 border border-input bg-background px-2 text-xs"
        >
          <option value="all">{t('activity:memoryManager.allKinds')}</option>
          {MEMORY_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]} · {stats?.byKind[kind] ?? 0}
            </option>
          ))}
        </select>
      </div>
      {hasTags && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              // While a tag is active the row is forced open so the user can
              // see and untoggle the chip; ignore the click rather than
              // silently flipping state behind the parent's back.
              if (tagFilter) return;
              setTagsExpanded((value) => !value);
            }}
            aria-expanded={tagsVisible}
            aria-controls="memory-tags-panel"
            disabled={Boolean(tagFilter)}
            className={cn(
              'flex items-center gap-1.5 px-1 py-0.5 text-[10px] uppercase tracking-wide transition-colors',
              tagsVisible
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
              Boolean(tagFilter) && 'cursor-default',
            )}
            title={
              tagFilter
                ? `Active filter: ${tagFilter} (click the chip to clear)`
                : tagsVisible
                  ? 'Hide tag filters'
                  : `Show tag filters (${allTags.length})`
            }
          >
            <ChevronDown
              className={cn(
                'size-3 transition-transform',
                !tagsVisible && '-rotate-90',
              )}
            />
            <Tag className="size-3" />
            <span className="font-semibold">{t('activity:memoryManager.tagsLabel')}</span>
            <span className="font-mono text-[9px] text-muted-foreground">
              {allTags.length}
            </span>
          </button>
          {/* Active-tag badge lives OUTSIDE the toggle button so the toggle's
              accessible name stays stable (e.g. "Tags 3") regardless of which
              tag is active. Screen readers announce the badge separately. */}
          {tagFilter && (
            <span
              role="status"
              aria-label={`Active tag filter: ${tagFilter}`}
              className="border border-info/55 bg-info/10 px-1 font-mono text-[9px] uppercase text-info"
            >
              {tagFilter}
            </span>
          )}
        </div>
      )}
      {hasTags && tagsVisible && (
        <fieldset
          id="memory-tags-panel"
          className="min-w-0 border-0 p-0"
        >
          <legend className="sr-only">{t('activity:memoryManager.popularTags')}</legend>
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-0.5">
            {allTags.slice(0, 18).map(([tagName, count]) => (
              <button
                key={tagName}
                type="button"
                aria-pressed={tagFilter === tagName}
                onClick={() => onTagFilterChange(tagFilter === tagName ? null : tagName)}
                className={cn(
                  'flex shrink-0 items-center gap-1 border px-2 py-1 text-[10px] transition-colors',
                  tagFilter === tagName
                    ? 'border-info/55 bg-info/10 text-info'
                    : 'border-border/70 bg-background/45 text-muted-foreground hover:border-info/35 hover:text-foreground',
                )}
              >
                <Tag className="size-2.5" /> {tagName}
                <span className="font-mono opacity-60">{count}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
