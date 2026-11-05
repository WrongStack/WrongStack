import { useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { Button } from '../ui/button';
import { fetchRankedSagePage, type RankedSageHit, type RankedSagePage } from './rankedSearch.js';
import type { SharedMemorySearch } from './sharedSearch.js';

interface RankedSearchResultsProps {
  search: SharedMemorySearch;
  tagFilter: string | null;
  audienceOnly: boolean;
  onOpen: (id: string) => void;
}

/** Ranked discovery is separate from the recency-ordered library list. */
export function RankedSearchResults({
  search,
  tagFilter,
  audienceOnly,
  onOpen,
}: RankedSearchResultsProps) {
  const { t } = useAppTranslation();
  const [page, setPage] = useState<RankedSagePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const query = search.query.trim();
  const supported =
    !tagFilter &&
    !audienceOnly &&
    (search.statusFilter === 'all' ||
      search.statusFilter === 'active' ||
      search.statusFilter === 'stale');

  useEffect(() => {
    const request = ++generation.current;
    controller.current?.abort();
    setPage(null);
    setError(null);
    setLoading(false);
    if (!query || !supported) return;
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    const timeout = setTimeout(() => {
      void fetchRankedSagePage(
        query,
        { status: search.statusFilter, kind: search.kindFilter },
        abort.signal,
      )
        .then((result) => {
          if (request === generation.current) setPage(result);
        })
        .catch((cause: unknown) => {
          if (!abort.signal.aborted && request === generation.current)
            setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (request === generation.current) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [query, search.statusFilter, search.kindFilter, supported, retry]);

  useEffect(
    () => () => {
      generation.current += 1;
      controller.current?.abort();
    },
    [],
  );

  const loadMore = async () => {
    if (!page?.nextCursor || loadingMore) return;
    const request = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await fetchRankedSagePage(
        query,
        {
          status: search.statusFilter,
          kind: search.kindFilter,
          cursor: page.nextCursor,
        },
        abort.signal,
      );
      if (request === generation.current) {
        const hits = [...page.hits, ...next.hits].slice(0, 200);
        setPage({ ...next, hits, nextCursor: hits.length >= 200 ? null : next.nextCursor });
      }
    } catch (cause) {
      if (!abort.signal.aborted && request === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === generation.current) setLoadingMore(false);
    }
  };

  if (!query) return null;
  return (
    <section
      aria-label={t('activity:rankedSearch.resultsLabel')}
      className="shrink-0 border-b border-border/60 bg-card/35"
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold">
        <span>{t('activity:rankedSearch.resultsLabel')}</span>
        {page && (
          <span className="text-muted-foreground">
            {t('activity:rankedSearch.shownCount', {
              shown: page.hits.length,
              total: page.totalCandidates,
            })}
          </span>
        )}
      </div>
      {!supported && (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {t('activity:rankedSearch.filterUnavailable')}
        </p>
      )}
      {loading && (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          {t('activity:rankedSearch.searching')}
        </p>
      )}
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error}{' '}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setPage(null);
              setError(null);
              setRetry((value) => value + 1);
            }}
          >
            {t('activity:rankedSearch.retryFromFirst')}
          </Button>
        </p>
      )}
      {page && page.hits.length === 0 && !error && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          {t('activity:rankedSearch.noResults')}
        </p>
      )}
      <ul className="max-h-52 overflow-y-auto divide-y divide-border/50">
        {page?.hits.map((hit: RankedSageHit) => (
          <li key={hit.id}>
            <button
              type="button"
              onClick={() => onOpen(hit.id)}
              className="w-full px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="block truncate text-xs">{hit.text}</span>
              <span className="text-[10px] text-muted-foreground">
                SAGE · {hit.status} · {hit.kind} · {hit.matchReason} ·{' '}
                {t('activity:sageText.rank', { score: hit.score.toFixed(3) })}
                {hit.bm25 != null
                  ? ` · ${t('activity:sageText.lexical', { score: hit.bm25.toFixed(3) })}`
                  : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {page?.nextCursor && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="m-2"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore
            ? t('activity:rankedSearch.loadingMore')
            : t('activity:rankedSearch.loadMoreRanked')}
        </Button>
      )}
    </section>
  );
}
