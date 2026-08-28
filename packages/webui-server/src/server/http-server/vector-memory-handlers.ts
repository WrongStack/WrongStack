/**
 * Vector memory HTTP handlers — minimal visibility surface for the
 * WebUI/SimpleUI. Exposes the active store/provider, the model cache
 * location, entry counts, and a search endpoint. Strictly opt-in:
 * `getVectorMemoryStore` defaults to undefined so non-CLI webui-server
 * hosts (e.g. a headless fleet dashboard) are unaffected.
 */
import type * as http from 'node:http';
import { getSageSurface, type Sage } from '@wrongstack/sage';
import type { VectorMemoryStore, VectorSearchHit } from '@wrongstack/vector-memory';
import type { MemoryPort } from '@wrongstack/core/types';

import { sanitizeApiError } from '@wrongstack/core/security';
import { decodeSessionId, strictDecodeParam } from './security-helpers.js';

interface VectorMemoryStatusResponse {
  enabled: boolean;
  storePath?: string | undefined;
  modelCacheDir?: string | undefined;
  providerId?: string | undefined;
  modelId?: string | undefined;
  dimensions?: number | undefined;
  entries?: number | undefined;
  vectors?: number | undefined;
  providers?: string[] | undefined;
  cache?: {
    entries: number;
    providers: number;
    totalUseCount: number;
    oldestLastUsedAt: string | null;
  } | undefined;
}

interface VectorMemorySearchHit {
  id: string;
  score: number;
  text: string;
  summary?: string | undefined;
  tags: string[];
}

export interface VectorMemorySearchResponse {
  hits: VectorMemorySearchHit[];
  count: number;
  /**
   * Pairwise cosine similarity matrix between returned hits, in hit order.
   * Cell [i][j] is the similarity between hits[i] and hits[j]. Optional —
   * the route only computes it when `?similarity=1` is set, to keep the
   * default response cheap. Used by the WebUI's heatmap view to surface
   * whether the top-K results form coherent clusters.
   */
  similarity?: number[][] | undefined;
}

/** Shape the store exposes. Kept narrow so we don't leak the full class. */
interface VectorMemorySnapshot {
  storePath?: string | undefined;
  modelCacheDir?: string | undefined;
  stats: {
    entries: number;
    vectors: number;
    providers: string[];
    modelId: string;
    dimensions: number;
  };
}

/**
 * Snapshot the store's current state. Returns `null` when no store is
 * wired (the route then responds with `enabled: false`). The snapshot
 * is computed on each request — vector memory is small and the cost
 * of a single `SELECT COUNT(*)` is negligible.
 */
function snapshotVectorMemory(
  store: VectorMemoryStore,
  opts: { projectRoot?: string; modelCacheDir?: string } = {},
): VectorMemorySnapshot {
  const stats = store.stats();
  return {
    storePath: opts.projectRoot,
    modelCacheDir: opts.modelCacheDir,
    stats,
  };
}

function snapshotVectorMemoryCache(store: VectorMemoryStore): {
  entries: number;
  providers: number;
  totalUseCount: number;
  oldestLastUsedAt: string | null;
} {
  return store.cacheStats();
}

/** Handle `GET /api/vector-memory/status`. */
export async function handleVectorMemoryStatus(
  res: http.ServerResponse,
  getStore: () => VectorMemoryStore | undefined,
  opts: { projectRoot?: string; modelCacheDir?: string } = {},
): Promise<void> {
  const store = getStore();
  if (!store) {
    const body: VectorMemoryStatusResponse = { enabled: false };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  try {
    const snap = snapshotVectorMemory(store, opts);
    const body: VectorMemoryStatusResponse = {
      enabled: true,
      storePath: snap.storePath,
      modelCacheDir: snap.modelCacheDir,
      providerId: snap.stats.modelId,
      modelId: snap.stats.modelId,
      dimensions: snap.stats.dimensions,
      entries: snap.stats.entries,
      vectors: snap.stats.vectors,
      providers: snap.stats.providers,
      cache: snapshotVectorMemoryCache(store),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Vector memory status failed',
        detail: sanitizeApiError(error),
      }),
    );
  }
}

/** Parse the search params from a URL into the shape the store expects. */
function parseSearchParams(url: URL): {
  query: string;
  limit: number;
  threshold: number | undefined;
  similarity: boolean;
} {
  const query = url.searchParams.get('q') ?? '';
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 10));
  const rawThreshold = url.searchParams.get('threshold');
  const threshold =
    rawThreshold !== null && rawThreshold !== ''
      ? Math.max(0, Math.min(1, Number.parseFloat(rawThreshold)))
      : undefined;
  const similarity = url.searchParams.get('similarity') === '1';
  return { query, limit, threshold: Number.isFinite(threshold) ? threshold : undefined, similarity };
}

/**
 * Compute the pairwise cosine-similarity matrix for the given hit vectors.
 * Both inputs are expected to be `O(n·d)` where `n` is small (≤ 50 by
 * route limit) and `d` is the embedding dimension. Returns an `n×n` matrix
 * with the diagonal = 1.0. Caller is responsible for passing
 * already-decoded `Float32Array`s from the store.
 */
function cosineMatrix(vectors: ReadonlyArray<Float32Array>): number[][] {
  const n = vectors.length;
  const out: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = new Array<number>(n).fill(0);
  }
  for (let i = 0; i < n; i++) {
    out[i]![i] = 1;
    for (let j = i + 1; j < n; j++) {
      const a = vectors[i]!;
      const b = vectors[j]!;
      let dot = 0;
      const len = Math.min(a.length, b.length);
      for (let k = 0; k < len; k++) dot += (a[k] ?? 0) * (b[k] ?? 0);
      const score = Math.max(0, Math.min(1, dot));
      out[i]![j] = score;
      out[j]![i] = score;
    }
  }
  return out;
}

/** Handle `GET /api/vector-memory/search?q=…&limit=…&threshold=…`. */
export async function handleVectorMemorySearch(
  res: http.ServerResponse,
  url: URL,
  getStore: () => VectorMemoryStore | undefined,
): Promise<void> {
  const store = getStore();
  if (!store) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Vector memory not enabled in this host' }));
    return;
  }
  const { query, limit, threshold, similarity } = parseSearchParams(url);
  if (query.trim().length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required query parameter `q`' }));
    return;
  }
  try {
    const hits = await store.search(query, {
      limit,
      ...(threshold !== undefined ? { threshold } : {}),
      includeVectors: similarity,
    });
    const body: VectorMemorySearchResponse = {
      hits: hits.map((h: VectorSearchHit) => ({
        id: h.entry.id,
        score: h.score,
        text: h.entry.text,
        ...(h.entry.summary ? { summary: h.entry.summary } : {}),
        tags: h.entry.tags,
      })),
      count: hits.length,
    };
    // Optional pairwise-similarity matrix for the WebUI heatmap. Only
    // computed when the client opts in via `?similarity=1`. O(n·d) cost
    // is small (n ≤ 50) but skipped by default to keep the route lean.
    if (similarity && hits.length > 1) {
      const vecs = hits
        .map((h: VectorSearchHit) => h.vector)
        .filter((v): v is Float32Array => v !== undefined);
      if (vecs.length === hits.length) {
        body.similarity = cosineMatrix(vecs);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Vector memory search failed',
        detail: sanitizeApiError(error),
      }),
    );
  }
}

/** Parse the JSON body of a store request. Returns null on malformed input. */
function parseStoreBody(
  req: http.IncomingMessage,
): Promise<{ text?: string; tags?: string[] } | null> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as { text?: string; tags?: string[] }) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Handle `POST /api/vector-memory/store`. */
export async function handleVectorMemoryStore(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  getStore: () => VectorMemoryStore | undefined,
): Promise<void> {
  const store = getStore();
  if (!store) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Vector memory not enabled in this host' }));
    return;
  }
  const body = await parseStoreBody(req);
  if (!body) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed JSON body' }));
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required field `text`' }));
    return;
  }
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [];
  try {
    const entry = await store.remember({ text, tags });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: entry.id,
        hasVector: entry.vector !== undefined,
        dimensions: entry.dimensions,
      }),
    );
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Vector memory store failed',
        detail: sanitizeApiError(error),
      }),
    );
  }
}

/** Handle `DELETE /api/vector-memory/store/:id`. */
export async function handleVectorMemoryForget(
  res: http.ServerResponse,
  url: URL,
  getStore: () => VectorMemoryStore | undefined,
): Promise<void> {
  const store = getStore();
  if (!store) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Vector memory not enabled in this host' }));
    return;
  }
  const match = /^\/api\/vector-memory\/store\/([^/]+)$/.exec(url.pathname);
  const id = match ? strictDecodeParam(decodeSessionId(match[1]!), res) : null;
  if (id === null) return;
  try {
    const removed = await store.forget(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Vector memory forget failed',
        detail: sanitizeApiError(error),
      }),
    );
  }
}

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
        hits: hits.map((h: { memory: Sage; lexicalScore: number | null; vectorScore: number | null; finalScore: number; source: 'lexical' | 'vector' | 'both' }) => ({
          id: h.memory.id,
          text: h.memory.text,
          kind: h.memory.kind,
          status: h.memory.status,
          tags: h.memory.tags ?? [],
          lexicalScore: h.lexicalScore,
          vectorScore: h.vectorScore,
          finalScore: h.finalScore,
          source: h.source,
        })),
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
