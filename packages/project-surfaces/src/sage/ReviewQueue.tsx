/**
 * Dedicated review queue for hygiene/triage candidates.
 * Accept / reject / open target memory — including bulk actions.
 */
import { AlertTriangle, Check, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SurfaceClient } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import type { MemoryCandidateEntry, SageEntry } from './model-types';
import { memoryPreview, relativeDate } from './shared';

interface ReviewQueueProps {
  listCandidates: (
    params?: { includeResolved?: boolean },
    options?: { echoToChat?: boolean },
  ) => void;
  resolveCandidate: (
    opts: {
      candidateId: string;
      action: 'accept' | 'reject';
      reason?: string | undefined;
      /** Echoed by the server so concurrent resolves settle the right wait. */
      requestId?: string | undefined;
    },
    options?: { echoToChat?: boolean },
  ) => void;
  onOpenMemory?: (id: string) => void;
  /**
   * Resolve a candidate's target memory so the row can show WHY the target is
   * under review. A candidate is a proposal ABOUT a memory; the decision hinges
   * on evidence that lives on that memory (is it stale because verification
   * failed, or because a person retired it? was it ever actually used?), and a
   * bare "review this" line makes an accept/reject choice uninformed.
   *
   * Optional: candidates whose target is not in the loaded page still render,
   * just without the evidence strip.
   */
  resolveMemory?: (id: string) => SageEntry | null;
  /**
   * Only the subscription surface is used. Picking `on` off the real client keeps
   * the per-message-type overloads, so handlers get narrowed payloads for free.
   */
  client: Pick<SurfaceClient, 'on'>;
  /** When true, reload candidates (e.g. tab became active). */
  active: boolean;
}

function canAccept(candidate: MemoryCandidateEntry): boolean {
  return (
    candidate.kind !== 'memory_review' ||
    candidate.suggestedAction === 'delete' ||
    candidate.suggestedAction === 'archive'
  );
}

/**
 * Evidence about the memory a candidate targets: why it is stale, and how
 * useful it has actually been.
 *
 * This is the context that makes Accept/Keep a real decision. A candidate
 * reading "archive" is a different ask depending on whether the target was
 * demoted by a failed anchor check (a passing re-check may restore it) or was
 * deliberately retired by a person. Likewise a memory injected 40 times and
 * never referenced is a much stronger retire case than one used twice.
 *
 * Renders nothing when the target is not resolvable (e.g. it is not on the
 * loaded page) or carries no signals at all.
 */
function CandidateEvidence({ memory }: { memory: SageEntry | null }) {
  const { t } = useAppTranslation();
  if (!memory) return null;
  const isStale = memory.status === 'stale';
  const injections = memory.injectionCount ?? 0;
  const uses = memory.useCount ?? 0;
  const hasUsefulness = memory.injectionCount !== undefined || memory.useCount !== undefined;
  if (!isStale && !hasUsefulness) return null;
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-border pl-2 text-[10px] text-muted-foreground"
      data-testid="candidate-evidence"
    >
      {isStale && (
        <span
          data-testid="candidate-stale-reason"
          data-stale-reason={memory.staleReason ?? 'unknown'}
        >
          {memory.staleReason === 'verification'
            ? t('activity:memoryManager.staleReasonVerification')
            : memory.staleReason === 'manual'
              ? t('activity:memoryManager.staleReasonManual')
              : t('activity:memoryManager.staleReasonUnknown')}
        </span>
      )}
      {hasUsefulness && (
        <span data-testid="candidate-usefulness" className="font-mono tabular-nums">
          {t('activity:memoryManager.usefulnessInjected')} {injections} ·{' '}
          {t('activity:memoryManager.usefulnessUsed')} {uses}
        </span>
      )}
    </div>
  );
}

export function ReviewQueue({
  listCandidates,
  resolveCandidate,
  onOpenMemory,
  resolveMemory,
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
  /**
   * Per-candidate failure from the last accept/keep attempt. A failed resolve
   * leaves the candidate pending, so the reloaded row must say why instead of
   * looking as if the click silently did nothing.
   */
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [bulkError, setBulkError] = useState<string | null>(null);
  /** Cancels for in-flight resolve waits, so unmount clears their timers. */
  const pendingResolvesRef = useRef(new Set<() => void>());
  /**
   * Releases for every in-flight list load, so unmount clears their
   * subscription AND their 15 s timer. Only the effect ever registered the
   * cleanup that `load()` returns, so a load started by `act()`, `bulkAct()`
   * or the refresh button outlived the component: its `memory.sage.listCandidates`
   * subscription kept writing state into an unmounted queue and its timer
   * kept the closure alive.
   */
  const loadReleasesRef = useRef(new Set<() => void>());
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const pending = pendingResolvesRef.current;
    const loads = loadReleasesRef.current;
    return () => {
      for (const cancel of [...pending]) cancel();
      for (const release of [...loads]) release();
    };
  }, []);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let off = () => {};
    let released = false;
    /** Releases this load's subscription and timer. */
    const release = () => {
      if (released) return;
      released = true;
      if (timeout !== null) clearTimeout(timeout);
      off();
      loadReleasesRef.current.delete(release);
    };
    off = client.on('memory.sage.listCandidates', (message) => {
      release();
      // A superseded load just detaches; the newer load owns the state.
      if (generation !== generationRef.current) return;
      if (message.payload.error) {
        setError(String(message.payload.error));
        setCandidates([]);
      } else {
        const list: MemoryCandidateEntry[] = Array.isArray(message.payload.candidates)
          ? message.payload.candidates
          : [];
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
    timeout = setTimeout(() => {
      release();
      if (generation !== generationRef.current) return;
      setLoading(false);
      setError(t('activity:memoryManager.reviewLoadTimeout'));
    }, 15_000);
    loadReleasesRef.current.add(release);
    listCandidates({ includeResolved: false }, { echoToChat: false });
    return release;
  }, [client, listCandidates, t]);

  useEffect(() => {
    if (!active) return;
    return load();
  }, [active, load]);

  /**
   * Resolve one candidate and settle on ITS response: the request carries a
   * `requestId` the server echoes, so a reply to another resolve (another
   * row, another surface, another tab) never settles this wait.
   *
   * The match is EXACT. A reply that carries no `requestId` belongs to a
   * request that could not carry one - the Memory Manager's file drawer
   * resolves candidates without a correlation id - and accepting it would
   * settle this wait with another action's outcome, marking the row failed
   * (or successful) for a resolve it never performed and then dropping the
   * row's own reply when it finally arrived.
   *
   * Resolves to the error message, or `null` on success.
   */
  const resolveOne = useCallback(
    (candidateId: string, action: 'accept' | 'reject') =>
      new Promise<string | null>((resolve) => {
        requestSeqRef.current += 1;
        const requestId = `review_${Date.now()}_${requestSeqRef.current}`;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let off = () => {};
        const settle = (error: string | null) => {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          off();
          pendingResolvesRef.current.delete(cancel);
          resolve(error);
        };
        const cancel = () => settle(t('activity:memoryManager.reviewActionTimeout'));
        off = client.on('memory.sage.candidateResolve', (message) => {
          const echoed = message.payload.requestId;
          if (echoed !== requestId) return;
          const err = message.payload.error;
          settle(err ? String(err) : null);
        });
        pendingResolvesRef.current.add(cancel);
        timer = setTimeout(cancel, 15_000);
        resolveCandidate(
          {
            candidateId,
            action,
            requestId,
            reason: action === 'reject' ? 'Rejected via Memory Review tab' : undefined,
          },
          { echoToChat: false },
        );
      }),
    [client, resolveCandidate, t],
  );

  const recordOutcome = useCallback((candidateId: string, error: string | null) => {
    setFailures((prev) => {
      if (error === null) {
        if (!(candidateId in prev)) return prev;
        const next = { ...prev };
        delete next[candidateId];
        return next;
      }
      return { ...prev, [candidateId]: error };
    });
  }, []);

  const act = useCallback(
    async (candidateId: string, action: 'accept' | 'reject') => {
      setBusyId(candidateId);
      setBulkError(null);
      const error = await resolveOne(candidateId, action);
      recordOutcome(candidateId, error);
      setBusyId(null);
      load();
    },
    [load, recordOutcome, resolveOne],
  );

  const bulkAct = useCallback(
    async (action: 'accept' | 'reject') => {
      const ids = [...selected].filter(
        (id) =>
          action !== 'accept' ||
          candidates.some((candidate) => candidate.id === id && canAccept(candidate)),
      );
      if (ids.length === 0) return;
      setBulkBusy(true);
      setBulkError(null);
      const failed: string[] = [];
      for (const id of ids) {
        const error = await resolveOne(id, action);
        recordOutcome(id, error);
        if (error !== null) failed.push(id);
      }
      setBulkBusy(false);
      // Keep failed rows selected so a retry targets exactly what did not apply.
      setSelected(new Set(failed));
      if (failed.length > 0) {
        setBulkError(
          t('activity:memoryManager.reviewBulkFailed', {
            failed: failed.length,
            total: ids.length,
          }),
        );
      }
      load();
    },
    [load, recordOutcome, resolveOne, selected, candidates, t],
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
  const acceptableSelectedCount = candidates.filter(
    (candidate) => selected.has(candidate.id) && canAccept(candidate),
  ).length;
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
            disabled={acceptableSelectedCount === 0 || bulkBusy}
            onClick={() => void bulkAct('accept')}
          >
            {bulkBusy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
            {t('activity:memoryManager.reviewBulkAccept')}
            {acceptableSelectedCount > 0 ? ` (${acceptableSelectedCount})` : ''}
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
      {bulkError ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] text-destructive"
        >
          <AlertTriangle className="size-3.5" /> {bulkError}
        </div>
      ) : null}
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {candidates.map((c) => {
          const target = c.targetMemoryId ?? c.memoryId;
          const reason = c.reviewReason ?? c.reason ?? '';
          const busy = busyId === c.id || bulkBusy;
          const isSelected = selected.has(c.id);
          const failure = failures[c.id];
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
                  {target && resolveMemory ? (
                    <CandidateEvidence memory={resolveMemory(target)} />
                  ) : null}
                  <p className="mt-1.5 text-[13px] leading-snug text-foreground">
                    {memoryPreview(c.text, 220)}
                  </p>
                  {reason ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">{reason}</p>
                  ) : null}
                  {target ? (
                    <button
                      type="button"
                      className="mt-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground hover:bg-primary/20 hover:underline"
                      onClick={() => onOpenMemory?.(target)}
                    >
                      {target.slice(0, 16)}…
                    </button>
                  ) : null}
                  {failure ? (
                    <p
                      role="alert"
                      data-testid="candidate-failure"
                      className="mt-1.5 flex items-center gap-1.5 text-[11px] text-destructive"
                    >
                      <AlertTriangle className="size-3" />
                      {t('activity:memoryManager.reviewActionFailed', { error: failure })}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {canAccept(c) ? (
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
                        {c.suggestedAction === 'delete'
                          ? t('activity:memoryManager.actionAcceptDeletion')
                          : t('common:action.apply')}
                      </Button>
                    ) : target && onOpenMemory ? (
                      <Button
                        size="sm"
                        className="h-7"
                        disabled={busy}
                        onClick={() => onOpenMemory(target)}
                      >
                        {t('common:action.open')}
                      </Button>
                    ) : null}
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
