import { AlertTriangle, ArrowLeft, Check, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSurfaceHost } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { DeleteMemoryDialog } from './DeleteMemoryDialog';
import { MemoryDetail } from './MemoryDetail';
import { MemoryDrawer } from './MemoryDrawer';
import { MemoryDrawerToolbar } from './MemoryDrawerToolbar';
import { MemoryEditor } from './MemoryEditor';
import { MemoryFilters } from './MemoryFilters';
import { MemoryList } from './MemoryList';
import { MemoryManagerEmpty } from './MemoryManagerEmpty';
import { MemoryManagerHeader } from './MemoryManagerHeader';
import { MemoryManagerStatsBar } from './MemoryManagerStatsBar';
import { MemorySearchBreakdown } from './MemorySearchBreakdown';
import { RankedSearchResults } from './RankedSearchResults';
import { ReviewQueue } from './ReviewQueue';
import { SageHealthPanel } from './SageHealthPanel';
import type { SharedMemorySearch } from './sharedSearch.js';
import { useMemoryManagerState } from './useMemoryManagerState';

export function MemoryManager({
  sharedSearch,
  linkedId,
  onLinkedIdHandled,
  onReturnToVector,
}: {
  sharedSearch?: SharedMemorySearch | undefined;
  linkedId?: string | null | undefined;
  onLinkedIdHandled?: (() => void) | undefined;
  onReturnToVector?: (() => void) | undefined;
} = {}) {
  const { t } = useAppTranslation();
  const host = useSurfaceHost();
  const navigateBack = host.useNavigateBack();
  const memoryListRef = host.useScrollRestore<HTMLDivElement>('memory');
  const state = useMemoryManagerState(sharedSearch);
  /** Injection precision from the last doctor report, for the stats bar. */
  const [precision, setPrecision] = useState<number | null>(null);
  const showHealth = state.libraryView === 'health';
  useEffect(() => {
    if (!linkedId) return;
    void state.openSearchMemory(linkedId).finally(() => onLinkedIdHandled?.());
  }, [linkedId, state.openSearchMemory, onLinkedIdHandled]);

  /** Restore a soft-deleted memory through the `memory.sage.recover` op. */
  const recoverMemory = (memoryId: string, reason: string) => {
    return state.sendWithAck(
      'memory.sage.recover',
      // The ack matches its reply by this id; a host that tags every request would otherwise
      // answer under an id the ack does not know.
      (requestId) => state.recoverSage({ id: memoryId, reason, requestId }),
      (payload) => {
        if (payload.error) {
          state.setMutationError(payload.error);
          return;
        }
        state.setNotice(`Recovered ${memoryId.slice(0, 12)}…`);
        state.loadMemories();
      },
    );
  };

  if (state.initialLoading && state.memories.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background" aria-busy="true">
        <div className="border-b border-border/70 bg-card/70 px-5 py-4">
          <div className="h-3 w-28 animate-pulse bg-muted" />
          <div className="mt-3 h-7 w-56 animate-pulse bg-muted" />
        </div>
        <div className="grid flex-1 gap-px bg-border/60 md:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.35fr)]">
          <div className="space-y-px bg-background p-4">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} className="h-24 animate-pulse border border-border/60 bg-card/45" />
            ))}
          </div>
          <div className="hidden bg-background p-6 md:block">
            <div className="h-full animate-pulse border border-border/60 bg-card/35" />
          </div>
        </div>
        <span className="sr-only" role="status">
          {t('activity:memoryManager.loadingSageContent')}
        </span>
      </div>
    );
  }

  if (state.loadError && state.memories.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background p-6">
        <div className="max-w-md border border-destructive/35 bg-card p-6 ws-dialog">
          <span className="flex size-11 items-center justify-center border border-destructive/35 bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </span>
          <h2 className="mt-4 text-lg font-bold">{t('activity:memoryManager.storeUnavailable')}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{state.loadError}</p>
          <div className="mt-5 flex gap-2">
            <Button onClick={state.loadMemories}>
              <RefreshCw className="size-4" /> {t('common:action.retry')}
            </Button>
            {navigateBack && (
              <Button variant="outline" onClick={navigateBack}>
                <ArrowLeft className="size-4" /> {t('activity:memoryManager.backToChat')}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <MemoryManagerHeader
        wsConnected={state.wsConnected}
        refreshing={state.refreshing}
        onRefresh={state.loadMemories}
        onCreate={state.openCreate}
      />

      <MemoryManagerStatsBar
        stats={state.stats}
        memories={state.memories}
        filteredCount={state.filteredMemories.length}
        allTagsCount={state.allTags.length}
        precision={precision}
      />

      {(state.notice || state.loadError || state.mutationError || state.resolveError) && (
        <div className="shrink-0 border-b border-border/70 px-4 py-2" aria-live="polite">
          {state.notice && (
            <div role="status" className="flex items-center gap-2 text-xs text-success">
              <Check className="size-3.5" /> {state.notice}
            </div>
          )}
          {state.loadError && (
            <div role="alert" className="flex items-center gap-2 text-xs text-warning">
              <AlertTriangle className="size-3.5" /> {state.loadError} Existing content remains
              available.
            </div>
          )}
          {state.mutationError && !state.editing && !state.creating && (
            <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="size-3.5" /> {state.mutationError}
            </div>
          )}
          {state.resolveError && (
            <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
              <AlertTriangle className="size-3.5" /> {state.resolveError}
            </div>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(320px,0.82fr)_minmax(0,1.35fr)]">
        <section
          className={cn(
            'min-h-0 border-r border-border/70 bg-card/25',
            state.detailOpen ? 'hidden md:flex md:flex-col' : 'flex flex-col',
          )}
          aria-label={t('activity:memoryManager.libraryAria')}
        >
          <div
            className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 pt-1"
            role="tablist"
            aria-label={t('activity:memoryManager.viewAria')}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={state.libraryView === 'active'}
              onClick={() => state.setLibraryView('active')}
              className={cn(
                'h-7 rounded-b-none border-b-2 px-3 text-[11px]',
                state.libraryView === 'active'
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              {t('activity:memoryManager.tabActive')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={state.showReview}
              onClick={() => state.setLibraryView('review')}
              className={cn(
                'h-7 rounded-b-none border-b-2 px-3 text-[11px]',
                state.showReview
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              {t('activity:memoryManager.tabReview')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={state.showDeleted}
              onClick={() => state.setLibraryView('deleted')}
              className={cn(
                'h-7 rounded-b-none border-b-2 px-3 text-[11px]',
                state.showDeleted
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              {t('activity:memoryManager.tabDeleted')}
              {typeof state.statusCounts['deleted'] === 'number'
                ? ` (${state.statusCounts['deleted']})`
                : ''}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={showHealth}
              onClick={() => state.setLibraryView('health')}
              className={cn(
                'h-7 rounded-b-none border-b-2 px-3 text-[11px]',
                showHealth
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              {t('activity:memoryManager.tabHealth')}
            </Button>
          </div>

          {showHealth ? (
            <SageHealthPanel
              active={showHealth}
              client={state.client}
              sageDoctor={state.sageDoctor}
              onOpenMemory={(id) => void state.openSearchMemory(id)}
              onReport={(report) =>
                setPrecision(report.metrics.injections > 0 ? report.metrics.precision : null)
              }
            />
          ) : state.showReview ? (
            <ReviewQueue
              active={state.showReview}
              client={state.client}
              listCandidates={state.listMemoryCandidates}
              resolveCandidate={state.resolveMemoryCandidate}
              // A candidate's target is usually not on the loaded library page,
              // so resolve it by id instead of looking it up in that page.
              onOpenMemory={(id) => void state.openSearchMemory(id)}
              resolveMemory={state.resolveMemory}
            />
          ) : (
            <>
              <MemoryFilters
                searchQuery={state.searchQuery}
                statusFilter={state.statusFilter}
                kindFilter={state.kindFilter}
                audienceOnly={state.audienceOnly}
                tagFilter={state.tagFilter}
                hasFilters={state.hasFilters}
                allTags={state.allTags}
                stats={state.stats}
                onSearchChange={state.setSearchQuery}
                onStatusFilterChange={state.setStatusFilter}
                onKindFilterChange={state.setKindFilter}
                onToggleAudienceOnly={() => state.setAudienceOnly((v) => !v)}
                onTagFilterChange={state.setTagFilter}
                onClearFilters={state.clearFilters}
              />
              <MemoryList
                memoryListRef={memoryListRef}
                memories={state.memories}
                filteredMemories={state.filteredMemories}
                selectedId={state.selectedId}
                onSelectMemory={state.openMemory}
                onOpenCreate={state.openCreate}
                onClearFilters={state.clearFilters}
              />
              {sharedSearch ? (
                <RankedSearchResults
                  search={sharedSearch}
                  tagFilter={state.tagFilter}
                  audienceOnly={state.audienceOnly}
                  onOpen={(id) => void state.openSearchMemory(id)}
                />
              ) : state.searchQuery.trim().length > 0 ? (
                <MemorySearchBreakdown
                  query={state.searchQuery.trim()}
                  channel={state.searchBreakdown.channel}
                  hits={state.searchBreakdown.hits}
                  loading={state.searchBreakdown.loading}
                  error={state.searchBreakdown.error}
                  onOpenMemory={state.openMemory}
                  onClear={state.clearSearchBreakdown}
                />
              ) : null}
              {state.hasMore ? (
                <div className="shrink-0 border-t border-border/60 p-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={state.loadMore}
                    disabled={state.loadingMore}
                    className="h-7 w-full text-[11px]"
                  >
                    {state.loadingMore
                      ? t('common:action.loading')
                      : `Load more (${state.memories.length} loaded)`}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <section
          className={cn(
            'min-h-0 bg-background',
            state.detailOpen ? 'flex flex-col' : 'hidden md:flex md:flex-col',
          )}
          aria-label={t('activity:memoryManager.detailAria')}
        >
          {state.memories.some((memory) =>
            (memory.anchors ?? []).some((anchor) => anchor.type === 'file' && anchor.path),
          ) && (
            <MemoryDrawerToolbar
              currentFilePath={state.currentFilePath}
              knownFilePaths={state.knownFilePaths}
              drawerActive={state.drawerActive}
              onFilePathChange={(next) => {
                if (next && state.knownFilePaths.has(next)) {
                  state.setCurrentFilePath(next);
                  state.setDrawerOpen(true);
                } else if (!next) {
                  state.setCurrentFilePath(null);
                } else {
                  state.setCurrentFilePath(next);
                }
              }}
              onToggleDrawer={() => {
                if (!state.currentFilePath) return;
                state.setDrawerOpen((prev) => !prev);
              }}
            />
          )}
          {state.creating ? (
            <MemoryEditor
              mode="create"
              draft={state.draft}
              busy={state.busyAction === 'create'}
              error={state.mutationError}
              onChange={state.setDraft}
              onCancel={state.cancelEditor}
              onSubmit={state.submitCreate}
            />
          ) : state.selectedMemory ? (
            state.editing ? (
              <MemoryEditor
                mode="edit"
                draft={state.draft}
                busy={state.busyAction === 'update'}
                error={state.mutationError}
                onChange={state.setDraft}
                onCancel={state.cancelEditor}
                onSubmit={state.submitUpdate}
              />
            ) : state.drawerActive ? (
              <MemoryDrawer
                filePath={state.currentFilePath}
                open={state.drawerActive}
                onClose={() => state.setDrawerOpen(false)}
                onShowMemory={(id) => state.setSelectedId(id)}
                onAcceptDeletion={(candidateId, memoryId) =>
                  // The promise is returned so the drawer can keep the
                  // action pending until the store acknowledged it.
                  state.sendWithAck(
                    'memory.sage.candidateResolve',
                    // The correlation id lets the server tag the reply, so a
                    // resolve running elsewhere in this tab (the Review tab)
                    // cannot settle this wait with its own outcome.
                    (requestId) =>
                      state.resolveMemoryCandidate({ candidateId, action: 'accept', requestId }),
                    (payload) => {
                      if (payload.error) {
                        state.setMutationError(payload.error);
                        return;
                      }
                      state.setNotice(
                        `Accepted hygiene review for ${memoryId.slice(0, 12)}… ` +
                          `(candidate ${candidateId.slice(0, 12)}…).`,
                      );
                      state.loadMemories();
                    },
                  )
                }
                onKeep={(candidateId, memoryId) =>
                  state.sendWithAck(
                    'memory.sage.candidateResolve',
                    (requestId) =>
                      state.resolveMemoryCandidate({ candidateId, action: 'reject', requestId }),
                    (payload) => {
                      if (payload.error) {
                        state.setMutationError(payload.error);
                        return;
                      }
                      state.setNotice(
                        `Kept ${memoryId.slice(0, 12)}… ` +
                          `(candidate ${candidateId.slice(0, 12)}… rejected).`,
                      );
                      state.loadMemories();
                    },
                  )
                }
                onUpdate={(memoryId) => {
                  state.openEdit(memoryId);
                }}
                onMarkPermanent={(memoryId) => {
                  state.sendWithAck(
                    'memory.sage.update',
                    (requestId) =>
                      state.updateSage(memoryId, { persistence: 'permanent', requestId }),
                    (payload) => {
                      if (payload.error || !payload.memory) {
                        state.setMutationError(
                          payload.error ?? 'The server returned no memory record.',
                        );
                        return;
                      }
                      state.setNotice(`Memory ${memoryId.slice(0, 12)}… promoted to permanent.`);
                      state.loadMemories();
                    },
                  );
                }}
                onRecover={(memoryId) => recoverMemory(memoryId, 'recovered via file drawer')}
              />
            ) : (
              <>
                {onReturnToVector && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={onReturnToVector}
                  >
                    <ArrowLeft className="size-4" /> Back to vector results
                  </Button>
                )}
                <MemoryDetail
                  memory={state.selectedMemory}
                  allMemories={[...state.memories, ...state.graphMemories]}
                  relatedMemories={state.relatedMemories}
                  graphEdges={state.graphEdges}
                  graphLoading={state.graphLoading}
                  graphError={state.graphError}
                  onClose={() => state.setSelectedId(null)}
                  onOpenMemory={state.openMemory}
                  onEdit={state.openEdit}
                  onDelete={() => state.openDeleteDialog(state.selectedMemory!.id)}
                  onRecover={(memoryId) =>
                    recoverMemory(memoryId, 'recovered via Memory Manager detail')
                  }
                  onTagSelect={(tag) => {
                    state.setTagFilter(tag);
                    state.setSelectedId(null);
                  }}
                  onNotice={state.setNotice}
                />
              </>
            )
          ) : (
            <MemoryManagerEmpty onCapture={state.openCreate} />
          )}
        </section>
      </div>

      <DeleteMemoryDialog
        busyAction={state.busyAction}
        deletingId={state.deletingId}
        memory={state.selectedMemory}
        neverInject={state.neverInject}
        onNeverInjectChange={state.setNeverInject}
        onCancel={state.cancelDelete}
        onConfirm={state.confirmDelete}
        onOpenChange={(open) => {
          if (!open) state.cancelDelete();
        }}
      />
    </div>
  );
}
