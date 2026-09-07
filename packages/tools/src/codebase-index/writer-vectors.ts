/**
 * Persistence for file-level semantic embeddings (`file_vectors`).
 *
 * Vectors from two different models are not comparable — the spaces have
 * nothing to do with each other — so the provider id is stored alongside every
 * row and a provider change wipes the table rather than silently mixing them.
 */

import type { DatabaseSync } from 'node:sqlite';
import { decodeVector, encodeVector } from './vector-search.js';
import { ladderChunkSizes } from './writer-helpers.js';

type Statement = ReturnType<DatabaseSync['prepare']>;
type PrepareStatement = (sql: string) => Statement;

/** Metadata key recording which provider produced the stored vectors. */
export const FILE_VECTOR_PROVIDER_KEY = 'file_vector_provider';

export interface FileVectorRow {
  file: string;
  vector: Float32Array;
  /** Hash of the exact text that was embedded. */
  sourceHash: string;
  provider: string;
}

/** What is already embedded, so a pass can skip unchanged text. */
export interface FileVectorState {
  file: string;
  sourceHash: string;
}

export function getFileVectorStatesWithStatement(
  stmt: PrepareStatement,
  provider: string,
): Map<string, string> {
  const rows = stmt(
    'SELECT file, source_hash AS sourceHash FROM file_vectors WHERE provider = ?',
  ).all(provider) as unknown as FileVectorState[];
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.file, row.sourceHash);
  return map;
}

export function upsertFileVectorsWithStatement(
  stmt: PrepareStatement,
  maxSqlVars: number,
  rows: readonly FileVectorRow[],
): void {
  if (rows.length === 0) return;
  const ladder = ladderChunkSizes(rows.length, Math.max(1, Math.floor(maxSqlVars / 4)));
  let cursor = 0;
  for (const take of ladder) {
    const chunk = rows.slice(cursor, cursor + take);
    cursor += take;
    const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
    stmt(
      `INSERT INTO file_vectors(file, vector, source_hash, provider) VALUES ${placeholders}
       ON CONFLICT(file) DO UPDATE SET
         vector = excluded.vector,
         source_hash = excluded.source_hash,
         provider = excluded.provider`,
    ).run(
      ...chunk.flatMap((row) => [row.file, encodeVector(row.vector), row.sourceHash, row.provider]),
    );
  }
}

/**
 * Drop every stored vector when the provider changes.
 *
 * Returns true when a wipe happened, so the caller can report that the next
 * pass is a full re-embed rather than an incremental one.
 */
export function reconcileVectorProviderWithStatement(
  stmt: PrepareStatement,
  getMetadata: (key: string) => string | undefined,
  setMetadata: (key: string, value: string) => void,
  provider: string,
): boolean {
  const stored = getMetadata(FILE_VECTOR_PROVIDER_KEY);
  if (stored === provider) return false;
  stmt('DELETE FROM file_vectors').run();
  setMetadata(FILE_VECTOR_PROVIDER_KEY, provider);
  return stored !== undefined;
}

/** Vectors dropped for files no longer indexed. */
export function pruneOrphanFileVectorsWithStatement(stmt: PrepareStatement): number {
  const result = stmt('DELETE FROM file_vectors WHERE file NOT IN (SELECT file FROM files)').run();
  return Number(result.changes ?? 0);
}

export function countFileVectorsWithStatement(stmt: PrepareStatement): number {
  return Number(
    (stmt('SELECT COUNT(*) AS n FROM file_vectors').get() as { n?: number } | undefined)?.n ?? 0,
  );
}

export interface VectorHit {
  file: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
}

/**
 * Rank every stored vector against `query` and return the closest files.
 *
 * A brute-force scan, deliberately: at file granularity this repository has
 * roughly eight thousand vectors of 384 floats, which is about twelve
 * megabytes and a few milliseconds to sweep. An approximate-nearest-neighbour
 * index would add a dependency and an accuracy cliff to save time nobody is
 * waiting on.
 */
export function searchFileVectorsWithStatement(
  stmt: PrepareStatement,
  query: Float32Array,
  limit: number,
  minScore: number,
): VectorHit[] {
  if (limit <= 0 || query.length === 0) return [];
  const rows = stmt('SELECT file, vector FROM file_vectors').all() as Array<{
    file: string;
    vector: Uint8Array;
  }>;

  const hits: VectorHit[] = [];
  for (const row of rows) {
    let vector: Float32Array;
    try {
      vector = decodeVector(row.vector);
    } catch {
      // A corrupt blob costs one file its semantic hit, not the whole query.
      continue;
    }
    if (vector.length !== query.length) continue;
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += (query[i] as number) * (vector[i] as number);
    if (dot >= minScore) hits.push({ file: row.file, score: dot });
  }

  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return hits.slice(0, limit);
}
