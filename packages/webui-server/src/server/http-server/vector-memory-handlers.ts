/**
 * Vector memory HTTP handlers — minimal visibility surface for the
 * WebUI/SimpleUI. Exposes the active store/provider, the model cache
 * location, entry counts, and a search endpoint. Strictly opt-in:
 * `getVectorMemoryStore` defaults to undefined so non-CLI webui-server
 * hosts (e.g. a headless fleet dashboard) are unaffected.
 */
import type * as http from 'node:http';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';

import { sanitizeApiError } from '@wrongstack/core/security';
import { decodeSessionId, strictDecodeParam } from './security-helpers.js';

export interface VectorMemoryStatusResponse {
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

export interface VectorMemorySearchHit {
  id: string;
  score: number;
  text: string;
  summary?: string | undefined;
  tags: string[];
}

export interface VectorMemorySearchResponse {
  hits: VectorMemorySearchHit[];
  count: number;
}

/** Shape the store exposes. Kept narrow so we don't leak the full class. */
export interface VectorMemorySnapshot {
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
export function snapshotVectorMemory(
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
} {
  const query = url.searchParams.get('q') ?? '';
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 10));
  const rawThreshold = url.searchParams.get('threshold');
  const threshold =
    rawThreshold !== null && rawThreshold !== ''
      ? Math.max(0, Math.min(1, Number.parseFloat(rawThreshold)))
      : undefined;
  return { query, limit, threshold: Number.isFinite(threshold) ? threshold : undefined };
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
  const { query, limit, threshold } = parseSearchParams(url);
  if (query.trim().length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required query parameter `q`' }));
    return;
  }
  try {
    const hits = await store.search(query, {
      limit,
      ...(threshold !== undefined ? { threshold } : {}),
    });
    const body: VectorMemorySearchResponse = {
      hits: hits.map((h) => ({
        id: h.entry.id,
        score: h.score,
        text: h.entry.text,
        ...(h.entry.summary ? { summary: h.entry.summary } : {}),
        tags: h.entry.tags,
      })),
      count: hits.length,
    };
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
    const removed = store.forget(id);
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
