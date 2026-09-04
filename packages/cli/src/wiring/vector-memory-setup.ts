/**
 * Vector-memory setup phase (card #7C-1), extracted verbatim from
 * `cli-main.ts` (was lines 104-188).
 *
 * Constructs the optional local vector store (ONNX embeddings, own SQLite
 * file under the project root), warm-mirrors the SAGE corpus on first boot,
 * wraps the memory port so `searchSage` fuses lexical + semantic recall, and
 * subscribes the live event mirror. Construction failures disable the store
 * so the CLI boots on the SAGE-only surface.
 *
 * Ordering contract: the mirror-dispose teardown is pushed from here, but the
 * store-`close()` teardown is registered by the caller *after* the event
 * registrar is created (original push order at cli-main.ts lines 168/246).
 * `teardownHandlers` runs LIFO, so keeping the close registration in the
 * caller preserves the exact teardown sequence — do not move it here.
 */
import * as path from 'node:path';
import type { MemoryPort } from '@wrongstack/core/types';
import {
  startFirstBootSageSync,
  subscribeVectorMemoryToSage,
  sweepStaleSageMirrors,
  TransformersEmbeddingProvider,
  VectorMemoryStore,
  wrapMemoryPortWithVectorRecall,
} from '@wrongstack/vector-memory';

/** Subset of `Config['Sage']['vector']` this phase reads. */
export interface VectorMemoryTuning {
  enabled?: boolean | undefined;
  weight?: number | undefined;
  threshold?: number | undefined;
  vectorOnlyThreshold?: number | undefined;
  maxMaterializations?: number | undefined;
}

/** Weight of the semantic channel in the RRF blend when config says nothing. */
export const DEFAULT_VECTOR_WEIGHT = 0.3;

interface VectorMemoryArgs {
  projectRoot: string;
  flags: { 'vector-sync'?: unknown };
  /** `config.Sage?.vector`. Omitted = every default applies. */
  tuning?: VectorMemoryTuning | undefined;
  logger: {
    warn: (message: string) => void;
    info: (message: string) => void;
    debug?: (message: string) => void;
  };
  /** The SAGE memory port; returned wrapped when the vector store comes up. */
  memoryStore: MemoryPort;
  /** Disposer chain; the mirror-dispose handler is pushed from inside. */
  teardownHandlers: Array<() => void>;
}

interface VectorMemoryResult {
  memoryStore: MemoryPort;
  vectorMemoryStore: VectorMemoryStore | undefined;
  /**
   * Model-cache directory (`.wrongstack/cache/transformers-models` under the
   * project root). Surfaced because `session-start-payload` advertises the
   * cache location to the WebUI — callers pass it onward (original
   * cli-main.ts line 801 shorthand).
   */
  vectorMemoryModelCacheDir: string;
}

export async function setupVectorMemory(args: VectorMemoryArgs): Promise<VectorMemoryResult> {
  const { projectRoot, flags, logger, memoryStore, teardownHandlers, tuning } = args;

  if (tuning?.enabled === false) {
    return { memoryStore, vectorMemoryStore: undefined, vectorMemoryModelCacheDir: '' };
  }

  // Vector memory is an additional, optional sibling to SAGE — embed
  // locally via @huggingface/transformers, persist to its own SQLite
  // file. The model cache lives under `.wrongstack/cache/transformers-models`
  // (outside the store's data directory) so a future store-side cleanup
  // never sweeps cached model files. Constructor failures (read-only
  // filesystem, unwritable project root, corrupt SQLite parent) fall
  // back to `undefined` so the CLI still boots on the SAGE-only surface.
  let vectorMemoryStore: VectorMemoryStore | undefined;
  const vectorMemoryModelCacheDir = path.join(
    projectRoot,
    '.wrongstack',
    'cache',
    'transformers-models',
  );
  try {
    vectorMemoryStore = new VectorMemoryStore({
      provider: new TransformersEmbeddingProvider({
        cacheDir: vectorMemoryModelCacheDir,
      }),
      projectRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `vector memory store disabled: ${message} — CLI will run with the SAGE-only surface.`,
    );
    vectorMemoryStore = undefined;
  }

  let wrapped = memoryStore;

  // First boot per project: mirror the active SAGE corpus into the vector
  // store so semantic search starts warm instead of empty. Fire-and-forget
  // — the first run pays the ONNX model download, and boot must not block
  // on it. Skips instantly once the sage-sync marker says complete.
  if (vectorMemoryStore) {
    void startFirstBootSageSync({
      store: vectorMemoryStore,
      memoryStore: wrapped,
      logger,
    });
    // Wire the vector store into SAGE's `searchSage` so every retrieval
    // call fuses lexical + semantic recall transparently. The wrapper
    // preserves the underlying port's identity (so DI consumers that
    // cached the original reference keep working) but routes the read-
    // side capability methods through the vector-augmented path. The
    // surface capability (memory manager UI, hygiene) is also wrapped
    // so explicit operator searches get the same boost.
    wrapped = wrapMemoryPortWithVectorRecall(wrapped, {
      store: vectorMemoryStore,
      weight: tuning?.weight ?? DEFAULT_VECTOR_WEIGHT,
      ...(tuning?.threshold !== undefined ? { threshold: tuning.threshold } : {}),
      ...(tuning?.vectorOnlyThreshold !== undefined
        ? { vectorOnlyThreshold: tuning.vectorOnlyThreshold }
        : {}),
      ...(tuning?.maxMaterializations !== undefined
        ? { maxMaterializations: tuning.maxMaterializations }
        : {}),
    });
    // Live event mirror: every SAGE write that follows is auto-vectorized
    // without an operator running a re-sync. The first-boot marker plus
    // this listener together cover the full corpus — past + future —
    // without any background polling.
    const mirrorHandle = subscribeVectorMemoryToSage({
      store: vectorMemoryStore,
      memoryStore: wrapped,
      logger,
    });
    teardownHandlers.push(() => mirrorHandle.dispose());

    // Bulk SAGE operations — hygiene's archive/purge passes, `memory.cleared`
    // — emit one top-level event, not a `memory.deleted` per memory, so the
    // live mirror above never sees them and their vector rows outlive the
    // memory. Sweep them here, fire-and-forget and throttled by a marker file
    // shared with every other host on this project.
    void sweepStaleSageMirrors({
      store: vectorMemoryStore,
      memoryStore: wrapped,
      logger,
    });

    // Operator flag: `--vector-sync` forces a full re-sync regardless of
    // the existing `complete` marker. Use after a model change, schema
    // migration, or when the operator wants to backfill new metadata.
    // Runs synchronously here (not fire-and-forget) so the operator sees
    // the indexed/skipped/failed counts in the boot log.
    if (flags['vector-sync'] === true) {
      const forced = await startFirstBootSageSync({
        store: vectorMemoryStore,
        memoryStore: wrapped,
        logger,
        force: true,
      });
      logger.info(
        forced.synced
          ? `vector-memory forced re-sync complete (${forced.marker?.indexed ?? 0} new)`
          : `vector-memory forced re-sync skipped: ${forced.reason}`,
      );
    }
  }

  return { memoryStore: wrapped, vectorMemoryStore, vectorMemoryModelCacheDir };
}
