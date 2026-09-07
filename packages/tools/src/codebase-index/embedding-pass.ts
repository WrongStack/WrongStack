/**
 * The semantic embedding pass.
 *
 * Embeds one vector per file so the index can answer questions phrased in the
 * problem's vocabulary rather than the code's — "where do we back off after a
 * 429" instead of `retryAfterMsFromHeaders`.
 *
 * ## What gets embedded, and why it is the file
 *
 * A bare declaration is poor material for an embedding: `function resolve(id:
 * string): Widget` carries almost nothing a lexical index does not already
 * have, and BM25 over FTS5 already matches it better. What carries meaning is
 * the concept layer's description of what a file is *for*, so that is the text
 * this pass embeds, falling back to the file's declaration names when no
 * summary exists yet.
 *
 * That also makes it eight times cheaper than a symbol-level pass on this
 * repository — eight thousand files against sixty-six thousand symbols.
 *
 * ## Why it is a pass and not part of indexing
 *
 * Model inference is asynchronous and batched. The indexer's write path is a
 * synchronous SQLite transaction; running inference inside it would hold a
 * write lock open across thousands of inferences. The older char-trigram
 * embedding could live there precisely because it was neither of those things
 * — and it was also not semantic, which is why it is being superseded rather
 * than extended.
 *
 * ## Why the vectors never silently mix
 *
 * Two models produce incomparable spaces. The provider id is stored with every
 * row and checked before a pass; a change wipes the table and re-embeds rather
 * than leaving half the index in one space and half in another.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { xxhash64String } from './content-hash.js';
import { type IndexStore, indexStorePool } from './writer.js';
import { posixIndexPath, resolveIndexDir } from './writer-helpers.js';

/**
 * The host-supplied embedding model.
 *
 * Structurally identical to the `EmbeddingProvider` that
 * `packages/vector-memory` already defines, so its transformers-backed
 * implementation satisfies this without an adapter. Injected rather than
 * imported for the same reason the summariser is: `packages/tools` must not
 * depend on an optional native model runtime.
 */
export interface EmbeddingPort {
  /** Stable id including the model and quantisation. Changing it re-embeds. */
  readonly id: string;
  /** Vector length. Must not change for a given `id`. */
  readonly dimensions: number;
  /** Embed a batch. Must return exactly one vector per input, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Texts sent per inference call. */
export const DEFAULT_BATCH_SIZE = 16;

/** Ceiling on embedded text. Beyond this a summary is not a summary. */
export const MAX_EMBED_CHARS = 2_000;

/** Declaration names used when a file has no concept summary yet. */
const FALLBACK_DECLARATIONS = 12;

export interface EmbedOptions {
  /** Stop after this many files. */
  maxFiles?: number | undefined;
  batchSize?: number | undefined;
  /** Re-embed even when the stored text hash still matches. */
  force?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface EmbedResult {
  embedded: number;
  /** Files whose embedded text was unchanged. */
  cached: number;
  /** Vectors dropped because their file left the index. */
  pruned: number;
  /** True when a provider change forced a full re-embed. */
  providerChanged: boolean;
  /** Files with no summary, embedded from their declaration names instead. */
  fromDeclarations: number;
  durationMs: number;
  errors: string[];
}

/**
 * Build the text to embed for one file.
 *
 * The path is always included: it is real signal (`packages/core/src/types` is
 * meaningful) and it keeps two files with identical summaries from collapsing
 * onto the same vector.
 */
function embedTextFor(
  relativePath: string,
  summary: string | undefined,
  declarations: readonly string[],
): { text: string; fromDeclarations: boolean } {
  const described = summary?.trim() ?? '';
  if (described.length > 0) {
    return {
      text: `${relativePath}\n${described}`.slice(0, MAX_EMBED_CHARS),
      fromDeclarations: false,
    };
  }
  const names = declarations.slice(0, FALLBACK_DECLARATIONS).join(', ');
  return {
    text: `${relativePath}${names.length > 0 ? `\n${names}` : ''}`.slice(0, MAX_EMBED_CHARS),
    fromDeclarations: true,
  };
}

/**
 * Run one embedding pass. Never throws: an inference failure costs that batch
 * its vectors, is recorded in `errors`, and the walk continues.
 */
export async function embedFiles(
  store: IndexStore,
  port: EmbeddingPort,
  relativeOf: (file: string) => string,
  options: EmbedOptions = {},
): Promise<EmbedResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const signal = options.signal;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 128));

  const providerChanged = store.reconcileVectorProvider(port.id);
  const pruned = store.pruneOrphanFileVectors();
  const stored = store.getFileVectorStates(port.id);
  const summaries = store.getReadyConceptSummaries();

  // Rank orders the walk; membership is every indexed file, so files the
  // reference graph never reached still get embedded.
  const rankOf = new Map<string, number>();
  const metas = store.getAllFileMetas();
  for (const row of store.getRankedFiles(metas.length || 1)) rankOf.set(row.file, row.rank);
  const ordered = metas
    .map((meta) => meta.file)
    .sort((a, b) => (rankOf.get(b) ?? 0) - (rankOf.get(a) ?? 0) || a.localeCompare(b));

  interface Pending {
    file: string;
    text: string;
    hash: string;
    fromDeclarations: boolean;
  }
  const queue: Pending[] = [];
  let cached = 0;
  for (const file of ordered) {
    const declarations = summaries.has(file)
      ? []
      : store.getFileSymbols(file, FALLBACK_DECLARATIONS).map((symbol) => symbol.name);
    const { text, fromDeclarations } = embedTextFor(
      relativeOf(file),
      summaries.get(file),
      declarations,
    );
    if (text.trim().length === 0) continue;
    const hash = xxhash64String(text);
    if (options.force !== true && stored.get(file) === hash) {
      cached++;
      continue;
    }
    queue.push({ file, text, hash, fromDeclarations });
    if (options.maxFiles !== undefined && queue.length >= options.maxFiles) break;
  }

  let embedded = 0;
  let fromDeclarations = 0;
  let done = 0;

  for (let start = 0; start < queue.length; start += batchSize) {
    if (signal?.aborted) break;
    const batch = queue.slice(start, start + batchSize);
    try {
      const vectors = await port.embed(batch.map((entry) => entry.text));
      const rows = [];
      for (let i = 0; i < batch.length; i++) {
        const entry = batch[i] as Pending;
        const vector = vectors[i];
        // A provider that returns fewer vectors than inputs, or a vector of the
        // wrong width, would corrupt the space silently. Drop those rather than
        // store something that will never match anything.
        if (vector === undefined || vector.length !== port.dimensions) continue;
        rows.push({ file: entry.file, vector, sourceHash: entry.hash, provider: port.id });
        if (entry.fromDeclarations) fromDeclarations++;
      }
      store.upsertFileVectors(rows);
      embedded += rows.length;
    } catch (error) {
      if (errors.length < 20) {
        errors.push(`batch at ${start}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      done += batch.length;
      options.onProgress?.(done, queue.length);
    }
  }

  return {
    embedded,
    cached,
    pruned,
    providerChanged,
    fromDeclarations,
    durationMs: Date.now() - startedAt,
    errors,
  };
}

/** Reported when a project has no index to embed. */
export type EmbedIndexMissing = { indexed: false };

/**
 * Embed a project's files, owning the store lifetime so callers outside this
 * package never touch `indexStorePool`. Refuses to run without an index.
 */
export async function embedProjectFiles(
  projectRoot: string,
  port: EmbeddingPort,
  options: EmbedOptions & { indexDir?: string | undefined } = {},
): Promise<EmbedResult | EmbedIndexMissing> {
  const { indexDir, ...rest } = options;
  if (!existsSync(path.join(resolveIndexDir(projectRoot, indexDir), 'index.db'))) {
    return { indexed: false };
  }
  const store = indexStorePool.acquire(projectRoot, { indexDir });
  try {
    return await embedFiles(
      store,
      port,
      (file) => {
        const relative = path.relative(projectRoot, file);
        return posixIndexPath(relative && !relative.startsWith('..') ? relative : file);
      },
      rest,
    );
  } finally {
    indexStorePool.release(store);
  }
}
