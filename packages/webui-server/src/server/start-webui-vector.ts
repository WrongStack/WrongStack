import type { Logger, MemoryPort } from '@wrongstack/core/types';
import {
  startFirstBootSageSync,
  subscribeVectorMemoryToSage,
  sweepStaleSageMirrors,
  TransformersEmbeddingProvider,
  VectorMemoryStore,
  wrapMemoryPortWithVectorRecall,
} from '@wrongstack/vector-memory';

export function initVectorMemoryStore(params: {
  projectRoot: string;
  config: Record<string, unknown>;
  logger: Logger;
  vectorMemoryModelCacheDir: string;
}): VectorMemoryStore | undefined {
  const { projectRoot, config, logger, vectorMemoryModelCacheDir } = params;
  try {
    const sageConfig = config['Sage'] as { vector?: { enabled?: boolean } } | undefined;
    if (sageConfig?.vector?.enabled === false) throw new Error('disabled by config');
    return new VectorMemoryStore({
      provider: new TransformersEmbeddingProvider({
        cacheDir: vectorMemoryModelCacheDir,
      }),
      projectRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      'vector memory store disabled: ' +
        message +
        ' — standalone WebUI will run on the SAGE-only surface.',
    );
    return undefined;
  }
}

export function setupVectorMemoryMirror(params: {
  vectorMemoryStore: VectorMemoryStore;
  baseMemoryStore: MemoryPort;
  config: Record<string, unknown>;
  logger: Logger;
}): { memoryStore: MemoryPort; disposeVectorMirror: () => void } {
  const { vectorMemoryStore, baseMemoryStore, config, logger } = params;
  void startFirstBootSageSync({
    store: vectorMemoryStore,
    memoryStore: baseMemoryStore,
    logger,
  });
  const sageConfig = config['Sage'] as
    | {
        vector?: {
          weight?: number;
          threshold?: number;
          vectorOnlyThreshold?: number;
          maxMaterializations?: number;
        };
      }
    | undefined;
  const vectorTuning = sageConfig?.vector;
  const memoryStore = wrapMemoryPortWithVectorRecall(baseMemoryStore, {
    store: vectorMemoryStore,
    weight: vectorTuning?.weight ?? 0.3,
    ...(vectorTuning?.threshold !== undefined ? { threshold: vectorTuning.threshold } : {}),
    ...(vectorTuning?.vectorOnlyThreshold !== undefined
      ? { vectorOnlyThreshold: vectorTuning.vectorOnlyThreshold }
      : {}),
    ...(vectorTuning?.maxMaterializations !== undefined
      ? { maxMaterializations: vectorTuning.maxMaterializations }
      : {}),
  });
  const handle = subscribeVectorMemoryToSage({
    store: vectorMemoryStore,
    memoryStore,
    logger,
  });
  const disposeVectorMirror = () => handle.dispose();
  void sweepStaleSageMirrors({ store: vectorMemoryStore, memoryStore, logger });
  return { memoryStore, disposeVectorMirror };
}
