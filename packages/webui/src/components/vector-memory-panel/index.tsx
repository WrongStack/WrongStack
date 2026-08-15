/**
 * Vector Memory Panel — minimal WebUI surface showing the active store,
 * model cache location, entry counts, and a semantic-search UI with
 * ranked results. Disabled (renders a placeholder) when the webui-server
 * host doesn't wire a vector store — see `fetchVectorMemoryStatus()` which
 * returns `{ enabled: false }` in that case.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import {
  fetchVectorMemoryStatus,
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

  useEffect(() => {
    let cancelled = false;
    fetchVectorMemoryStatus(baseUrl)
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setStatusError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus(undefined);
          setStatusError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  const onSearch = async () => {
    const q = query.trim();
    if (q.length === 0) return;
    setSearching(true);
    setSearchError(undefined);
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
      setSearching(false);
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
        {hits.map((h) => (
          <li key={h.id} className="vector-memory-panel__hit">
            <div className="vector-memory-panel__hit-header">
              <span className="vector-memory-panel__hit-score">{h.score.toFixed(3)}</span>
              {h.summary ? (
                <span className="vector-memory-panel__hit-summary">{h.summary}</span>
              ) : null}
            </div>
            <p className="vector-memory-panel__hit-text">{h.text}</p>
            {h.tags.length > 0 ? (
              <p className="vector-memory-panel__hit-tags">
                {h.tags.map((t) => (
                  <span key={t} className="vector-memory-panel__hit-tag">
                    {t}
                  </span>
                ))}
              </p>
            ) : null}
          </li>
        ))}
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
