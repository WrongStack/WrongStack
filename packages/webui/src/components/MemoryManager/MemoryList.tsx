import { useAppTranslation } from '@/i18n';
import { BrainCircuit, ChevronRight, Database, FilterX, Plus } from 'lucide-react';
import type { RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SageEntry } from '@/types';
import { KIND_LABELS, kindClasses, memoryPreview, relativeDate, StatusBadge } from './shared';

interface MemoryListProps {
  memoryListRef: RefObject<HTMLDivElement | null>;
  memories: SageEntry[];
  filteredMemories: SageEntry[];
  selectedId: string | null;
  onSelectMemory: (id: string) => void;
  onOpenCreate: () => void;
  onClearFilters: () => void;
}

// Only virtualize above this threshold — small lists render normally
// with zero virtualizer overhead.
const VIRTUALIZE_THRESHOLD = 100;

export function MemoryList({
  memoryListRef,
  memories,
  filteredMemories,
  selectedId,
  onSelectMemory,
  onOpenCreate,
  onClearFilters,
}: MemoryListProps) {
  const { t } = useAppTranslation();
  const useVirtual = filteredMemories.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: filteredMemories.length,
    getScrollElement: () => memoryListRef.current,
    estimateSize: () => 100,
    overscan: 8,
    enabled: useVirtual,
  });

  return (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
        <span>
          {t('activity:memoryManager.memoryCountSummary', {
            shown: filteredMemories.length,
            total: memories.length,
          })}
        </span>
        <span className="font-mono uppercase">{t('activity:memoryManager.updatedSortLabel')}</span>
      </div>

      <section
        ref={memoryListRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-label={t('activity:memoryManager.listAria')}
      >
        {filteredMemories.length === 0 ? (
          <MemoryListEmpty
            hasMemories={memories.length > 0}
            onOpenCreate={onOpenCreate}
            onClearFilters={onClearFilters}
          />
        ) : useVirtual ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const memory = filteredMemories[virtualItem.index];
              if (!memory) return null;
              return (
                <div
                  key={memory.id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <MemoryCard
                    memory={memory}
                    isSelected={selectedId === memory.id}
                    onClick={() => onSelectMemory(memory.id)}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          filteredMemories.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              isSelected={selectedId === memory.id}
              onClick={() => onSelectMemory(memory.id)}
            />
          ))
        )}
      </section>
    </>
  );
}

interface MemoryListEmptyProps {
  hasMemories: boolean;
  onOpenCreate: () => void;
  onClearFilters: () => void;
}

function MemoryListEmpty({ hasMemories, onOpenCreate, onClearFilters }: MemoryListEmptyProps) {
  const { t } = useAppTranslation();
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
      <span className="flex size-12 items-center justify-center border border-dashed border-border text-muted-foreground">
        <Database className="size-5" />
      </span>
      <h2 className="mt-4 text-sm font-bold">
        {hasMemories
          ? t('activity:memoryManager.noMatching')
          : t('activity:memoryManager.buildGraph')}
      </h2>
      <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
        {hasMemories
          ? t('activity:memoryManager.emptyFiltered')
          : t('activity:memoryManager.emptyCapture')}
      </p>
      <Button
        className="mt-4"
        variant="outline"
        size="sm"
        onClick={hasMemories ? onClearFilters : onOpenCreate}
      >
        {hasMemories ? <FilterX className="size-3.5" /> : <Plus className="size-3.5" />}
        {hasMemories
          ? t('activity:memoryManager.clearFilters')
          : t('activity:memoryManager.createFirst')}
      </Button>
    </div>
  );
}

interface MemoryCardProps {
  memory: SageEntry;
  isSelected: boolean;
  onClick: () => void;
}

function MemoryCard({ memory, isSelected, onClick }: MemoryCardProps) {
  return (
    <button
      type="button"
      aria-current={isSelected ? 'true' : undefined}
      onClick={onClick}
      className={cn(
        'group relative block w-full border-b border-border/55 px-3 py-3 text-left transition-[background-color,border-color] hover:bg-info/5',
        isSelected && 'bg-info/8',
      )}
    >
      {isSelected && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-info shadow-[0_0_10px_hsl(var(--info)/0.7)]" />
      )}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'truncate text-[10px] font-bold uppercase tracking-[0.1em]',
            kindClasses(memory.kind),
          )}
        >
          {KIND_LABELS[memory.kind] ?? memory.kind}
        </span>
        <StatusBadge status={memory.status} />
        <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground">
          r{memory.revision}
        </span>
      </div>
      <p
        className={cn(
          'mt-2 line-clamp-2 text-xs leading-5 text-foreground/90',
          memory.status === 'deleted' && 'line-through opacity-60',
        )}
      >
        {memoryPreview(memory.text)}
      </p>
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        <span className="border border-border/60 bg-background/50 px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
          {memory.scope}
        </span>
        {memory.audience && (
          <span className="flex items-center gap-0.5 border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">
            <BrainCircuit className="size-2.5" />
            {(
              memory.audience.roles ??
              memory.audience.taskTypes ??
              memory.audience.modes ??
              []
            ).slice(0, 1)[0] ?? 'scoped'}
          </span>
        )}
        {memory.tags.slice(0, 2).map((tagName) => (
          <span
            key={tagName}
            className="max-w-24 truncate border border-border/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
          >
            #{tagName}
          </span>
        ))}
        {memory.tags.length > 2 && (
          <span className="font-mono text-[9px] text-muted-foreground">
            +{memory.tags.length - 2}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
          {relativeDate(memory.updatedAt)}
        </span>
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-info" />
      </div>
    </button>
  );
}
