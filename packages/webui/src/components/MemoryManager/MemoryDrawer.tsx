/**
 * MemoryDrawer — file-editor sidebar that surfaces every memory attached to,
 * anchored to, or merely mentioning the currently-open file.
 *
 * Design contract (PR #4):
 *   - Read-only: opening a file must never mutate the memory store.
 *   - Three buckets: `primaryMatches` (scope_file + file/dir anchors),
 *     `symbolMatches` (scope_symbol + symbol anchors, cursor-boosted),
 *     `relatedMatches` (text mentions).
 *   - Cursor-aware: when `lineStart`/`lineEnd` are supplied, symbol-anchored
 *     memories overlapping that range float to the top with a highlighted
 *     accent border.
 *   - Show Recoverable toggle: flips `showDeleted=true` to surface deleted
 *     memories for one-click `memory_recover` (PR #1 tool).
 *   - ReviewQueue: each pending-review candidate gets a triple action
 *     (Accept Deletion / Keep / Update) plus a "Mark as Permanent" shortcut
 *     that promotes persistence AND resolves the review in one step.
 *
 * All actions delegate upward via callback props — this component owns
 * only presentation; the parent (file editor / MemoryManager) wires the
 * real tool calls.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { usePagination } from '@/hooks/usePagination';
import { Pagination } from '@/components/ui/pagination';
import {
  AlertTriangle,
  Check,
  CircleX,
  Eye,
  EyeOff,
  FileText,
  GitMerge,
  Loader2,
  Pin,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useMemoryForFile } from '@/hooks/useMemoryForFile';
import { cn } from '@/lib/utils';
import type { MemoryForFileMatch, MemoryForFileResponse, MemoryMatchVia } from '@/types';

import { KIND_LABELS, kindClasses, memoryPreview, relativeDate, StatusBadge } from './shared';

export interface MemoryDrawerProps {
  /** Project-relative file path. When null the drawer renders an empty state. */
  filePath: string | null;
  /** Optional cursor line range — drives symbol-match boost. */
  lineStart?: number;
  lineEnd?: number;
  /** When false, the drawer hides itself (file closed). */
  open: boolean;
  /** Called when the user dismisses the drawer. */
  onClose: () => void;
  /** Called when the user clicks "Show full record" on a memory card. */
  onShowMemory?: (id: string) => void;
  /** Called when the user accepts a pending deletion (Accept Deletion). */
  onAcceptDeletion?: (candidateId: string, memoryId: string) => void | Promise<void>;
  /** Called when the user clicks Keep on a pending candidate. */
  onKeep?: (candidateId: string, memoryId: string) => void | Promise<void>;
  /** Called when the user clicks Update (navigates to memory editor). */
  onUpdate?: (memoryId: string) => void;
  /** Called when the user clicks "Mark as Permanent". */
  onMarkPermanent?: (memoryId: string) => void | Promise<void>;
  /** Called when the user clicks "Recover" on a deleted-memory card. */
  onRecover?: (memoryId: string) => void | Promise<void>;
}

interface SectionProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count: number;
  /** Cursor-boosted section — applied to every card via context. */
  cursorBoosted?: boolean;
  /** Matches for this section. */
  matches: MemoryForFileMatch[];
  onShowMemory?: MemoryDrawerProps['onShowMemory'];
  onAcceptDeletion?: MemoryDrawerProps['onAcceptDeletion'];
  onKeep?: MemoryDrawerProps['onKeep'];
  onUpdate?: MemoryDrawerProps['onUpdate'];
  onMarkPermanent?: MemoryDrawerProps['onMarkPermanent'];
  onRecover?: MemoryDrawerProps['onRecover'];
  /** Map of pending action in-flight per memoryId — disables buttons. */
  pendingActionById: Map<string, string>;
}

function matchStrengthClass(strength: number): string {
  // Use the kit's tokenised surfaces so we stay inside the design system.
  // The three tiers map to: strong (≥0.9), normal (≥0.7), weak (<0.7).
  if (strength >= 0.9) return 'bg-success/15 border-success/40';
  if (strength >= 0.7) return 'bg-info/15 border-info/40';
  if (strength >= 0.4) return 'bg-warning/10 border-warning/30';
  return 'bg-muted/30 border-border/40';
}

function matchedViaLabel(via: MemoryMatchVia): string {
  switch (via) {
    case 'scope_file':
      return 'scope: file';
    case 'scope_symbol':
      return 'scope: symbol';
    case 'anchor_file':
      return 'anchor: file';
    case 'anchor_symbol':
      return 'anchor: symbol';
    case 'anchor_directory':
      return 'anchor: directory';
    case 'mention':
      return 'text mention';
  }
}

function MemoryCard({
  match,
  cursorBoosted,
  onShowMemory,
  onAcceptDeletion,
  onKeep,
  onUpdate,
  onMarkPermanent,
  onRecover,
  pendingAction,
}: {
  match: MemoryForFileMatch;
  cursorBoosted?: boolean;
  onShowMemory?: MemoryDrawerProps['onShowMemory'];
  onAcceptDeletion?: MemoryDrawerProps['onAcceptDeletion'];
  onKeep?: MemoryDrawerProps['onKeep'];
  onUpdate?: MemoryDrawerProps['onUpdate'];
  onMarkPermanent?: MemoryDrawerProps['onMarkPermanent'];
  onRecover?: MemoryDrawerProps['onRecover'];
  pendingAction?: string;
}) {
  const { t } = useAppTranslation();
  const isDeleted = match.memory.status === 'deleted';
  const isSuperseded = match.memory.status === 'superseded';
  const review = match.pendingReview;

  const disabled = pendingAction !== undefined;
  const isCursorMatch = cursorBoosted === true;

  return (
    <article
      className={cn(
        'group relative rounded-md border px-3 py-2 text-sm transition-colors',
        matchStrengthClass(match.matchStrength),
        isCursorMatch && 'ring-1 ring-primary/40 ring-offset-0',
        isDeleted && 'opacity-70',
      )}
      data-match-via={match.matchedVia}
      data-memory-id={match.memory.id}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide">
            <span className={cn('font-mono', kindClasses(match.memory.kind))}>
              {KIND_LABELS[match.memory.kind] ?? match.memory.kind}
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-muted-foreground">
              {matchedViaLabel(match.matchedVia)}
            </span>
            {isCursorMatch && (
              <span
                className="flex items-center gap-0.5 rounded-sm bg-primary/15 px-1 py-0.5 font-mono text-primary"
                title={t('activity:memoryManager.anchorCursorHint')}
              >
                <Pin className="size-2.5" /> {t('activity:memoryManager.cursorLabel')}
              </span>
            )}
            {review && (
              <span
                className="flex items-center gap-0.5 rounded-sm bg-warning/15 px-1 py-0.5 font-mono text-warning"
                title={t('activity:memoryManager.hygieneReviewTitle', {
                  reason: review.reason,
                  days: review.ageDays,
                })}
              >
                <AlertTriangle className="size-2.5" /> {t('activity:memoryManager.reviewLabel')}
              </span>
            )}
            {isDeleted && (
              <span className="font-mono text-destructive">
                {t('activity:memoryManager.statusDeleted')}
              </span>
            )}
            {isSuperseded && !isDeleted && (
              <span className="font-mono text-muted-foreground">
                {t('activity:memoryManager.statusSuperseded')}
              </span>
            )}
          </div>
          <p className="mt-1 text-foreground/90">{memoryPreview(match.memory.text, 200)}</p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <StatusBadge status={match.memory.status} />
            <span>
              {t('activity:memoryManager.updatedSuffix', {
                date: relativeDate(match.memory.updatedAt),
              })}
            </span>
          </div>
        </div>
      </header>

      <footer className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* Recovery — only for deleted memories. */}
        {isDeleted && onRecover && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onRecover(match.memory.id)}
            className="h-7 gap-1 border-primary/40 px-2 text-[11px] text-primary hover:bg-primary/10"
            title={t('activity:memoryManager.restoreTitle')}
          >
            <RefreshCw className="size-3" /> {t('activity:memoryManager.actionRecover')}
          </Button>
        )}

        {/* Superseded → Go to active version. */}
        {isSuperseded && match.supersededByActiveId && onShowMemory && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onShowMemory(match.supersededByActiveId!)}
            className="h-7 gap-1 px-2 text-[11px]"
            title={t('activity:memoryManager.supersededJumpTitle')}
          >
            <GitMerge className="size-3" /> {t('activity:memoryManager.actionGoToActive')}
          </Button>
        )}

        {/* Pending-review triple action — destructive action gated on suggestedAction.
            When the parent integration is read-only (e.g. FileActivityDrawer's
            'memory' tab), none of the action handlers are wired, so we hide
            the whole block instead of rendering buttons that would be no-ops. */}
        {review && (onAcceptDeletion || onKeep || onUpdate || onMarkPermanent) && (
          <>
            {review.suggestedAction === 'delete' && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={disabled}
                onClick={() => onAcceptDeletion?.(review.candidateId, match.memory.id)}
                className="h-7 gap-1 px-2 text-[11px]"
                title={t('activity:memoryManager.acceptSuggestionTitle')}
              >
                <Check className="size-3" /> {t('activity:memoryManager.actionAcceptDeletion')}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onKeep?.(review.candidateId, match.memory.id)}
              className="h-7 gap-1 px-2 text-[11px]"
              title={t('activity:memoryManager.rejectSuggestionTitle')}
            >
              <X className="size-3" /> {t('activity:memoryManager.actionKeep')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onUpdate?.(match.memory.id)}
              className="h-7 gap-1 px-2 text-[11px]"
              title={t('activity:memoryManager.updateTitle')}
            >
              <Sparkles className="size-3" /> {t('activity:memoryManager.actionUpdate')}
            </Button>
            {onMarkPermanent && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => onMarkPermanent(match.memory.id)}
                className="h-7 gap-1 border-warning/40 px-2 text-[11px] text-warning hover:bg-warning/10"
                title={t('activity:memoryManager.promoteTitle')}
              >
                <Pin className="size-3" /> {t('activity:memoryManager.actionMarkPermanent')}
              </Button>
            )}
          </>
        )}

        {/* Always-available: view full record. */}
        {onShowMemory && !isDeleted && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onShowMemory(match.memory.id)}
            className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            title={t('activity:memoryManager.openRecordTitle')}
          >
            <Eye className="size-3" /> {t('activity:memoryManager.actionShowFull')}
          </Button>
        )}

        {pendingAction && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> {pendingAction}
          </span>
        )}
      </footer>
    </article>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  matches,
  cursorBoosted = false,
  ...handlers
}: SectionProps) {
  const { t } = useAppTranslation();
  const memoryPage = usePagination(matches, 10);
  if (matches.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3" />
        <span>{title}</span>
        <span className="font-mono">({count})</span>
        {cursorBoosted && (
          <span className="ml-auto flex items-center gap-0.5 font-mono text-[9px] text-primary">
            <Pin className="size-2.5" /> {t('activity:memoryManager.cursorBoostTitle')}
          </span>
        )}
      </h3>
      <div className="flex flex-col gap-1.5">
        {memoryPage.pageItems.map((match) => (
          <MemoryCard
            key={match.memory.id}
            match={match}
            cursorBoosted={
              cursorBoosted &&
              (match.matchedVia === 'anchor_symbol' || match.matchedVia === 'scope_symbol')
            }
            pendingAction={handlers.pendingActionById.get(match.memory.id)}
            {...handlers}
          />
        ))}
      </div>
      <Pagination
        page={memoryPage.page}
        pageSize={memoryPage.pageSize}
        totalItems={memoryPage.totalItems}
        onPageChange={memoryPage.setPage}
        compact
        itemLabel={t('activity:memoryManager.itemLabel')}
      />
    </section>
  );
}

export function MemoryDrawer({
  filePath,
  lineStart,
  lineEnd,
  open,
  onClose,
  onShowMemory,
  onAcceptDeletion,
  onKeep,
  onUpdate,
  onMarkPermanent,
  onRecover,
}: MemoryDrawerProps) {
  const { t } = useAppTranslation();
  const [showDeleted, setShowDeleted] = useState(false);
  const [pendingActionById, setPendingAction] = useState<Map<string, string>>(new Map());
  const pendingLabels = {
    accepting: t('activity:memoryManager.pendingAccepting'),
    keeping: t('activity:memoryManager.pendingKeeping'),
    updating: t('activity:memoryManager.pendingUpdating'),
    marking: t('activity:memoryManager.pendingMarking'),
    recovering: t('activity:memoryManager.pendingRecovering'),
  };

  const { data, loading, error, refetch } = useMemoryForFile({
    filePath,
    lineStart,
    lineEnd,
    showDeleted,
    autoFetch: open,
  });

  // The cursor-boosted bucket is whichever contains symbol-anchored memories
  // overlapping the cursor line range. We tag the symbolMatches bucket as
  // boosted (the renderer uses this to add the cursor pin to each card).
  const cursorBoostedBucket = lineStart !== undefined && lineEnd !== undefined;

  // Wire action wrappers — track in-flight state per memory so the
  // buttons show a spinner and stay disabled while the parent tool runs.
  const runAction = useCallback(
    async (
      memoryId: string,
      label: string,
      handler: (memoryId: string) => void | Promise<void> | undefined,
    ) => {
      if (!handler) return;
      setPendingAction((prev) => new Map(prev).set(memoryId, label));
      try {
        await handler(memoryId);
      } finally {
        setPendingAction((prev) => {
          const next = new Map(prev);
          next.delete(memoryId);
          return next;
        });
      }
    },
    [],
  );

  // Reset the toggle when the file changes so users start in the safe
  // default (no deleted) every time they open a new file.
  useEffect(() => {
    setShowDeleted(false);
  }, [filePath]);

  if (!open) return null;

  const response: MemoryForFileResponse | null = data;
  const totalCount = response?.totalCount ?? 0;

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border-l border-border/70 bg-card/15"
      aria-label={t('activity:memoryManager.fileDrawerAria')}
      data-file-path={filePath ?? ''}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <FileText className="size-3" />
            <span className="truncate font-mono" title={filePath ?? ''}>
              {filePath ?? t('activity:memoryManager.noFile')}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="font-mono">
              {t('activity:memoryManager.memoriesCount', { count: totalCount })}
            </span>
            {response && response.reviewPendingCount > 0 && (
              <span className="flex items-center gap-0.5 font-mono text-warning">
                <AlertTriangle className="size-3" />
                {t('activity:memoryManager.pendingReviewCount', {
                  count: response.reviewPendingCount,
                })}
              </span>
            )}
            {response && response.supersededCount > 0 && (
              <span className="font-mono">
                {t('activity:memoryManager.supersededCount', { count: response.supersededCount })}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            disabled={loading || !filePath}
            className="h-7 w-7 p-0"
            aria-label={t('common:action.refresh')}
            title={t('activity:memoryManager.requeryTitle')}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onClose}
            className="h-7 w-7 p-0"
            aria-label={t('activity:memoryManager.closeDrawerAria')}
            title={t('activity:memoryManager.closeDrawerTitle')}
          >
            <CircleX className="size-3.5" />
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-background/40 px-3 py-1.5 text-[10px] text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.target.checked)}
            className="size-3 accent-primary"
            disabled={!filePath}
            data-testid="memory-drawer-show-deleted"
          />
          {showDeleted ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
          <span>{t('activity:memoryManager.showRecoverable')}</span>
        </label>
        {cursorBoostedBucket && (
          <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-primary">
            <Pin className="size-3" />{' '}
            {t('activity:memoryManager.linesRange', { start: lineStart, end: lineEnd })}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {!filePath ? (
          <EmptyState message={t('activity:memoryManager.emptyOpenFile')} />
        ) : loading && !response ? (
          <EmptyState loading message={t('activity:memoryManager.loadingMemories')} />
        ) : error ? (
          <EmptyState
            tone="error"
            message={t('activity:memoryManager.errorPrefix', { message: error })}
          />
        ) : !response || totalCount === 0 ? (
          <EmptyState message={t('activity:memoryManager.emptyNoMemories', { file: filePath })} />
        ) : (
          <div className="flex flex-col gap-3">
            <Section
              icon={Pin}
              title={t('activity:memoryManager.cursorBoostTitle')}
              count={response.symbolMatches.length}
              cursorBoosted={cursorBoostedBucket}
              matches={response.symbolMatches}
              pendingActionById={pendingActionById}
              onShowMemory={onShowMemory}
              onAcceptDeletion={(cId, mId) =>
                runAction(mId, pendingLabels.accepting, () => onAcceptDeletion?.(cId, mId))
              }
              onKeep={(cId, mId) => runAction(mId, pendingLabels.keeping, () => onKeep?.(cId, mId))}
              onUpdate={(mId) => runAction(mId, pendingLabels.updating, () => onUpdate?.(mId))}
              onMarkPermanent={(mId) =>
                runAction(mId, pendingLabels.marking, () => onMarkPermanent?.(mId))
              }
              onRecover={(mId) => runAction(mId, pendingLabels.recovering, () => onRecover?.(mId))}
            />
            <Section
              icon={FileText}
              title={t('activity:memoryManager.fileScopedTitle')}
              count={response.primaryMatches.length}
              matches={response.primaryMatches}
              pendingActionById={pendingActionById}
              onShowMemory={onShowMemory}
              onAcceptDeletion={(cId, mId) =>
                runAction(mId, pendingLabels.accepting, () => onAcceptDeletion?.(cId, mId))
              }
              onKeep={(cId, mId) => runAction(mId, pendingLabels.keeping, () => onKeep?.(cId, mId))}
              onUpdate={(mId) => runAction(mId, pendingLabels.updating, () => onUpdate?.(mId))}
              onMarkPermanent={(mId) =>
                runAction(mId, pendingLabels.marking, () => onMarkPermanent?.(mId))
              }
              onRecover={(mId) => runAction(mId, pendingLabels.recovering, () => onRecover?.(mId))}
            />
            <Section
              icon={Eye}
              title={t('activity:memoryManager.mentionedInTitle')}
              count={response.relatedMatches.length}
              matches={response.relatedMatches}
              pendingActionById={pendingActionById}
              onShowMemory={onShowMemory}
              onAcceptDeletion={(cId, mId) =>
                runAction(mId, pendingLabels.accepting, () => onAcceptDeletion?.(cId, mId))
              }
              onKeep={(cId, mId) => runAction(mId, pendingLabels.keeping, () => onKeep?.(cId, mId))}
              onUpdate={(mId) => runAction(mId, pendingLabels.updating, () => onUpdate?.(mId))}
              onMarkPermanent={(mId) =>
                runAction(mId, pendingLabels.marking, () => onMarkPermanent?.(mId))
              }
              onRecover={(mId) => runAction(mId, pendingLabels.recovering, () => onRecover?.(mId))}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

function EmptyState({
  message,
  loading = false,
  tone = 'default',
}: {
  message: string;
  loading?: boolean;
  tone?: 'default' | 'error';
}) {
  return (
    <div
      className={cn(
        'flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 px-4 py-6 text-center text-[11px]',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      <p>{message}</p>
    </div>
  );
}
