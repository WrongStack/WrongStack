/**
 * Vector Memory Panel — minimal WebUI surface showing the active store,
 * model cache location, entry counts, and a semantic-search UI with
 * ranked results. Disabled (renders a placeholder) when the webui-server
 * host doesn't wire a vector store — see `fetchVectorMemoryStatus()` which
 * returns `{ enabled: false }` in that case.
 */

import { ChevronRight } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '../../lib/i18n';
import type { SharedMemorySearch } from '../sharedSearch.js';
import { ForgetVectorMemoryDialog } from './ForgetVectorMemoryDialog.js';
import {
  fetchVectorMemoryStatus,
  forgetVectorMemory,
  previewText,
  searchVectorMemory,
  type VectorMemoryHit,
  type VectorMemoryStatus,
} from './model.js';
import './vector-memory-panel.css';

export interface VectorMemoryPanelProps {
  /** Base URL prefix for the webui-server. Default: same-origin. */
  baseUrl?: string;
  /**
   * Search state shared with the MemoryManager's SAGE list (query,
   * status/kind filters, sage navigation). Type-only coupling: the parent
   * owns the state; this panel reads the query, delegates edits through
   * `setQuery`, and navigates verified mirrors via `navigateToSage`.
   * While a SAGE status/kind filter is active the vector search is
   * disabled with an explicit notice — the raw vector route cannot apply
   * those filters, and silently ignoring them would look like an empty
   * corpus. When omitted the panel is fully standalone.
   */
  sharedSearch?: SharedMemorySearch | undefined;
}

export function VectorMemoryPanel({
  baseUrl = '',
  sharedSearch,
}: VectorMemoryPanelProps = {}): ReactElement {
  const { t } = useAppTranslation();
  const [status, setStatus] = useState<VectorMemoryStatus | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const snapshot =
    sharedSearch && sharedSearch.vectorSnapshot?.query === sharedSearch.query
      ? sharedSearch.vectorSnapshot
      : null;
  const [limit, setLimit] = useState(snapshot?.limit ?? 10);
  const [threshold, setThreshold] = useState<number | undefined>(snapshot?.threshold);
  const [hits, setHits] = useState<readonly VectorMemoryHit[]>(snapshot?.hits ?? []);
  const [similarity, setSimilarity] = useState<readonly (readonly number[])[] | undefined>(
    snapshot?.similarity,
  );
  const [searchError, setSearchError] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  // Cursor pagination: `nextCursor` from the last committed page; non-null
  // means the ranked result set may have more pages (Load more appends).
  const [nextCursor, setNextCursor] = useState<string | null>(snapshot?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  // True once a search response committed — gates the "No results." row so
  // it only appears for an actually-executed (possibly empty) search, not
  // for a cleared list while the user is editing inputs.
  const [searchRan, setSearchRan] = useState(snapshot?.searchRan ?? false);
  // Inline-expand (master-detail) + Forget state for the hit list.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [forgetTarget, setForgetTarget] = useState<VectorMemoryHit | null>(null);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetError, setForgetError] = useState<string | undefined>();
  // Bumped after a successful forget so the status strip (entry/vector
  // counts) refetches without remounting the panel.
  const [statusNonce, setStatusNonce] = useState(0);
  // Bumped on every successful search. A forget completion compares the
  // version it started against so it never patches a similarity matrix that
  // belongs to a newer result set (index-aligned data + stale closure race).
  const resultVersionRef = useRef(0);
  // Monotonic id of the latest issued search request. Only the latest
  // request may commit its response — an older response resolving late
  // (or after an input change reset) is dropped instead of clobbering
  // newer state. Same counter guards both fresh searches and Load more.
  const searchSeqRef = useRef(0);
  // Ranking inputs the currently displayed results belong to. Any change
  // (typed locally or swapped in by a shared-search parent) invalidates
  // the page: the backend cursor is fingerprinted to the query, and stale
  // hits would misrepresent what the box now asks for.
  const paramsRef = useRef({ query: sharedSearch?.query ?? '', threshold, limit });
  // True once any status fetch has succeeded. A later failed refetch (e.g.
  // after a forget bumped statusNonce) keeps the last good status instead of
  // unmounting an enabled panel — counts just stay stale until next poll.
  const statusLoadedRef = useRef(false);
  // The host the current `status` belongs to. A baseUrl change must start
  // from a clean slate: keeping the previous host's status would render its
  // provider/paths/counts as if they belonged to the new host.
  const statusBaseUrlRef = useRef(baseUrl);

  // The query the search UI reads/writes: shared with the MemoryManager
  // when the prop is present, local otherwise.
  const effectiveQuery = sharedSearch?.query ?? query;
  const setEffectiveQuery = sharedSearch?.setQuery ?? setQuery;
  const saveVectorSnapshot = sharedSearch?.setVectorSnapshot;
  useEffect(() => {
    saveVectorSnapshot?.({
      query: effectiveQuery,
      hits,
      nextCursor,
      similarity,
      limit,
      threshold,
      searchRan,
    });
  }, [
    saveVectorSnapshot,
    effectiveQuery,
    hits,
    nextCursor,
    similarity,
    limit,
    threshold,
    searchRan,
  ]);

  // The raw vector route cannot apply SAGE status/kind filters server-side
  // (it would need to reject them with a 400). Surface that explicitly and
  // block the search instead of silently ignoring the active filters.
  const unsupportedFilters =
    sharedSearch !== undefined &&
    (sharedSearch.statusFilter !== 'all' || sharedSearch.kindFilter !== 'all');
  const unsupportedReasons = sharedSearch
    ? [
        ...(sharedSearch.statusFilter !== 'all' ? [`status "${sharedSearch.statusFilter}"`] : []),
        ...(sharedSearch.kindFilter !== 'all' ? [`kind "${sharedSearch.kindFilter}"`] : []),
      ]
    : [];

  /** Drop the current result page + cursor and invalidate in-flight work. */
  const resetResults = () => {
    searchSeqRef.current += 1;
    resultVersionRef.current += 1;
    setSearching(false);
    setLoadingMore(false);
    setHits([]);
    setSimilarity(undefined);
    setNextCursor(null);
    setSearchRan(false);
    setExpandedId(null);
  };

  // Only setState setters (stable) and refs are touched — deps are complete.
  useEffect(() => {
    const prev = paramsRef.current;
    if (prev.query === effectiveQuery && prev.threshold === threshold && prev.limit === limit) {
      return;
    }
    paramsRef.current = { query: effectiveQuery, threshold, limit };
    resetResults();
  }, [effectiveQuery, threshold, limit]);

  useEffect(() => {
    let cancelled = false;
    if (statusBaseUrlRef.current !== baseUrl) {
      statusBaseUrlRef.current = baseUrl;
      statusLoadedRef.current = false;
      setStatus(undefined);
      setStatusError(undefined);
    }
    fetchVectorMemoryStatus(baseUrl)
      .then((s) => {
        if (!cancelled) {
          statusLoadedRef.current = true;
          setStatus(s);
          setStatusError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Only tear the panel down before the first successful load.
        if (!statusLoadedRef.current) {
          setStatus(undefined);
          setStatusError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, statusNonce]);

  const runSearch = async (mode: 'fresh' | 'more') => {
    const q = effectiveQuery.trim();
    if (mode === 'fresh' && q.length === 0) return;
    if (unsupportedFilters) return; // defensive: the controls are disabled
    const cursor = mode === 'more' ? nextCursor : null;
    if (mode === 'more' && cursor === null) return;
    const seq = ++searchSeqRef.current;
    if (mode === 'fresh') {
      setSearching(true);
      // New result set invalidates any expanded hit and stale confirm state.
      setExpandedId(null);
      setForgetTarget(null);
      setForgetError(undefined);
    } else {
      setLoadingMore(true);
    }
    setSearchError(undefined);
    try {
      const result = await searchVectorMemory(q, {
        limit,
        ...(threshold !== undefined ? { threshold } : {}),
        // Similarity is only requested for a fresh top page — an appended
        // page's matrix would not align with the grown hit list, so the
        // heatmap is dropped when loading more.
        similarity: mode === 'fresh',
        baseUrl,
        ...(cursor !== null ? { cursor } : {}),
      });
      // Stale response guard: only the latest issued request may commit.
      if (seq !== searchSeqRef.current) return;
      setHits((prev) => (mode === 'fresh' ? result.hits : [...prev, ...result.hits]));
      setSimilarity(result.similarity);
      setNextCursor(result.nextCursor);
      setSearchRan(true);
    } catch (err: unknown) {
      if (seq !== searchSeqRef.current) return;
      if (mode === 'fresh') {
        setHits([]);
        setSimilarity(undefined);
        setNextCursor(null);
      }
      setSearchError(err instanceof Error ? err.message : String(err));
      setSearchRan(true);
    } finally {
      // Any search *completion* — success or failure — invalidates an
      // in-flight forget's patch: success replaces the list, failure clears
      // it, and patching either with pre-search indices would corrupt state.
      // A stale completion skips this: a newer request (or an input-change
      // reset, which clears the flags itself) owns the busy state now.
      if (seq === searchSeqRef.current) {
        resultVersionRef.current += 1;
        if (mode === 'fresh') setSearching(false);
        else setLoadingMore(false);
      }
    }
  };

  const onConfirmForget = async () => {
    if (forgetTarget === null) return;
    const id = forgetTarget.id;
    const version = resultVersionRef.current;
    // Pin the result-set snapshot this forget's index math belongs to. The
    // version guard below is the correctness check; the snapshots make the
    // patch self-contained (no closure reads past this line).
    const hitSnapshot = hits;
    const similaritySnapshot = similarity;
    setForgetBusy(true);
    setForgetError(undefined);
    try {
      const { removed } = await forgetVectorMemory(id, { baseUrl });
      if (removed) {
        // Patch the list/matrix only if no newer search landed while the
        // DELETE was in flight — indices are aligned to the result set the
        // forget started from, and applying them to a newer set would
        // corrupt the similarity matrix.
        if (resultVersionRef.current === version) {
          const forgottenIndex = hitSnapshot.findIndex((h) => h.id === id);
          setHits(hitSnapshot.filter((h) => h.id !== id));
          if (similaritySnapshot !== undefined && forgottenIndex >= 0) {
            setSimilarity(
              similaritySnapshot
                .filter((_, i) => i !== forgottenIndex)
                .map((row) => row.filter((_, j) => j !== forgottenIndex)),
            );
          }
          if (expandedId === id) setExpandedId(null);
        }
        // Dismiss only a confirm dialog that still targets the entry we
        // forgot — if the user somehow queued a different hit meanwhile,
        // its pending confirm must survive.
        setForgetTarget((prev) => (prev?.id === id ? null : prev));
        // Entry/vector counts in the status strip are now stale.
        setStatusNonce((n) => n + 1);
      } else {
        setForgetError(t('activity:memoryManager.vector.forgetNotRemoved'));
      }
    } catch (err: unknown) {
      setForgetError(err instanceof Error ? err.message : String(err));
    } finally {
      setForgetBusy(false);
    }
  };

  // Shown only for an actually-executed search (searchRan) that returned
  // nothing — not for a list cleared because the user is editing inputs.
  const noHits =
    hits.length === 0 && searching === false && searchRan && effectiveQuery.trim().length > 0;

  if (statusError !== undefined) {
    return (
      <div className="vector-memory-panel vector-memory-panel--error">
        <h3>{t('activity:memoryManager.vector.title')}</h3>
        <p>{t('activity:memoryManager.vector.statusUnavailable', { error: statusError })}</p>
      </div>
    );
  }
  if (status === undefined) {
    return (
      <div className="vector-memory-panel vector-memory-panel--loading">
        <h3>{t('activity:memoryManager.vector.title')}</h3>
        <p>{t('activity:memoryManager.vector.loadingStatus')}</p>
      </div>
    );
  }
  if (!status.enabled) {
    return (
      <div className="vector-memory-panel vector-memory-panel--disabled">
        <h3>{t('activity:memoryManager.vector.title')}</h3>
        <p>{t('activity:memoryManager.vector.disabledNote')}</p>
      </div>
    );
  }

  return (
    <div className="vector-memory-panel">
      <h3>{t('activity:memoryManager.vector.title')}</h3>
      <dl className="vector-memory-panel__status">
        <dt>{t('activity:memoryManager.vector.activeProvider')}</dt>
        <dd>
          <code>{status.providerId ?? 'unknown'}</code>
        </dd>
        <dt>{t('activity:memoryManager.vector.model')}</dt>
        <dd>
          <code>{status.modelId ?? 'unknown'}</code>
        </dd>
        <dt>{t('activity:memoryManager.vector.dimensions')}</dt>
        <dd>{status.dimensions ?? 'unknown'}</dd>
        <dt>{t('activity:memoryManager.vector.entriesVectors')}</dt>
        <dd>
          {status.entries ?? 0} / {status.vectors ?? 0}
        </dd>
        <dt>{t('activity:memoryManager.vector.storePath')}</dt>
        <dd>
          <code>{status.storePath ?? t('activity:memoryManager.vector.projectRoot')}</code>
        </dd>
        <dt>{t('activity:memoryManager.vector.modelCache')}</dt>
        <dd>
          <code>{status.modelCacheDir ?? t('activity:memoryManager.vector.projectRoot')}</code>
        </dd>
        <dt>{t('activity:memoryManager.vector.providers')}</dt>
        <dd>{status.providers?.join(', ') ?? ''}</dd>
        {status.cache ? (
          <>
            <dt>{t('activity:memoryManager.vector.embeddingCache')}</dt>
            <dd>
              {t('activity:memoryManager.vector.embeddingCacheStats', {
                entries: status.cache.entries,
                providers: status.cache.providers,
                hits: status.cache.totalUseCount,
              })}
            </dd>
          </>
        ) : null}
      </dl>

      <div className="vector-memory-panel__search">
        <label htmlFor="vm-query">{t('activity:memoryManager.vector.queryLabel')}</label>
        <input
          id="vm-query"
          type="text"
          value={effectiveQuery}
          onChange={(e) => setEffectiveQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !unsupportedFilters) void runSearch('fresh');
          }}
          placeholder={t('activity:memoryManager.vector.queryPlaceholder')}
        />
        <div className="vector-memory-panel__controls">
          <label>
            {t('activity:memoryManager.vector.limitLabel')}
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) =>
                setLimit(Math.max(1, Math.min(50, Number(e.currentTarget.value) || 10)))
              }
            />
          </label>
          <label>
            {t('activity:memoryManager.vector.thresholdLabel')}
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={threshold ?? ''}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                setThreshold(raw === '' ? undefined : Number.parseFloat(raw));
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void runSearch('fresh')}
            disabled={searching || loadingMore || unsupportedFilters}
          >
            {searching
              ? t('activity:memoryManager.vector.searching')
              : t('activity:memoryManager.vector.searchButton')}
          </button>
        </div>
        {unsupportedFilters ? (
          <p
            className="vector-memory-panel__error"
            role="note"
            data-testid="vm-unsupported-filters"
          >
            {t('activity:memoryManager.vector.unsupportedFilters', {
              count: unsupportedReasons.length,
              reasons: unsupportedReasons.join(', '),
            })}
          </p>
        ) : null}
      </div>

      {searchError !== undefined ? (
        <p className="vector-memory-panel__error">
          {t('activity:memoryManager.vector.searchErrorPrefix', { error: searchError })}
        </p>
      ) : null}

      <ol className="vector-memory-panel__hits">
        {hits.map((h, rankIndex) => {
          const expanded = expandedId === h.id;
          const rank = rankIndex + 1;
          const sage = h.sage;
          return (
            <li
              key={h.id}
              className={
                expanded
                  ? 'vector-memory-panel__hit vector-memory-panel__hit--expanded'
                  : 'vector-memory-panel__hit'
              }
            >
              <button
                type="button"
                className="vector-memory-panel__hit-toggle"
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? null : h.id)}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={
                    expanded
                      ? 'vector-memory-panel__hit-chevron vector-memory-panel__hit-chevron--open'
                      : 'vector-memory-panel__hit-chevron'
                  }
                />
                <span className="vector-memory-panel__hit-score">{h.score.toFixed(3)}</span>
                {h.summary ? (
                  <span className="vector-memory-panel__hit-summary">{h.summary}</span>
                ) : null}
              </button>
              <p className="vector-memory-panel__hit-text">
                {expanded ? h.text : previewText(h.text)}
              </p>
              <p className="vector-memory-panel__hit-tags">
                {/* Ranked provenance badges: position in the accumulated
                      ranked list, then entry kind/scope, then SAGE linkage. */}
                <span
                  role="img"
                  className="vector-memory-panel__hit-tag"
                  aria-label={t('activity:memoryManager.vector.rankAria', { rank })}
                >
                  #{rank}
                </span>
                {h.kind !== undefined ? (
                  <span className="vector-memory-panel__hit-tag">
                    {t('activity:memoryManager.vector.kindTag', { kind: h.kind })}
                  </span>
                ) : null}
                {h.scope !== undefined ? (
                  <span className="vector-memory-panel__hit-tag">
                    {t('activity:memoryManager.vector.scopeTag', { scope: h.scope })}
                  </span>
                ) : null}
                {h.tags.map((tag) => (
                  <span key={tag} className="vector-memory-panel__hit-tag">
                    {tag}
                  </span>
                ))}
                {sage !== undefined ? (
                  <>
                    <span className="vector-memory-panel__hit-tag">
                      {t('activity:memoryManager.vector.sageVerifiedTag')}
                    </span>
                    {sharedSearch !== undefined ? (
                      <button
                        type="button"
                        className="vector-memory-panel__hit-tag"
                        style={{ background: 'transparent', cursor: 'pointer' }}
                        onClick={() => sharedSearch.navigateToSage(sage.id)}
                      >
                        {t('activity:memoryManager.vector.openInSage')}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </p>
              {expanded ? (
                <div className="vector-memory-panel__hit-detail">
                  <dl className="vector-memory-panel__hit-fields">
                    <dt>{t('activity:memoryManager.vector.fieldId')}</dt>
                    <dd>
                      <code>{h.id}</code>
                    </dd>
                    <dt>{t('activity:memoryManager.vector.fieldRank')}</dt>
                    <dd>#{rank}</dd>
                    <dt>{t('activity:memoryManager.vector.fieldScore')}</dt>
                    <dd>{h.score.toFixed(3)}</dd>
                    {h.kind !== undefined ? (
                      <>
                        <dt>{t('activity:memoryManager.vector.fieldKind')}</dt>
                        <dd>{h.kind}</dd>
                      </>
                    ) : null}
                    {h.scope !== undefined ? (
                      <>
                        <dt>{t('activity:memoryManager.vector.fieldScope')}</dt>
                        <dd>{h.scope}</dd>
                      </>
                    ) : null}
                    {sage !== undefined ? (
                      <>
                        <dt>{t('activity:memoryManager.vector.fieldSage')}</dt>
                        <dd>
                          <code>{sage.id}</code>{' '}
                          {t('activity:memoryManager.vector.sageVerifiedSuffix')}
                        </dd>
                      </>
                    ) : null}
                    {h.summary ? (
                      <>
                        <dt>{t('activity:memoryManager.vector.fieldSummary')}</dt>
                        <dd>{h.summary}</dd>
                      </>
                    ) : null}
                  </dl>
                  <div className="vector-memory-panel__hit-actions">
                    <button
                      type="button"
                      className="vector-memory-panel__forget"
                      onClick={() => {
                        setForgetError(undefined);
                        setForgetTarget(h);
                      }}
                    >
                      {t('activity:memoryManager.vector.forgetButton')}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
        {noHits ? (
          <li className="vector-memory-panel__no-hits">
            {t('activity:memoryManager.vector.noResults')}
          </li>
        ) : null}
      </ol>

      {nextCursor !== null ? (
        <div className="vector-memory-panel__controls">
          {/* Reuses the search-controls button styling: CSS additions are out
              of scope for this change and the class keeps Load more visually
              consistent with the panel's only other button. */}
          <button
            type="button"
            onClick={() => void runSearch('more')}
            disabled={searching || loadingMore || unsupportedFilters}
          >
            {loadingMore
              ? t('activity:memoryManager.vector.loadingMore')
              : t('activity:memoryManager.vector.loadMore')}
          </button>
        </div>
      ) : null}

      {similarity !== undefined && similarity.length > 1 ? (
        <div className="vector-memory-panel__heatmap" data-testid="vector-memory-heatmap">
          <h4>{t('activity:memoryManager.vector.heatmapTitle')}</h4>
          <p className="vector-memory-panel__heatmap-hint">
            {t('activity:memoryManager.vector.heatmapHint')}
          </p>
          {/* biome-ignore lint/a11y/useSemanticElements: CSS-grid heatmap; a <table> cannot take this grid layout. */}
          <div
            className="vector-memory-panel__heatmap-grid"
            style={{
              gridTemplateColumns: `auto repeat(${similarity.length}, minmax(20px, 1fr))`,
            }}
            role="table"
            aria-label={t('activity:memoryManager.vector.heatmapAria')}
          >
            <div className="vector-memory-panel__heatmap-corner" />
            {similarity.map((_, j) => (
              <div key={`col-${j}`} className="vector-memory-panel__heatmap-col-label">
                {j + 1}
              </div>
            ))}
            {similarity.map((row, i) => (
              <SimilarityRow key={`row-${i}`} row={row} index={i} />
            ))}
          </div>
        </div>
      ) : null}

      <ForgetVectorMemoryDialog
        hit={forgetTarget}
        busy={forgetBusy}
        error={forgetError}
        onCancel={() => setForgetTarget(null)}
        onConfirm={() => void onConfirmForget()}
        onOpenChange={(open) => {
          if (!open && !forgetBusy) setForgetTarget(null);
        }}
      />
    </div>
  );
}

/** One row of the similarity heatmap. The diagonal is forced to 1.0. */
function SimilarityRow({ row, index }: { row: readonly number[]; index: number }): ReactElement {
  const { t } = useAppTranslation();
  return (
    <>
      <div className="vector-memory-panel__heatmap-row-label">{index + 1}</div>
      {row.map((score, j) => {
        // Diagonal cell is always 1 — render a brighter accent.
        const isDiagonal = index === j;
        const clamped = Math.max(0, Math.min(1, score));
        // Map [0,1] → grayscale with a faint blue tint on hot cells. We
        // avoid an external color library: HSL via inline style.
        const lightness = 95 - clamped * 60;
        const saturation = isDiagonal ? 0 : 35;
        const background = `hsl(220, ${saturation}%, ${lightness}%)`;
        return (
          // biome-ignore lint/a11y/useSemanticElements: cell of the CSS-grid heatmap above.
          <div
            key={`cell-${index}-${j}`}
            className={
              isDiagonal
                ? 'vector-memory-panel__heatmap-cell vector-memory-panel__heatmap-cell--diagonal'
                : 'vector-memory-panel__heatmap-cell'
            }
            style={{ background }}
            role="cell"
            aria-label={t('activity:memoryManager.vector.cellAria', {
              i: index + 1,
              j: j + 1,
              score: clamped.toFixed(2),
            })}
            title={t('activity:memoryManager.vector.cellTitle', {
              i: index + 1,
              j: j + 1,
              score: clamped.toFixed(3),
            })}
          >
            {clamped >= 0.5 ? clamped.toFixed(2) : ''}
          </div>
        );
      })}
    </>
  );
}
