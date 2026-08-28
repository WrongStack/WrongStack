/**
 * TechStackView — virtualized dependency list.
 *
 * A resolved monorepo runs to thousands of rows, so the list is virtualized
 * with `virtua`'s VList (same pattern as `FileExplorer` / `ChatView`). The
 * column header sits outside the VList because the list owns the scroll
 * container exclusively.
 */

import { VList } from 'virtua';
import { usePagination } from '@/hooks/usePagination';
import type { TechStackDependency } from '@/stores';
import { cn } from '@/lib/utils';
import { Badge, coverageMeta, EcosystemIcon, ecosystemLabel, installedVersion, statusMeta, versionDrift } from './shared';
import { Pagination } from '../ui/pagination';
import { useAppTranslation } from '@/i18n';

interface DependencyTableProps {
  dependencies: readonly TechStackDependency[];
  selectedId: string | null;
  hasDependencies: boolean;
  coverageByWorkspaceId?: ReadonlyMap<string, string> | undefined;
  onSelect: (dependency: TechStackDependency) => void;
}

const GRID = 'grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.1fr)] gap-2';

export function DependencyTable({
  dependencies,
  selectedId,
  hasDependencies,
  coverageByWorkspaceId,
  onSelect,
}: DependencyTableProps) {
  const { t } = useAppTranslation();
  const dependencyPage = usePagination(dependencies, 30);
  if (dependencies.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="max-w-xs text-xs text-muted-foreground">
          {hasDependencies
            ? 'No dependencies match the current filters.'
            : 'No dependencies inventoried yet. Run a scan to populate the inventory.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          GRID,
          'shrink-0 border-b border-border/70 bg-card/45 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground',
        )}
      >
        <span>{t('activity:techStack.package')}</span>
        <span>{t('activity:techStack.installedLatest')}</span>
        <span>{t('activity:techStack.status')}</span>
      </div>
      {/* No list/listitem roles: VList wraps each child in its own div, so the
          required list→listitem parent-child relationship can't hold through
          it. The rows are buttons — focusable and labelled by their content. */}
      <div className="min-h-0 flex-1">
        <VList className="h-full" aria-label={t('activity:techStack.dependencies')}>
          {dependencyPage.pageItems.map((dependency) => (
            <DependencyRow
              key={dependency.id}
              dependency={dependency}
              selected={dependency.id === selectedId}
              coverage={coverageByWorkspaceId?.get(dependency.workspaceId)}
              onSelect={onSelect}
            />
          ))}
        </VList>
      </div>
      <Pagination
        page={dependencyPage.page}
        pageSize={dependencyPage.pageSize}
        totalItems={dependencyPage.totalItems}
        onPageChange={dependencyPage.setPage}
        itemLabel="dependencies"
      />
    </div>
  );
}

function DependencyRow({
  dependency,
  selected,
  coverage,
  onSelect,
}: {
  dependency: TechStackDependency;
  selected: boolean;
  coverage: string | undefined;
  onSelect: (dependency: TechStackDependency) => void;
}) {
  const { t } = useAppTranslation();
  const meta = statusMeta(dependency.status);
  const installed = installedVersion(dependency);
  const drift = versionDrift(dependency);
  const depCoverageNoteKey = coverage ? coverageMeta(coverage).noteKey : undefined;

  return (
    <button
      type="button"
      onClick={() => onSelect(dependency)}
      aria-current={selected}
      className={cn(
        GRID,
        'w-full items-center border-b border-border/40 px-3 py-2 text-left transition-colors hover:bg-accent/40',
        selected && 'bg-accent/60',
      )}
    >
      {/* Package */}
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn('size-1.5 shrink-0', meta.dot)} aria-hidden="true" />
          <span className="truncate font-mono text-xs text-foreground">{dependency.name}</span>
        </div>
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          <EcosystemIcon ecosystem={dependency.ecosystem} className="mr-0.5 inline-block size-3 align-text-bottom" />
          {ecosystemLabel(dependency.ecosystem, t)}
          {' · '}
          {dependency.direct ? 'direct' : 'transitive'}
          {' · '}
          {dependency.scope}
          {depCoverageNoteKey && (
            <>
              {' · '}
              <span className="text-warning">{t(depCoverageNoteKey)}</span>
            </>
          )}
        </p>
      </div>

      {/* Installed → Latest — the drift column. */}
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11px]">
          <span className="truncate text-foreground">{installed ?? '—'}</span>
          {dependency.latestStable && dependency.latestStable !== installed && (
            <>
              <span className="shrink-0 text-muted-foreground">→</span>
              <span className="truncate text-info">{dependency.latestStable}</span>
            </>
          )}
        </div>
        {drift.label ? (
          <p className="mt-0.5 truncate text-[10px] text-warning">{drift.label}</p>
        ) : (
          dependency.requested && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
              {dependency.requested}
            </p>
          )
        )}
      </div>

      {/* Status */}
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Badge className={meta.badge}>{t(meta.labelKey)}</Badge>
        {dependency.deprecated && (
          <Badge className="border-destructive/35 bg-destructive/10 text-destructive">dep</Badge>
        )}
        {dependency.yanked && (
          <Badge className="border-destructive/45 bg-destructive/15 text-destructive">yank</Badge>
        )}
      </div>
    </button>
  );
}
