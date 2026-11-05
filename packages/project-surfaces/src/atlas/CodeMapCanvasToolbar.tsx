import { Boxes, Flame, Layers, Orbit } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { CodeMapLayout, GraphRefType } from './codemap-model';

export function CodeMapCanvasToolbar({
  layout,
  canvasMode,
  edgeFilter,
  canvasNodeCount,
  graphNodeCount,
  blastOverlayMode,
  onLayoutChange,
  onCanvasModeChange,
  onEdgeFilterChange,
  onToggleBlastOverlay,
}: {
  layout: CodeMapLayout;
  canvasMode: 'smart' | 'all';
  edgeFilter: 'all' | GraphRefType;
  canvasNodeCount: number;
  graphNodeCount: number;
  blastOverlayMode?: boolean | undefined;
  onLayoutChange: (layout: CodeMapLayout) => void;
  onCanvasModeChange: (mode: 'smart' | 'all') => void;
  onEdgeFilterChange: (filter: 'all' | GraphRefType) => void;
  onToggleBlastOverlay?: (() => void) | undefined;
}) {
  const { t } = useAppTranslation();
  return (
    <div className="ws-code-toolbar pointer-events-none absolute left-3 right-3 top-3 z-10 flex items-center gap-2">
      <div className="pointer-events-auto flex border bg-card/95 shadow-md backdrop-blur">
        <button
          type="button"
          className={cn(
            'flex h-8 items-center gap-1.5 border-r px-2.5 text-[9px] font-semibold uppercase tracking-wider',
            layout === 'layers'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
          onClick={() => onLayoutChange('layers')}
        >
          <Layers className="h-3 w-3" /> {t('activity:codeMap.layers')}
        </button>
        <button
          type="button"
          className={cn(
            'flex h-8 items-center gap-1.5 border-r px-2.5 text-[9px] font-semibold uppercase tracking-wider',
            layout === 'orbit'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
          onClick={() => onLayoutChange('orbit')}
        >
          <Orbit className="h-3 w-3" /> {t('activity:codeMap.relations')}
        </button>
        <button
          type="button"
          className={cn(
            'flex h-8 items-center gap-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-wider',
            layout === 'subsystems'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
          onClick={() => onLayoutChange('subsystems')}
          title={t('activity:codeMap.groupNodesByTheSubsystemTheyBelongTo')}
        >
          <Boxes className="h-3 w-3" /> {t('activity:codeMap.subsystems')}
        </button>
      </div>
      <div className="pointer-events-auto flex border bg-card/95 shadow-md backdrop-blur">
        <button
          type="button"
          className={cn(
            'h-8 border-r px-2.5 font-mono text-[9px] font-bold',
            canvasMode === 'smart'
              ? 'bg-success text-success-foreground'
              : 'text-muted-foreground hover:bg-muted',
          )}
          onClick={() => onCanvasModeChange('smart')}
          title={t(
            'activity:codeMap.keepTheFullTreeShowTheStrongestRelationsAndSelectedNeighbourhood',
          )}
        >
          SMART {canvasNodeCount}/{graphNodeCount}
        </button>
        <button
          type="button"
          className={cn(
            'h-8 px-2.5 font-mono text-[9px] font-bold',
            canvasMode === 'all'
              ? 'bg-foreground text-background'
              : 'text-muted-foreground hover:bg-muted',
          )}
          onClick={() => onCanvasModeChange('all')}
          title={t('activity:codeMap.renderEveryNodeAndRelationInThisScope')}
        >
          {t('activity:codeMap.all')}
        </button>
      </div>
      {onToggleBlastOverlay && (
        <div className="pointer-events-auto flex border bg-card/95 shadow-md backdrop-blur">
          <button
            type="button"
            className={cn(
              'flex h-8 items-center gap-1.5 px-2.5 font-mono text-[9px] font-bold uppercase tracking-wider',
              blastOverlayMode
                ? 'bg-warning text-warning-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
            onClick={onToggleBlastOverlay}
            aria-pressed={Boolean(blastOverlayMode)}
            title={t('activity:codeMapText.blastTitle')}
          >
            <Flame className="h-3 w-3" /> BLAST
          </button>
        </div>
      )}
      <div className="pointer-events-auto ml-auto flex max-w-[60%] overflow-x-auto border bg-card/95 shadow-md backdrop-blur">
        {(['all', 'import', 'call', 'type_ref', 'inherit', 'implement'] as const).map((filter) => (
          <button
            type="button"
            key={filter}
            className={cn(
              'h-8 whitespace-nowrap border-r px-2.5 font-mono text-[9px] last:border-r-0',
              edgeFilter === filter
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted',
            )}
            onClick={() => onEdgeFilterChange(filter)}
          >
            {filter === 'all'
              ? t('activity:codeMapText.allLinks')
              : filter.replace('_', ' ').toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
