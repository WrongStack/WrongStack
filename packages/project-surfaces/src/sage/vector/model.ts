import { surfaceFetch } from '../../host';

/**
 * Vector Memory panel — minimal visibility surface for the WebUI.
 *
 * Fetches `/api/vector-memory/status` and `/api/vector-memory/search` to
 * show the active store/provider, model cache location, entry counts, and
 * a search UI with ranked results. When the route is disabled (the
 * webui-server host doesn't wire a vector store), the panel renders a
 * disabled placeholder.
 */

interface VectorMemoryCacheStats {
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

/** SAGE provenance for a mirrored hit — only ever `verified`. */
export interface VectorMemorySageProvenance {
  id: string;
  status: 'verified';
}

export interface VectorMemoryHit {
  id: string;
  score: number;
  text: string;
  summary?: string | undefined;
  tags: string[];
  /** Scope of the matched vector entry (this route only serves `project`). */
  scope?: string | undefined;
  /** Kind of the matched vector entry (`note`/`fact`/`summary`/…). */
  kind?: string | undefined;
  /**
   * Present only when the server resolved this hit's `metadata.sageId`
   * against a visible, text-matching SAGE memory (`status: 'verified'`).
   * Absent = plain vector entry with no SAGE linkage.
   */
  sage?: VectorMemorySageProvenance | undefined;
}

export interface VectorMemorySearchResponse {
  hits: VectorMemoryHit[];
  count: number;
  /**
   * Opaque rank cursor for the next page — pass back as `?cursor=` to
   * append. `null` when the ranked result set is exhausted for the
   * current query/threshold/kind. Not a snapshot: entries written between
   * calls can appear on later pages.
   */
  nextCursor: string | null;
  /**
   * Pairwise cosine similarity matrix between hits (in hit order). Only
   * populated when the client opts in via `similarity: true`. Used by the
   * heatmap view to surface whether the top-K results form coherent
   * clusters.
   */
  similarity?: number[][] | undefined;
}

/** Fetch the current vector-memory status from the webui-server. */
export async function fetchVectorMemoryStatus(baseUrl = ''): Promise<VectorMemoryStatus> {
  const response = await surfaceFetch(`${baseUrl}/api/vector-memory/status`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`status failed: HTTP ${response.status}`);
  }
  return (await response.json()) as VectorMemoryStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Non-empty string or nothing — optional text fields degrade to absent. */
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** String-array tags, or nothing — never poisons the chip row. */
function parseTags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

/**
 * Parse + validate one search hit from the route's JSON. Required fields
 * (id/score/text) must be present and well-typed; optional provenance
 * fields degrade to absent instead of poisoning the render path.
 */
function parseHit(value: unknown): VectorMemoryHit {
  if (!isRecord(value)) throw new Error('search failed: malformed hit');
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('search failed: malformed hit id');
  }
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    throw new Error('search failed: malformed hit score');
  }
  if (typeof value.text !== 'string') throw new Error('search failed: malformed hit text');
  const summary = optionalText(value.summary);
  const scope = optionalText(value.scope);
  const kind = optionalText(value.kind);
  const sageId = isRecord(value.sage) ? optionalText(value.sage.id) : undefined;
  const sageVerified = isRecord(value.sage) && value.sage.status === 'verified';
  const sage =
    sageId !== undefined && sageVerified ? { id: sageId, status: 'verified' as const } : undefined;
  return {
    id: value.id,
    score: value.score,
    text: value.text,
    ...(summary !== undefined ? { summary } : {}),
    tags: parseTags(value.tags),
    ...(scope !== undefined ? { scope } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(sage !== undefined ? { sage } : {}),
  };
}

/** Validate the pairwise matrix shape, or degrade to "no heatmap". */
function parseSimilarity(value: unknown): number[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: number[][] = [];
  for (const row of value) {
    if (!Array.isArray(row)) return undefined;
    if (row.some((cell) => typeof cell !== 'number' || !Number.isFinite(cell))) return undefined;
    rows.push(row as number[]);
  }
  return rows;
}

/**
 * Validate the search route's JSON before it crosses into component state.
 * The cursor/provenance fields drive pagination and SAGE navigation, so a
 * contract drift must fail fast with a typed message instead of surfacing
 * as `undefined` reads deep in the panel.
 */
function parseSearchResponse(body: unknown): VectorMemorySearchResponse {
  if (!isRecord(body) || !Array.isArray(body.hits)) {
    throw new Error('search failed: malformed response');
  }
  const hits = body.hits.map(parseHit);
  const nextCursor = optionalText(body.nextCursor) ?? null;
  const similarity = parseSimilarity(body.similarity);
  return {
    hits,
    count: typeof body.count === 'number' && Number.isFinite(body.count) ? body.count : hits.length,
    nextCursor,
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

/** Run a semantic search query against the vector-memory store. */
export async function searchVectorMemory(
  query: string,
  opts: {
    limit?: number;
    threshold?: number;
    similarity?: boolean;
    /** Opaque `nextCursor` from a prior page — appends the next page. */
    cursor?: string;
    baseUrl?: string;
  } = {},
): Promise<VectorMemorySearchResponse> {
  const params = new URLSearchParams();
  params.set('q', query);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.threshold !== undefined) params.set('threshold', String(opts.threshold));
  if (opts.similarity === true) params.set('similarity', '1');
  if (opts.cursor !== undefined && opts.cursor.length > 0) params.set('cursor', opts.cursor);
  const response = await surfaceFetch(
    `${opts.baseUrl ?? ''}/api/vector-memory/search?${params.toString()}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    if (isRecord(body) && body.code === 'EMBEDDING_PROVIDER_UNAVAILABLE') {
      throw new Error(
        'Vector memory embedding provider unavailable. Ensure the optional @huggingface/transformers backend is installed and the model can load, then retry.',
      );
    }
    throw new Error(`search failed: HTTP ${response.status}`);
  }
  return parseSearchResponse(await response.json());
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
  const response = await surfaceFetch(
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
