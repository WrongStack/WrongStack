/**
 * Vector Memory Panel — minimal SimpleUI surface mirroring the WebUI
 * panel. Fetches `/api/vector-memory/status` and `/api/vector-memory/search`
 * to show the active store/provider, model cache location, entry counts,
 * and a search UI with ranked results. When the route is disabled (the
 * webui-server host doesn't wire a vector store), the panel renders a
 * disabled placeholder.
 */
import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { onSimplePanel } from './lib/panel-events.js';

export interface VectorMemoryStatus {
  enabled: boolean;
  storePath?: string | undefined;
  modelCacheDir?: string | undefined;
  providerId?: string | undefined;
  modelId?: string | undefined;
  dimensions?: number | undefined;
  entries?: number | undefined;
  vectors?: number | undefined;
  providers?: string[] | undefined;
}

export interface VectorMemoryHit {
  id: string;
  score: number;
  text: string;
  summary?: string | undefined;
  tags: string[];
}

export interface VectorMemorySearchResponse {
  hits: VectorMemoryHit[];
  count: number;
}

export interface VectorMemoryPanelProps {
  /** Base URL prefix for the webui-server. Default: same-origin. */
  baseUrl?: string;
}

async function fetchVectorMemoryStatus(baseUrl = ''): Promise<VectorMemoryStatus> {
  const response = await fetch(`${baseUrl}/api/vector-memory/status`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`status failed: HTTP ${response.status}`);
  }
  return (await response.json()) as VectorMemoryStatus;
}

async function searchVectorMemory(
  query: string,
  opts: { limit?: number; threshold?: number; baseUrl?: string } = {},
): Promise<VectorMemorySearchResponse> {
  const params = new URLSearchParams();
  params.set('q', query);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.threshold !== undefined) params.set('threshold', String(opts.threshold));
  const response = await fetch(
    `${opts.baseUrl ?? ''}/api/vector-memory/search?${params.toString()}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    throw new Error(`search failed: HTTP ${response.status}`);
  }
  return (await response.json()) as VectorMemorySearchResponse;
}

export function VectorMemoryPanel({ baseUrl = '' }: VectorMemoryPanelProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<VectorMemoryStatus | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(10);
  const [threshold, setThreshold] = useState<number | undefined>(undefined);
  const [hits, setHits] = useState<readonly VectorMemoryHit[]>([]);
  const [searchError, setSearchError] = useState<string | undefined>();
  const [searching, setSearching] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onClose = () => setOpen(false);
    const unsubOpen = onSimplePanel('open-vector-memory-panel', onOpen);
    const unsubClose = onSimplePanel('close-vector-memory-panel', onClose);
    return () => {
      unsubOpen();
      unsubClose();
    };
  }, []);

  // Escape closes the panel only while it is open — a globally-bound handler
  // would swallow Escape for every other surface while the panel is closed.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [baseUrl, open]);

  const onSearch = async () => {
    const q = query.trim();
    if (q.length === 0) return;
    setSearching(true);
    setSearchError(undefined);
    try {
      const result = await searchVectorMemory(q, {
        limit,
        ...(threshold !== undefined ? { threshold } : {}),
        baseUrl,
      });
      setHits(result.hits);
    } catch (err: unknown) {
      setHits([]);
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="settings-overlay"
        tabIndex={-1}
        aria-label="Close vector memory panel"
        onClick={() => setOpen(false)}
      />
      <div
        className="vector-memory-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Vector memory"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="vector-memory-panel__head">
          <h3>Vector Memory</h3>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close vector memory panel"
            ref={closeRef}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        {statusError !== undefined ? (
          <p className="vector-memory-panel__error">Status unavailable: {statusError}</p>
        ) : status === undefined ? (
          <p className="vector-memory-panel__loading">Loading status…</p>
        ) : !status.enabled ? (
          <p className="vector-memory-panel__disabled">
            Disabled — the webui-server host does not have a vector memory store wired.
          </p>
        ) : (
          <>
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
                    onChange={(e) =>
                      setLimit(Math.max(1, Math.min(50, Number(e.currentTarget.value) || 10)))
                    }
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
                  <Search aria-hidden="true" /> {searching ? 'Searching…' : 'Search'}
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
          </>
        )}
      </div>
    </>
  );
}
