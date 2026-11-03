import { surfaceFetch } from '../host';
/** WebUI adapter for the ranked SAGE pages; separate from recency library pages. */
export interface RankedSageHit {
  id: string;
  text: string;
  kind: string;
  scope: string;
  status: string;
  score: number;
  bm25?: number | null;
  matchReason: string;
}

export interface RankedSagePage {
  hits: RankedSageHit[];
  count: number;
  totalCandidates: number;
  nextCursor: string | null;
  rankingApplied: string;
  matchChannel: 'fts' | 'plain';
}

export async function fetchRankedSagePage(
  query: string,
  filters: { status: string; kind: string; cursor?: string },
  signal?: AbortSignal,
): Promise<RankedSagePage> {
  const params = new URLSearchParams({ q: query, limit: '20' });
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.kind !== 'all') params.set('kind', filters.kind);
  if (filters.cursor) params.set('cursor', filters.cursor);
  const response = await surfaceFetch(`/api/memory/search-page?${params}`, {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `SAGE search failed: HTTP ${response.status}`);
  }
  return (await response.json()) as RankedSagePage;
}

export async function resolveSearchMemory(id: string, signal?: AbortSignal) {
  const response = await surfaceFetch(`/api/memory/resolve/${encodeURIComponent(id)}`, {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Memory unavailable: HTTP ${response.status}`);
  }
  return (await response.json()) as { memory: import('./model-types').SageEntry };
}
