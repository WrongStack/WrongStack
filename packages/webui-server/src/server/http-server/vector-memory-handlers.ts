/**
 * Vector memory HTTP handlers — minimal visibility surface for the
 * WebUI. Exposes the active store/provider, the model cache
 * location, entry counts, and a search endpoint. Strictly opt-in:
 * `getVectorMemoryStore` defaults to undefined so non-CLI webui-server
 * hosts (e.g. a headless fleet dashboard) are unaffected.
 */
import { createHash } from 'node:crypto';
import type * as http from 'node:http';
import { sanitizeApiError } from '@wrongstack/core/security';

import { cosineSimilarity, type Sage } from '@wrongstack/sage';
import {
  VectorMemoryProviderUnavailableError,
  type VectorMemoryStore,
  type VectorSearchHit,
} from '@wrongstack/vector-memory';
import { decodeSessionId } from './security-helpers.js';

export { handleMemorySearch } from './memory-search-handler.js';

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
  cache?:
    | {
        entries: number;
        providers: number;
        totalUseCount: number;
        oldestLastUsedAt: string | null;
      }
    | undefined;
  /** Entries with a vector usable by the active provider and dimensions. */
  coverage?: { entries: number; covered: number; missing: number } | undefined;
}

interface VectorMemorySearchHit {
  id: string;
  score: number;
  text: string;
  summary?: string | undefined;
  tags: string[];
  /** Scope of the matched vector entry (this route only serves `project`). */
  scope?: string | undefined;
  /** Kind of the matched vector entry (`note`/`fact`/`summary`/…). */
  kind?: string | undefined;
  /** Present only when SAGE visibility, ID and text match this mirror. */
  sage?: { id: string; status: 'verified' } | undefined;
}

export interface VectorMemorySearchResponse {
  hits: VectorMemorySearchHit[];
  count: number;
  /**
   * Opaque rank cursor to pass back as `?cursor=` for the next page.
   * Emitted only when the store returned a full page (there may be more);
   * `null` when the page was short (the ranked result set is exhausted
   * for these filters). This is a rank-position token over
   * score DESC / id ASC — NOT a snapshot: entries written between calls
   * can appear on later pages.
   */
  nextCursor: string | null;
  /**
   * Pairwise cosine similarity matrix between returned hits, in hit order.
   * Cell [i][j] is the similarity between hits[i] and hits[j]. Optional —
   * the route only computes it when `?similarity=1` is set, to keep the
   * default response cheap. Used by the WebUI's heatmap view to surface
   * whether the top-K results form coherent clusters.
   */
  similarity?: number[][] | undefined;
}

/**
 * Optional extensions for `handleVectorMemorySearch`. Appended after the
 * legacy `(res, url, getStore)` parameters so existing call sites keep
 * working unchanged.
 */
export interface HandleVectorMemorySearchOptions {
  /**
   * Visibility-checked SAGE resolver used to validate mirror provenance.
   * Given a `metadata.sageId`, returns the SAGE memory when it exists AND
   * passes the caller's visibility rules (e.g. `isSageVisibleForSearch`
   * over a `getSage` lookup), and `undefined` when it does not.
   *
   * Contract per hit: resolved memory → hit carries
   * `sage.status: 'verified'`; `undefined` → the mirror is stale/hidden
   * and the hit is DROPPED (the raw vector route must not bypass SAGE
   * visibility); thrown → `'unknown'` and the hit is DROPPED as well
   * (fail-closed: unverified mirror text never crosses this route).
   *
   * When omitted, every mirrored hit is DROPPED — unverified linkage
   * is never served by the raw vector route.
   */
  resolveSageMirror?:
    | ((sageId: string) => Promise<Sage | undefined> | Sage | undefined)
    | undefined;
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
      coverage: store.embeddingCoverage(),
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

/** Query params `handleVectorMemorySearch` accepts. Anything else is rejected. */
const VECTOR_SEARCH_SUPPORTED_PARAMS = [
  'q',
  'limit',
  'threshold',
  'similarity',
  'scope',
  'kind',
  'cursor',
] as const;

/** Kinds the vector store can filter on server-side (whole corpus). */
const VECTOR_SEARCH_KINDS = ['note', 'fact', 'summary', 'snippet', 'link'] as const;

/** Bind a cursor to the query and all filters that affect ranking. */
function rankQueryKey(
  query: string,
  threshold: number | undefined,
  kind: string | undefined,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        query.trim().normalize('NFKC'),
        threshold ?? null,
        'project',
        kind ?? null,
        1,
      ]),
    )
    .digest('hex');
}

/** Encode the rank position and query fingerprint; this is not a snapshot. */
function encodeRankCursor(cursor: { score: number; id: string }, key: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: key, s: cursor.score, i: cursor.id })).toString(
    'base64url',
  );
}

/** Invalid or mismatched cursors fail rather than restarting at page one. */
function decodeRankCursor(raw: string, key: string): { score: number; id: string } | null {
  if (raw.length > 2048) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      parsed.v !== 1 ||
      parsed.k !== key ||
      typeof parsed.s !== 'number' ||
      !Number.isFinite(parsed.s) ||
      parsed.s < 0 ||
      parsed.s > 1 ||
      typeof parsed.i !== 'string' ||
      parsed.i.length === 0 ||
      parsed.i.length > 256
    )
      return null;
    return { score: parsed.s, id: parsed.i };
  } catch {
    return null;
  }
}

interface VectorSearchParams {
  query: string;
  limit: number;
  threshold: number | undefined;
  similarity: boolean;
  /** Always `project` today — user/session are excluded until a policy exists. */
  scope: 'project';
  kind: (typeof VECTOR_SEARCH_KINDS)[number] | undefined;
  cursor: { score: number; id: string } | undefined;
  cursorKey: string;
}

/**
 * Parse and validate the search params from a URL into the shape the
 * store expects. The parameter set is bounded: unknown parameters (e.g.
 * SAGE `status`/`audience`, which the vector store cannot enforce
 * server-side) are rejected with 400 instead of silently ignored or
 * post-filtered — an ignored filter looks identical to an empty corpus.
 */
function parseSearchParams(url: URL): VectorSearchParams | { error: string; param: string } {
  for (const key of url.searchParams.keys()) {
    if (!(VECTOR_SEARCH_SUPPORTED_PARAMS as readonly string[]).includes(key)) {
      return {
        error: `Unsupported filter parameter \`${key}\` (supported: ${VECTOR_SEARCH_SUPPORTED_PARAMS.join(', ')})`,
        param: key,
      };
    }
  }
  const query = url.searchParams.get('q') ?? '';
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 10));
  const rawThreshold = url.searchParams.get('threshold');
  const threshold =
    rawThreshold !== null && rawThreshold !== ''
      ? Math.max(0, Math.min(1, Number.parseFloat(rawThreshold)))
      : undefined;
  const similarity = url.searchParams.get('similarity') === '1';

  // Scope policy (B0): the raw vector route serves the shared,
  // project-scoped store only. `user` and `session` entries are excluded
  // until a caller-specific scope policy exists — this route has no
  // session identity, so serving those scopes would leak other contexts'
  // private text. The default AND the only accepted value is `project`.
  const rawScope = url.searchParams.get('scope');
  if (rawScope !== null && rawScope !== 'project') {
    return {
      error: `Scope \`${rawScope}\` is not available on this route (default and only supported scope is \`project\`; user/session entries are excluded until a caller-specific scope policy is defined)`,
      param: 'scope',
    };
  }

  const rawKind = url.searchParams.get('kind');
  if (rawKind !== null && !(VECTOR_SEARCH_KINDS as readonly string[]).includes(rawKind)) {
    return {
      error: `Invalid \`kind\` (supported: ${VECTOR_SEARCH_KINDS.join(', ')})`,
      param: 'kind',
    };
  }

  const key = rankQueryKey(
    query,
    Number.isFinite(threshold) ? threshold : undefined,
    rawKind ?? undefined,
  );
  const rawCursor = url.searchParams.get('cursor');
  let cursor: { score: number; id: string } | undefined;
  if (rawCursor !== null && rawCursor !== '') {
    const decoded = decodeRankCursor(rawCursor, key);
    if (!decoded) {
      return {
        error: 'Malformed `cursor` (expected the opaque token from a prior `nextCursor`)',
        param: 'cursor',
      };
    }
    cursor = decoded;
  }

  return {
    query,
    limit,
    threshold: Number.isFinite(threshold) ? threshold : undefined,
    similarity,
    scope: 'project',
    kind: rawKind === null ? undefined : (rawKind as VectorSearchParams['kind']),
    cursor,
    cursorKey: key,
  };
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
      // A bare dot product is only cosine similarity when both vectors are
      // unit-length; the EmbeddingProvider contract does not require that.
      // Reuse the canonical implementation (zero-vector and dimension-safe)
      // and clamp to the store's [0, 1] convention.
      const score = Math.max(0, Math.min(1, cosineSimilarity(vectors[i]!, vectors[j]!)));
      out[i]![j] = score;
      out[j]![i] = score;
    }
  }
  return out;
}

/**
 * Resolve a batch of SAGE mirror ids through the visibility-checked
 * resolver. Never throws: a resolver failure degrades that one id to
 * `'unknown'` (which the search guard drops — fail-closed) rather than
 * failing the whole route.
 */
async function resolveSageMirrors(
  resolver: NonNullable<HandleVectorMemorySearchOptions['resolveSageMirror']>,
  sageIds: readonly string[],
): Promise<Map<string, Sage | undefined>> {
  const outcomes = new Map<string, Sage | undefined>();
  await Promise.all(
    [...new Set(sageIds)].map(async (id) => {
      try {
        outcomes.set(id, await resolver(id));
      } catch {
        outcomes.set(id, undefined);
      }
    }),
  );
  return outcomes;
}

/** Handle `GET /api/vector-memory/search?q=…&limit=…&threshold=…&scope=…&kind=…&cursor=…`. */
export async function handleVectorMemorySearch(
  res: http.ServerResponse,
  url: URL,
  getStore: () => VectorMemoryStore | undefined,
  opts: HandleVectorMemorySearchOptions = {},
): Promise<void> {
  const store = getStore();
  if (!store) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Vector memory not enabled in this host' }));
    return;
  }
  const parsed = parseSearchParams(url);
  if ('error' in parsed) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: parsed.error, param: parsed.param }));
    return;
  }
  const { query, limit, threshold, similarity, scope, kind, cursor, cursorKey } = parsed;
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
      // Server-side whole-corpus filters — never post-filtered.
      scope,
      ...(kind !== undefined ? { kind } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      // Typed embedding failure: a provider outage must surface as 503,
      // not as an empty result page indistinguishable from "no matches".
      failOnEmbeddingError: true,
    });

    // A mirrored SAGE entry must be visibility-checked before disclosing
    // its text; vector metadata alone cannot authorize this response.
    const resolver = opts.resolveSageMirror;
    const sageIdOf = (h: VectorSearchHit): string | undefined => {
      const raw = h.entry.metadata?.sageId;
      return h.entry.metadata?.source === 'sage' && typeof raw === 'string' && raw.length > 0
        ? raw
        : undefined;
    };
    const allSageIds = hits.map(sageIdOf).filter((id): id is string => id !== undefined);
    const outcomes =
      resolver && allSageIds.length > 0
        ? await resolveSageMirrors(resolver, allSageIds)
        : undefined;

    const body: VectorMemorySearchResponse = {
      hits: [],
      count: 0,
      nextCursor: null,
    };
    const emittedVectors: Array<Float32Array | undefined> = [];
    for (const h of hits) {
      const sageId = sageIdOf(h);
      const sageMemory = sageId ? outcomes?.get(sageId) : undefined;
      // Metadata is writable by vector callers. Verify identity and current
      // content as well as visibility before claiming or disclosing a mirror.
      if (
        h.entry.metadata?.source === 'sage' &&
        (!sageMemory || sageMemory.id !== sageId || sageMemory.text !== h.entry.text)
      )
        continue;
      body.hits.push({
        id: h.entry.id,
        score: h.score,
        text: h.entry.text,
        ...(h.entry.summary ? { summary: h.entry.summary } : {}),
        tags: h.entry.tags,
        scope: h.entry.scope,
        kind: h.entry.kind,
        ...(sageId
          ? {
              sage: {
                id: sageId,
                status: 'verified',
              },
            }
          : {}),
      });
      emittedVectors.push(h.vector);
    }
    body.count = body.hits.length;

    // Rank cursor for the next page. Computed from the LAST STORE HIT
    // (even when it was dropped above) whenever the store returned a full
    // page — the token is a rank position, so resuming after a dropped
    // hit is correct and always advances. A short store page means the
    // ranked result set is exhausted for these filters → null.
    if (hits.length >= limit && hits.length > 0) {
      const tail = hits[hits.length - 1]!;
      body.nextCursor = encodeRankCursor({ score: tail.score, id: tail.entry.id }, cursorKey);
    }

    // Optional pairwise-similarity matrix for the WebUI heatmap. Only
    // computed when the client opts in via `?similarity=1`. O(n·d) cost
    // is small (n ≤ 50) but skipped by default to keep the route lean.
    if (similarity && body.hits.length > 1) {
      const vecs = emittedVectors.filter((v): v is Float32Array => v !== undefined);
      if (vecs.length === body.hits.length) {
        body.similarity = cosineMatrix(vecs);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch (error) {
    if (error instanceof VectorMemoryProviderUnavailableError) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Vector memory embedding provider unavailable',
          code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
          detail: sanitizeApiError(error),
        }),
      );
      return;
    }
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
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string')
    : [];
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

/**
 * Handle `POST /api/vector-memory/reindex` `{ onlyMissing?: boolean }`. Re-embeds entries with
 * the active provider (all of them, or only those without a usable vector) and answers the
 * counts with the coverage afterwards. Per-entry provider failures are counted, not thrown.
 */
export async function handleVectorMemoryReindex(
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
  const body = (await parseStoreBody(req)) as { onlyMissing?: unknown } | null;
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    (body.onlyMissing !== undefined && typeof body.onlyMissing !== 'boolean')
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Send `{ onlyMissing?: boolean }`' }));
    return;
  }
  try {
    const result = await store.reindexAll({ onlyMissing: body.onlyMissing === true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...result, coverage: store.embeddingCoverage() }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Vector memory reindex failed',
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
  // This used to be `strictDecodeParam(decodeSessionId(...))` — two decodes of
  // the same value. Decoding twice is a traversal bypass in its own right:
  // `%252e%252e%252f` survives the first pass as `%2e%2e%2f` and becomes `../`
  // on the second, so any check between the two sees a harmless string. One
  // decode, then validate.
  const id = match ? decodeSessionId(match[1]!) : null;
  if (id === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid store id' }));
    return;
  }
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
