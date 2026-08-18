/**
 * Vector Memory Panel — minimal WebUI surface showing the active store,
 * model cache location, entry counts, and a semantic-search UI with
 * ranked results. Disabled (renders a placeholder) when the webui-server
 * host doesn't wire a vector store — see `fetchVectorMemoryStatus()` which
 * returns `{ enabled: false }` in that case.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';

import { ForgetVectorMemoryDialog } from './ForgetVectorMemoryDialog.js';
import {
  fetchVectorMemoryStatus,
  forgetVectorMemory,
  previewText,
  searchVectorMemory,
  type VectorMemoryHit,
  type VectorMemoryStatus,
} from './model.js';

export interface VectorMemoryPanelProps {
  /** Base URL prefix for the webui-server. Default: same-origin. */
  baseUrl?: string;
}

export function VectorMemoryPanel({
  baseUrl = '',
}: VectorMemoryPanelProps = {}): ReactElement {
  const [status, setStatus] = useState<VectorMemoryStatus | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(10);
  const [threshold, setThreshold] = useState<number | undefined>(undefined);
  const [hits, setHits] = useState<readonly VectorMemoryHit[]>([]);
  const [similarity, setSimilarity] = useState<readonly (readonly number[])[] | undefined>();
  const [searchError, setSearchError] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
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
  // True once any status fetch has succeeded. A later failed refetch (e.g.
  // after a forget bumped statusNonce) keeps the last good status instead of
  // unmounting an enabled panel — counts just stay stale until next poll.
  const statusLoadedRef = useRef(false);
  // The host the current `status` belongs to. A baseUrl change must start
  // from a clean slate: keeping the previous host's status would render its
  // provider/paths/counts as if they belonged to the new host.
  const statusBaseUrlRef = useRef(baseUrl);

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

  const onSearch = async () => {
    const q = query.trim();
    if (q.length === 0) return;
    setSearching(true);
    setSearchError(undefined);
    // New result set invalidates any expanded hit and stale confirm state.
    setExpandedId(null);
    setForgetTarget(null);
    setForgetError(undefined);
    try {
      const result = await searchVectorMemory(q, {
        limit,
        ...(threshold !== undefined ? { threshold } : {}),
        similarity: true,
        baseUrl,
      });
      setHits(result.hits);
      setSimilarity(result.similarity);
    } catch (err: unknown) {
      setHits([]);
      setSimilarity(undefined);
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      // Any search *completion* — success or failure — invalidates an
      // in-flight forget's patch: success replaces the list, failure clears
      // it, and patching either with pre-search indices would corrupt state.
      resultVersionRef.current += 1;
      setSearching(false);
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
        setForgetTarget((t) => (t?.id === id ? null : t));
        // Entry/vector counts in the status strip are now stale.
        setStatusNonce((n) => n + 1);
      } else {
        setForgetError('The store reported the entry was not removed.');
      }
    } catch (err: unknown) {
      setForgetError(err instanceof Error ? err.message : String(err));
    } finally {
      setForgetBusy(false);
    }
  };

  if (statusError !== undefined) {
    return (
      <div className="vector-memory-panel vector-memory-panel--error">
        <h3>Vector Memory</h3>
        <p>Status unavailable: {statusError}</p>
      </div>
    );
  }
  if (status === undefined) {
    return (
      <div className="vector-memory-panel vector-memory-panel--loading">
        <h3>Vector Memory</h3>
        <p>Loading status…</p>
      </div>
    );
  }
  if (!status.enabled) {
    return (
      <div className="vector-memory-panel vector-memory-panel--disabled">
        <h3>Vector Memory</h3>
        <p>
          Disabled — the webui-server host does not have a vector memory store wired.
        </p>
      </div>
    );
  }

  return (
    <div className="vector-memory-panel">
      <h3>Vector Memory</h3>
      <dl className="vector-memory-panel__status">
        <dt>Active provider</dt>
        <dd>
          <code>{status.providerId ?? 'unknown'}</code>
        </dd>
        <dt>Model</dt>
        <dd>
          <code>{status.modelId ?? 'unknown'}</code>
        </dd>
        <dt>Dimensions</dt>
        <dd>{status.dimensions ?? 'unknown'}</dd>
        <dt>Entries / vectors</dt>
        <dd>
          {status.entries ?? 0} / {status.vectors ?? 0}
        </dd>
        <dt>Store path</dt>
        <dd>
          <code>{status.storePath ?? '(project root)'}</code>
        </dd>
        <dt>Model cache</dt>
        <dd>
          <code>{status.modelCacheDir ?? '(project root)'}</code>
        </dd>
        <dt>Providers</dt>
        <dd>{status.providers?.join(', ') ?? ''}</dd>
        {status.cache ? (
          <>
            <dt>Embedding cache</dt>
            <dd>
              {status.cache.entries} entries · {status.cache.providers} provider
              {status.cache.providers === 1 ? '' : 's'} · {status.cache.totalUseCount} hits
            </dd>
          </>
        ) : null}
      </dl>

      <div className="vector-memory-panel__search">
        <label htmlFor="vm-query">Query</label>
        <input
          id="vm-query"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onSearch();
          }}
          placeholder="apple banana"
        />
        <div className="vector-memory-panel__controls">
          <label>
            limit
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.currentTarget.value) || 10)))}
            />
          </label>
          <label>
            threshold
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
          <button type="button" onClick={() => void onSearch()} disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {searchError !== undefined ? (
        <p className="vector-memory-panel__error">Search error: {searchError}</p>
      ) : null}

      <ol className="vector-memory-panel__hits">
        {hits.map((h) => {
          const expanded = expandedId === h.id;
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
              {h.tags.length > 0 ? (
                <p className="vector-memory-panel__hit-tags">
                  {h.tags.map((t) => (
                    <span key={t} className="vector-memory-panel__hit-tag">
                      {t}
                    </span>
                  ))}
                </p>
              ) : null}
              {expanded ? (
                <div className="vector-memory-panel__hit-detail">
                  <dl className="vector-memory-panel__hit-fields">
                    <dt>id</dt>
                    <dd>
                      <code>{h.id}</code>
                    </dd>
                    <dt>score</dt>
                    <dd>{h.score.toFixed(3)}</dd>
                    {h.summary ? (
                      <>
                        <dt>summary</dt>
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
                      Forget
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
        {hits.length === 0 && searching === false && query.trim().length > 0 ? (
          <li className="vector-memory-panel__no-hits">No results.</li>
        ) : null}
      </ol>

      {similarity !== undefined && similarity.length > 1 ? (
        <div className="vector-memory-panel__heatmap" data-testid="vector-memory-heatmap">
          <h4>Result similarity</h4>
          <p className="vector-memory-panel__heatmap-hint">
            Pairwise cosine similarity between returned hits. Darker cells = more similar.
            A bright diagonal with mostly dark off-diagonals means results form
            a tight cluster; a noisy grid means the search returned mixed topics.
          </p>
          <div
            className="vector-memory-panel__heatmap-grid"
            style={{
              gridTemplateColumns: `auto repeat(${similarity.length}, minmax(20px, 1fr))`,
            }}
            role="table"
            aria-label="Pairwise cosine similarity between returned hits"
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
function SimilarityRow({
  row,
  index,
}: {
  row: readonly number[];
  index: number;
}): ReactElement {
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
          <div
            key={`cell-${index}-${j}`}
            className={
              isDiagonal
                ? 'vector-memory-panel__heatmap-cell vector-memory-panel__heatmap-cell--diagonal'
                : 'vector-memory-panel__heatmap-cell'
            }
            style={{ background }}
            role="cell"
            aria-label={`hit ${index + 1} vs hit ${j + 1}: ${clamped.toFixed(2)}`}
            title={`hit ${index + 1} ↔ hit ${j + 1}: ${clamped.toFixed(3)}`}
          >
            {clamped >= 0.5 ? clamped.toFixed(2) : ''}
          </div>
        );
      })}
    </>
  );
}
