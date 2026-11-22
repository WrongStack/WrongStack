/**
 * Phase 3: Hybrid Search Engine — vector embedding layer + RRF fusion.
 *
 * This module provides:
 *  - **Symbol embeddings**: a lightweight character n-gram TF-IDF representation
 *    of each symbol's text (name + signature + doc comment), producing a fixed
 *    384-dimensional float32 vector. No native deps (no ONNX runtime). Designed
 *    to be swapped for a real transformer embedding model in a future phase
 *    without changing the storage or fusion interface.
 *  - **Cosine similarity**: ranks symbols by vector proximity to a query vector.
 *  - **Reciprocal Rank Fusion (RRF)**: merges the ranked lists from BM25/FTS5
 *    trigram search and vector search into a single result set.
 *
 * The RRF formula (k=60, following the original Cormack et al. 2009 paper):
 *   RRF_Score(d) = 1/(k + Rank_BM25(d)) + 1/(k + Rank_Vector(d))
 * where a missing rank from either source is treated as infinity (contributes 0).
 */

/** The constant k in the RRF formula — the standard value from the literature. */
export const RRF_K = 60;

/**
 * P4.11: opt-in gate for the vector embedding layer. Default OFF.
 *
 * The 384-dim char-trigram embedding is lexical similarity — it duplicates
 * what the FTS5 trigram tokenizer already provides — while costing ~1.5 KB
 * of BLOB per symbol on every insert and an embedText() pass per symbol even
 * when the table is unavailable. With the gate off, ranking is BM25/FTS-only
 * (identical result set; the vector layer only re-ordered FTS candidates).
 * Set WRONGSTACK_INDEX_VECTORS=1 to restore the hybrid RRF path; a force
 * reindex repopulates the table for pre-existing symbols.
 */
export function vectorEmbeddingEnabled(): boolean {
  return process.env['WRONGSTACK_INDEX_VECTORS'] === '1';
}

/** Fixed vector dimensionality. 384 matches the proposal's spec. */
export const VECTOR_DIMENSIONS = 384;

/**
 * Character n-grams used for the TF-IDF embedding.
 * We use trigrams (3-char sliding windows), matching the FTS5 tokenizer choice.
 * The hash trick projects each trigram to one of VECTOR_DIMENSIONS buckets,
 * keeping the vector fixed-size regardless of vocabulary size.
 */
const NGRAM_SIZE = 3;

const SEMANTIC_CONCEPT_MAP: Readonly<Record<string, string>> = {
  pay: '$concept:pay',
  payment: '$concept:pay',
  payments: '$concept:pay',
  billing: '$concept:pay',
  charge: '$concept:pay',
  invoice: '$concept:pay',
  stripe: '$concept:pay',
  checkout: '$concept:pay',
  auth: '$concept:auth',
  authenticate: '$concept:auth',
  authentication: '$concept:auth',
  authorize: '$concept:auth',
  authorization: '$concept:auth',
  login: '$concept:auth',
  session: '$concept:auth',
  token: '$concept:auth',
  jwt: '$concept:auth',
  credential: '$concept:auth',
  credentials: '$concept:auth',
  permission: '$concept:auth',
  permissions: '$concept:auth',
  valid: '$concept:valid',
  validate: '$concept:valid',
  validation: '$concept:valid',
  validator: '$concept:valid',
  verify: '$concept:valid',
  verification: '$concept:valid',
  check: '$concept:valid',
  assert: '$concept:valid',
  db: '$concept:store',
  database: '$concept:store',
  sqlite: '$concept:store',
  postgres: '$concept:store',
  sql: '$concept:store',
  persist: '$concept:store',
  persistence: '$concept:store',
  storage: '$concept:store',
  repository: '$concept:store',
  store: '$concept:store',
  http: '$concept:http',
  route: '$concept:http',
  router: '$concept:http',
  endpoint: '$concept:http',
  request: '$concept:http',
  response: '$concept:http',
  handler: '$concept:http',
  controller: '$concept:http',
  err: '$concept:err',
  error: '$concept:err',
  errors: '$concept:err',
  exception: '$concept:err',
  failure: '$concept:err',
  fault: '$concept:err',
  fallback: '$concept:err',
  recover: '$concept:err',
  retry: '$concept:err',
  cache: '$concept:cache',
  cached: '$concept:cache',
  caching: '$concept:cache',
  memoize: '$concept:cache',
  invalidate: '$concept:cache',
  ttl: '$concept:cache',
  queue: '$concept:job',
  worker: '$concept:job',
  cron: '$concept:job',
  schedule: '$concept:job',
  scheduler: '$concept:job',
  job: '$concept:job',
  task: '$concept:job',
  parse: '$concept:parse',
  parser: '$concept:parse',
  ast: '$concept:parse',
  lexer: '$concept:parse',
  tokenize: '$concept:parse',
  tokenizer: '$concept:parse',
  graph: '$concept:graph',
  node: '$concept:graph',
  edge: '$concept:graph',
  cluster: '$concept:graph',
  community: '$concept:graph',
  louvain: '$concept:graph',
  pagerank: '$concept:graph',
};

function stemToken(word: string): string {
  if (word.length <= 4) return word;
  return word
    .replace(/(?:ation|ition|ment|ness|able|ible|ance|ence)$/, '')
    .replace(/(?:ing|ers|ies|ied|ate|ize|ise|ify|ous|ive|ors|or|er|ed|es|s)$/, '');
}

/**
 * Extract identifier sub-words (camelCase / PascalCase / snake_case), stems,
 * and domain concept tags from code or natural-language queries.
 */
export function extractSemanticFeatures(text: string): Array<{ feature: string; weight: number }> {
  const splitCamel = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  const words = splitCamel.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const features: Array<{ feature: string; weight: number }> = [];
  for (const word of words) {
    features.push({ feature: `$word:${word}`, weight: 1.5 });
    const stem = stemToken(word);
    if (stem.length >= 3 && stem !== word) {
      features.push({ feature: `$stem:${stem}`, weight: 1.5 });
    }
    const concept = SEMANTIC_CONCEPT_MAP[word] ?? SEMANTIC_CONCEPT_MAP[stem];
    if (concept) {
      features.push({ feature: concept, weight: 3.0 });
    }
  }
  return features;
}

/**
 * Compute a fixed-dimensional embedding of a text string using character
 * n-gram hashing combined with CamelCase/snake_case identifier sub-word
 * stemming and domain semantic concept projection.
 *
 * Each feature is hashed to a bucket in [0, VECTOR_DIMENSIONS) and L2-normalized
 * so cosine similarity reduces to a dot product.
 */
export function embedText(text: string): Float32Array {
  const vec = new Float32Array(VECTOR_DIMENSIONS);

  const normalized = text.toLowerCase().trim();
  if (normalized.length === 0) return vec;

  const target =
    normalized.length < NGRAM_SIZE
      ? ` ${normalized} `.slice(0, Math.max(NGRAM_SIZE, normalized.length + 2))
      : normalized;

  for (let i = 0; i <= target.length - NGRAM_SIZE; i++) {
    const ngram = target.slice(i, i + NGRAM_SIZE);
    const bucket = hashNgram(ngram) % VECTOR_DIMENSIONS;
    vec[bucket]! += 1;
  }

  for (const { feature, weight } of extractSemanticFeatures(text)) {
    const bucket = hashNgram(feature) % VECTOR_DIMENSIONS;
    vec[bucket]! += weight;
  }

  // L2-normalize so dot product = cosine similarity.
  let norm = 0;
  for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
    norm += vec[i]! * vec[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
      vec[i]! /= norm;
    }
  }

  return vec;
}

/**
 * FNV-1a hash for n-grams. Fast, good distribution for short strings,
 * no dependencies. 32-bit output gives even distribution across 384 buckets.
 */
function hashNgram(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // unsigned 32-bit
}

/** Cosine similarity between two L2-normalized vectors (reduces to dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/** Serialize a Float32Array to a Buffer for SQLite BLOB storage. */
export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Deserialize a BLOB from SQLite back to a Float32Array. */
export function decodeVector(buf: Buffer | Uint8Array): Float32Array {
  // node:sqlite returns Uint8Array for BLOB columns, not Buffer. Buffer methods
  // like readFloatLE only exist on Buffer instances. Fast typed array copy
  // performs byte-level transfer without thousands of JS float decodes.
  if (buf.byteLength === 0) return new Float32Array(0);
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `decodeVector: invalid vector byteLength ${buf.byteLength} (must be a multiple of 4)`,
    );
  }
  const copy = new Float32Array(buf.byteLength / 4);
  new Uint8Array(copy.buffer).set(buf);
  return copy;
}

/**
 * Rank map: symbolId → rank (0-based). Lower rank = more relevant.
 * Built from a search result list (already sorted by relevance).
 */
type RankMap = Map<number, number>;

/** Build a RankMap from a sorted result list. */
export function buildRankMap(sortedIds: number[]): RankMap {
  const map = new Map<number, number>();
  for (let i = 0; i < sortedIds.length; i++) {
    map.set(sortedIds[i]!, i);
  }
  return map;
}

/**
 * Reciprocal Rank Fusion — merge two ranked lists into a single fused ranking.
 *
 * Each symbol's RRF score is the sum of 1/(k + rank) from each source.
 * Symbols only in one list still contribute 1/(k + rank) from that source.
 * Symbols in neither list are absent from the output.
 *
 * @param bm25Ranks - rank map from BM25/FTS5 trigram search
 * @param vectorRanks - rank map from vector similarity search
 * @param k - the RRF constant (default 60, per Cormack et al.)
 * @returns sorted [symbolId, rrfScore] pairs, descending by score
 */
export function reciprocalRankFusion(
  bm25Ranks: RankMap,
  vectorRanks: RankMap,
  k: number = RRF_K,
): Array<[number, number]> {
  const safeK = typeof k === 'number' && Number.isFinite(k) && k > 0 ? k : RRF_K;
  const allIds = new Set<number>([...bm25Ranks.keys(), ...vectorRanks.keys()]);
  const scored: Array<[number, number]> = [];

  for (const id of allIds) {
    const bm25Rank = bm25Ranks.get(id);
    const vecRank = vectorRanks.get(id);

    let score = 0;
    if (bm25Rank !== undefined) score += 1 / (safeK + bm25Rank);
    if (vecRank !== undefined) score += 1 / (safeK + vecRank);

    scored.push([id, score]);
  }

  // Sort descending by fused score.
  scored.sort((a, b) => b[1] - a[1]);
  return scored;
}
