import type * as http from 'node:http';
import type { MemoryPort } from '@wrongstack/contracts/types';
import { sanitizeApiError } from '@wrongstack/core/security';
import { getSageSurface, type Sage } from '@wrongstack/sage';

interface MemorySearchHit {
  id: string;
  text: string;
  kind: string;
  status: string;
  tags: string[];
  /** Per-channel score breakdown — null on the side that didn't contribute. */
  lexicalScore: number | null;
  vectorScore: number | null;
  /** RRF-style combined score, monotonically higher = better. */
  finalScore: number;
  /** Which channel(s) produced this hit. */
  source: 'lexical' | 'vector' | 'both';
}

interface MemorySearchResponse {
  hits: MemorySearchHit[];
  count: number;
  /**
   * Where the score breakdown came from. `breakdown` means the rich
   * variant was used (vector channel was wired); `lexical` means the
   * fallback synthesized a position-derived score because the surface
   * doesn't ship `searchSageWithBreakdown`. The UI branches on this to
   * decide whether to show a dual-column score card or a single column.
   */
  channel: 'breakdown' | 'lexical';
}

/**
 * Parse the search params from a URL into the shape `handleMemorySearch`
 * expects. Whitelists `q`, `limit`, `explain`. `explain=1` opts in to
 * the rich per-channel breakdown — off by default so the cheap
 * `/api/memory/search` route stays cheap.
 */
function parseMemorySearchParams(url: URL): {
  query: string;
  limit: number;
  explain: boolean;
} {
  const query = url.searchParams.get('q') ?? '';
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
  const explain = url.searchParams.get('explain') === '1';
  return { query, limit, explain };
}

/**
 * Handle `GET /api/memory/search?q=…&limit=…&explain=1`.
 *
 * Returns SAGE search hits. When `explain=1` is set and the underlying
 * memory store exposes `searchSageWithBreakdown`, each hit carries a
 * per-channel score breakdown (lexical, vector, RRF final, `source`
 * attribution). Without the flag — or when the rich variant isn't
 * available — the response degrades to lexical-only hits with
 * `vectorScore: null` and `source: 'lexical'`, plus a top-level
 * `channel: 'lexical'` so the caller can branch.
 */
export async function handleMemorySearch(
  res: http.ServerResponse,
  url: URL,
  getStore: () => MemoryPort | undefined,
): Promise<void> {
  const store = getStore();
  if (!store) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Memory store not enabled in this host' }));
    return;
  }
  const { query, limit, explain } = parseMemorySearchParams(url);
  if (query.trim().length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required query parameter `q`' }));
    return;
  }
  const Sage = getSageSurface(store);
  if (!Sage) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Memory search requires the SAGE surface (this host does not expose it).',
      }),
    );
    return;
  }
  try {
    let payload: MemorySearchResponse;
    if (explain && typeof Sage.searchSageWithBreakdown === 'function') {
      const hits = await Sage.searchSageWithBreakdown(query, { limit });
      payload = {
        count: hits.length,
        channel: 'breakdown',
        hits: hits.map(
          (h: {
            memory: Sage;
            lexicalScore: number | null;
            vectorScore: number | null;
            finalScore: number;
            source: 'lexical' | 'vector' | 'both';
          }) => ({
            id: h.memory.id,
            text: h.memory.text,
            kind: h.memory.kind,
            status: h.memory.status,
            tags: h.memory.tags ?? [],
            lexicalScore: h.lexicalScore,
            vectorScore: h.vectorScore,
            finalScore: h.finalScore,
            source: h.source,
          }),
        ),
      };
    } else {
      const rows = await Sage.searchSage(query, { limit });
      const total = rows.length;
      payload = {
        count: total,
        channel: 'lexical',
        hits: rows.map((memory: Sage, index: number) => ({
          id: memory.id,
          text: memory.text,
          kind: memory.kind,
          status: memory.status,
          tags: memory.tags ?? [],
          lexicalScore: total <= 1 ? 1 : 1 - index / Math.max(1, total - 1),
          vectorScore: null,
          finalScore: total <= 1 ? 1 : 1 - index / Math.max(1, total - 1),
          source: 'lexical' as const,
        })),
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Memory search failed',
        detail: sanitizeApiError(error),
      }),
    );
  }
}
