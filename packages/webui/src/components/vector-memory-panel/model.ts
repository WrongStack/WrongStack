/**
 * Vector Memory panel — minimal visibility surface for the WebUI.
 *
 * Fetches `/api/vector-memory/status` and `/api/vector-memory/search` to
 * show the active store/provider, model cache location, entry counts, and
 * a search UI with ranked results. When the route is disabled (the
 * webui-server host doesn't wire a vector store), the panel renders a
 * disabled placeholder.
 */
import { useEffect, useMemo, useState } from 'react';

export interface VectorMemoryCacheStats {
  entries: number;
  providers: number;
  totalUseCount: number;
  oldestLastUsedAt: string | null;
}

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
  /** Provider-level embedding cache (same text → skip the ONNX forward pass). */
  cache?: VectorMemoryCacheStats | undefined;
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
  /**
   * Pairwise cosine similarity matrix between hits (in hit order). Only
   * populated when the client opts in via `similarity: true`. Used by the
   * heatmap view to surface whether the top-K results form coherent
   * clusters.
   */
  similarity?: number[][] | undefined;
}

/** Fetch the current vector-memory status from the webui-server. */
export async function fetchVectorMemoryStatus(
  baseUrl = '',
): Promise<VectorMemoryStatus> {
  const response = await fetch(`${baseUrl}/api/vector-memory/status`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`status failed: HTTP ${response.status}`);
  }
  return (await response.json()) as VectorMemoryStatus;
}

/** Run a semantic search query against the vector-memory store. */
export async function searchVectorMemory(
  query: string,
  opts: { limit?: number; threshold?: number; similarity?: boolean; baseUrl?: string } = {},
): Promise<VectorMemorySearchResponse> {
  const params = new URLSearchParams();
  params.set('q', query);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.threshold !== undefined) params.set('threshold', String(opts.threshold));
  if (opts.similarity === true) params.set('similarity', '1');
  const response = await fetch(
    `${opts.baseUrl ?? ''}/api/vector-memory/search?${params.toString()}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    throw new Error(`search failed: HTTP ${response.status}`);
  }
  return (await response.json()) as VectorMemorySearchResponse;
}

/** Collapse whitespace and truncate with an ellipsis — same preview contract
 *  as the MemoryManager's `memoryPreview`, kept local so the panel stays
 *  self-contained (no cross-feature import). */
export function previewText(text: string, max = 170): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/** Forget (hard-remove) a single entry and its embedding from the
 *  vector-memory store. Maps to `DELETE /api/vector-memory/store/:id`. */
export async function forgetVectorMemory(
  id: string,
  opts: { baseUrl?: string } = {},
): Promise<{ removed: boolean }> {
  const response = await fetch(
    `${opts.baseUrl ?? ''}/api/vector-memory/store/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      credentials: 'include',
    },
  );
  if (!response.ok) {
    throw new Error(`forget failed: HTTP ${response.status}`);
  }
  return (await response.json()) as { removed: boolean };
}

/** Hook: track the live status, re-fetching on focus. */
export function useVectorMemoryStatus(baseUrl = ''): {
  status: VectorMemoryStatus | undefined;
  error: string | undefined;
  reload: () => void;
} {
  const [status, setStatus] = useState<VectorMemoryStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchVectorMemoryStatus(baseUrl)
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus(undefined);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, reloadKey]);
  return {
    status,
    error,
    reload: useMemo(() => () => setReloadKey((k) => k + 1), []),
  };
}
