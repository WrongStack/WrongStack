/**
 * Host-side wiring for the codebase index's semantic embeddings.
 *
 * The model is `packages/vector-memory`'s transformers-backed provider, which
 * already emits 384-dimensional vectors — the width `file_vectors` stores. It
 * arrives here rather than inside `packages/tools` for two reasons:
 *
 *  - `@huggingface/transformers` is an **optional** dependency. A repository
 *    that never enables semantic search should not have to install a model
 *    runtime, and `packages/tools` must stay importable without one.
 *  - A function cannot cross the project daemon's IPC boundary. The daemon
 *    compares vectors; the host produces them. That also keeps a ~90 MB model
 *    out of every per-project daemon process.
 *
 * Everything here is best-effort. When the optional dependency is absent, the
 * model cannot load, or the config leaves embeddings off, the port is simply
 * `undefined` and retrieval stays lexical — which is the behaviour that
 * shipped before embeddings existed.
 */

import type { IndexingEmbeddingsConfig } from '@wrongstack/core/types';
import type { EmbeddingPort } from '@wrongstack/tools';

/** Vector width `file_vectors` stores; a provider must match it exactly. */
const EXPECTED_DIMENSIONS = 384;

/**
 * Build the embedding port, or `undefined` when semantic search is off or
 * unavailable.
 *
 * The dynamic import is what keeps `@huggingface/transformers` optional: a
 * missing package throws here and is reported as "unavailable", never as a
 * startup failure.
 */
export async function createCodebaseEmbeddingPort(
  settings: IndexingEmbeddingsConfig | undefined,
): Promise<EmbeddingPort | undefined> {
  if (settings?.enabled !== true) return undefined;

  try {
    const { TransformersEmbeddingProvider } = await import('@wrongstack/vector-memory');
    const provider = new TransformersEmbeddingProvider({
      ...(settings.model ? { modelId: settings.model } : {}),
      ...(settings.batchSize ? { batchSize: settings.batchSize } : {}),
    });
    if (!(await provider.isAvailable())) return undefined;
    // A provider of the wrong width would write vectors nothing can ever match.
    if (provider.dimensions !== EXPECTED_DIMENSIONS) return undefined;
    return provider;
  } catch {
    return undefined;
  }
}
