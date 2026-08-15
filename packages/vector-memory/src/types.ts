/**
 * Vector Memory — public type surface.
 *
 * The store persists entries (text + metadata) alongside their vector
 * embeddings, keyed by provider id so a model change triggers re-indexing.
 */
import type { EmbeddingProvider } from '@wrongstack/sage';

export type VectorScope = 'project' | 'user' | 'session';
export type VectorKind = 'note' | 'fact' | 'summary' | 'snippet' | 'link';

export interface VectorEntryInput {
  text: string;
  /** Optional short label — stored as-is, returned in search results. */
  summary?: string | undefined;
  /** Free-form metadata persisted as JSON. Use for source URLs, anchors, etc. */
  metadata?: Record<string, unknown> | undefined;
  tags?: string[] | undefined;
  scope?: VectorScope | undefined;
  kind?: VectorKind | undefined;
  /** Embedding provider id override for this write. Defaults to the store's provider. */
  providerId?: string | undefined;
}

export interface VectorEntry {
  id: string;
  text: string;
  summary?: string | undefined;
  metadata: Record<string, unknown>;
  tags: string[];
  scope: VectorScope;
  kind: VectorKind;
  /** Stable hash of the entry text — used to detect duplicate re-writes. */
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface VectorEntryWithVector extends VectorEntry {
  /** Provider id that produced the stored vector. */
  providerId: string;
  /** Vector dimensions (matches `EmbeddingProvider.dimensions`). */
  dimensions: number;
  /** Decoded vector; absent when no embedding has been computed yet. */
  vector?: Float32Array | undefined;
}

export interface VectorSearchOptions {
  limit?: number | undefined;
  /** Minimum cosine similarity [0, 1]. Results below the floor are dropped. */
  threshold?: number | undefined;
  scope?: VectorScope | undefined;
  kind?: VectorKind | undefined;
  /** Provider id override for the query embedding. Defaults to the store's provider. */
  providerId?: string | undefined;
  /**
   * When true, each returned hit also carries the decoded embedding
   * vector. Off by default to keep the response small. Used by the
   * webui-server's `/api/vector-memory/search?similarity=1` route to
   * build the pairwise-similarity heatmap.
   */
  includeVectors?: boolean | undefined;
}

export interface VectorSearchHit {
  entry: VectorEntry;
  /** Cosine similarity in [-1, 1]. The store clamps to [0, 1] before returning. */
  score: number;
  providerId: string;
  /**
   * Decoded embedding vector for the matched entry. Populated only when
   * the caller passes `includeVectors: true` to `store.search()` — keeps
   * the default response small. Useful for downstream consumers that
   * need pairwise similarity (e.g. WebUI heatmap) without a second
   * `get(id)` round-trip.
   */
  vector?: Float32Array | undefined;
}

export interface VectorStoreStats {
  entries: number;
  vectors: number;
  providers: string[];
  modelAvailable: boolean;
  modelId: string;
  dimensions: number;
}

/**
 * The store accepts any `EmbeddingProvider` from `@wrongstack/sage`. In
 * production the caller wires a `TransformersEmbeddingProvider`; tests and
 * offline runs can substitute a `HashingEmbeddingProvider` or a fake.
 */
export interface VectorMemoryStoreOptions {
  /** Embedding provider used for both write-side and query-side embedding. */
  provider: EmbeddingProvider;
  /** Absolute project root whose `.wrongstack/vector-memory/` directory owns the SQLite db. */
  projectRoot: string;
  /** Override the storage subdirectory (default `.wrongstack/vector-memory`). */
  directory?: string;
  /** Override the SQLite file name (default `vector-memory.db`). */
  filename?: string;
}

/**
 * Returned by `syncFromSage` — surfaces what was indexed, what was skipped,
 * and any failures so the caller can log or retry.
 */
export interface SageSyncReport {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  errors: Array<{ memoryId: string; message: string }>;
}
