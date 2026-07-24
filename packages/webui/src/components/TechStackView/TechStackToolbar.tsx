/**
 * TechStackView — dependency filter toolbar.
 *
 * Fully controlled, no internal state (mirrors `MemoryManager/MemoryFilters`).
 */

import { FilterX, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ecosystemMeta, statusMeta } from './shared';

export type DependencySort = 'attention' | 'name' | 'drift';

export interface TechStackToolbarProps {
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
  return (
    <div className="shrink-0 space-y-2 border-b border-border/70 bg-card/45 p-3">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search dependencies"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search by package name…"
            className="h-10 min-w-0 bg-background pl-9 pr-8 text-xs"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear search"
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
          title="Show only dependencies this project declares itself"
          className="shrink-0"
        >
          Direct only
        </Button>
        {hasFilters && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearFilters}
            aria-label="Clear all filters"
            title="Clear all filters"
            className="shrink-0"
          >
            <FilterX className="size-4" />
          </Button>
        )}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="sr-only" htmlFor="techstack-ecosystem-filter">
            Filter by ecosystem
          </label>
          <select
            id="techstack-ecosystem-filter"
            value={ecosystemFilter}
            onChange={(event) => onEcosystemFilterChange(event.target.value)}
            className="h-9 w-full min-w-0 border border-input bg-background px-2 text-xs"
          >
            <option value="all">All ecosystems</option>
            {ecosystems.map(([ecosystem, count]) => (
              <option key={ecosystem} value={ecosystem}>
                {ecosystemMeta(ecosystem).label} · {count}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="sr-only" htmlFor="techstack-status-filter">
            Filter by status
          </label>
          <select
            id="techstack-status-filter"
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.target.value)}
            className="h-9 w-full min-w-0 border border-input bg-background px-2 text-xs"
          >
            <option value="all">All statuses</option>
            {statuses.map(([status, count]) => (
              <option key={status} value={status}>
                {statusMeta(status).label} · {count}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="sr-only" htmlFor="techstack-sort">
            Sort dependencies
          </label>
          <select
            id="techstack-sort"
            value={sort}
            onChange={(event) => onSortChange(event.target.value as DependencySort)}
            className="h-9 w-full min-w-0 border border-input bg-background px-2 text-xs"
          >
            <option value="attention">Sort: needs attention</option>
            <option value="drift">Sort: most out of date</option>
            <option value="name">Sort: name</option>
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
