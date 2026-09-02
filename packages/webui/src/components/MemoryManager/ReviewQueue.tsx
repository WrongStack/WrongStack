/**
 * Dedicated review queue for hygiene/triage candidates.
 * Accept / reject / open target memory — including bulk actions.
 */
import { AlertTriangle, Check, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import type { MemoryCandidateEntry } from '@/types';
import { memoryPreview, relativeDate } from './shared';

interface ReviewQueueProps {
  listCandidates: (
    params?: { includeResolved?: boolean },
    options?: { echoToChat?: boolean },
  ) => void;
  resolveCandidate: (
    opts: { candidateId: string; action: 'accept' | 'reject'; reason?: string },
    options?: { echoToChat?: boolean },
  ) => void;
  onOpenMemory?: (id: string) => void;
  /**
   * Only the subscription surface is used. Picking `on` off the real client keeps
   * the per-message-type overloads, so handlers get narrowed payloads for free.
   */
  client: Pick<WrongStackWebSocketClient, 'on'>;
  /** When true, reload candidates (e.g. tab became active). */
  active: boolean;
}

export function ReviewQueue({
  listCandidates,
  resolveCandidate,
  onOpenMemory,
  client,
  active,
}: ReviewQueueProps) {
  const { t } = useAppTranslation();
  const [candidates, setCandidates] = useState<MemoryCandidateEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const generationRef = useRef(0);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    const off = client.on('memory.sage.listCandidates', (message) => {
      if (generation !== generationRef.current) return;
      off();
      if (message.payload.error) {
        setError(String(message.payload.error));
        setCandidates([]);
      } else {
        const list = Array.isArray(message.payload.candidates) ? message.payload.candidates : [];
        const pending = list.filter((c) => c.status === 'pending');
        setCandidates(pending);
        setSelected((prev) => {
          const next = new Set<string>();
          for (const id of prev) {
            if (pending.some((c) => c.id === id)) next.add(id);
          }
          return next;
        });
      }
      setLoading(false);
    });
    const timeout = setTimeout(() => {
      if (generation !== generationRef.current) return;
      off();
      setLoading(false);
      setError(t('activity:memoryManager.reviewLoadTimeout'));
    }, 15_000);
    listCandidates({ includeResolved: false }, { echoToChat: false });
    return () => {
      clearTimeout(timeout);
      off();
    };
  }, [client, listCandidates, t]);

  useEffect(() => {
    if (!active) return;
    return load();
  }, [active, load]);

  const resolveOne = useCallback(
    (candidateId: string, action: 'accept' | 'reject') =>
      new Promise<boolean>((resolve) => {
        const off = client.on('memory.sage.candidateResolve', (message) => {
          // Match loosely: any resolve response unblocks this wait; bulk is sequential.
          off();
          const err = message.payload.error;
          resolve(!err);
        });
        resolveCandidate(
          {
            candidateId,
            action,
            reason: action === 'reject' ? 'Rejected via Memory Review tab' : undefined,
          },
          { echoToChat: false },
        );
        setTimeout(() => {
          off();
          resolve(false);
        }, 15_000);
      }),
    [client, resolveCandidate],
  );

  const act = useCallback(
    async (candidateId: string, action: 'accept' | 'reject') => {
      setBusyId(candidateId);
      await resolveOne(candidateId, action);
      setBusyId(null);
      load();
    },
    [load, resolveOne],
  );

  const bulkAct = useCallback(
    async (action: 'accept' | 'reject') => {
      const ids = [...selected];
      if (ids.length === 0) return;
      setBulkBusy(true);
      for (const id of ids) {
        await resolveOne(id, action);
      }
      setBulkBusy(false);
      setSelected(new Set());
      load();
    },
    [load, resolveOne, selected],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(candidates.map((c) => c.id)));
  };

  const clearSelection = () => setSelected(new Set());

  if (loading && candidates.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('activity:memoryManager.reviewLoading')}
      </div>
    );
  }

  if (error && candidates.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangle className="size-5 text-warning" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={() => load()}>
          <RefreshCw className="size-3.5" /> {t('common:action.retry')}
        </Button>
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <Check className="size-6 text-success" />
        <p className="text-sm font-medium">{t('activity:memoryManager.reviewEmptyTitle')}</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {t('activity:memoryManager.reviewEmptyHint')}
        </p>
        <Button size="sm" variant="ghost" onClick={() => load()}>
          <RefreshCw className="size-3.5" /> {t('common:action.refresh')}
        </Button>
      </div>
    );
  }

  const selectedCount = selected.size;
  const allSelected = selectedCount === candidates.length && candidates.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('activity:memoryManager.reviewPendingCount', { count: candidates.length })}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            onClick={allSelected ? clearSelection : selectAll}
          >
            {allSelected
              ? t('activity:memoryManager.reviewClearSelection')
              : t('activity:memoryManager.reviewSelectAll')}
          </Button>
          <Button
            size="sm"
            className="h-7"
            disabled={selectedCount === 0 || bulkBusy}
            onClick={() => void bulkAct('accept')}
          >
            {bulkBusy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            {t('activity:memoryManager.reviewBulkAccept')}
            {selectedCount > 0 ? ` (${selectedCount})` : ''}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={selectedCount === 0 || bulkBusy}
            onClick={() => void bulkAct('reject')}
          >
            <X className="size-3" />
            {t('activity:memoryManager.reviewBulkKeep')}
            {selectedCount > 0 ? ` (${selectedCount})` : ''}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => load()}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {candidates.map((c) => {
          const target = c.targetMemoryId ?? c.memoryId;
          const reason = c.reviewReason ?? c.reason ?? '';
          const busy = busyId === c.id || bulkBusy;
          const isSelected = selected.has(c.id);
          return (
            <li
              key={c.id}
              className={cn(
                'rounded-md border bg-card/60 p-3 text-sm shadow-sm',
                isSelected ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border/70',
              )}
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-3.5 accent-primary"
                  checked={isSelected}
                  disabled={bulkBusy}
                  onChange={() => toggle(c.id)}
                  aria-label={t('activity:memoryManager.reviewSelectOne')}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span className="font-mono text-warning">{c.suggestedAction ?? 'review'}</span>
                    <span>·</span>
                    <span>{relativeDate(c.createdAt)}</span>
                    {c.tags?.includes('triage') && (
                      <>
                        <span>·</span>
                        <span className="text-info">triage</span>
                      </>
                    )}
                  </div>
                  <p className="mt-1.5 text-[13px] leading-snug text-foreground">
                    {memoryPreview(c.text, 220)}
                  </p>
                  {reason ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">{reason}</p>
                  ) : null}
                  {target ? (
                    <button
                      type="button"
                      className="mt-1 font-mono text-[10px] text-primary hover:underline"
                      onClick={() => onOpenMemory?.(target)}
                    >
                      {target.slice(0, 16)}…
                    </button>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      className="h-7"
                      disabled={busy}
                      onClick={() => void act(c.id, 'accept')}
                    >
                      {busyId === c.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Check className="size-3" />
                      )}
                      {t('activity:memoryManager.actionAcceptDeletion')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={busy}
                      onClick={() => void act(c.id, 'reject')}
                    >
                      <X className="size-3" />
                      {t('activity:memoryManager.actionKeep')}
                    </Button>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
