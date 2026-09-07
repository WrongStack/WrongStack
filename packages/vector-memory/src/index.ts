/**
 * @wrongstack/vector-memory — public exports.
 */

export {
  VectorMemoryError,
  VectorMemoryProviderUnavailableError,
} from './errors.js';
export {
  DEFAULT_SWEEP_INTERVAL_MS,
  forgetStaleSageMirrors,
  SAGE_SWEEP_MARKER_FILENAME,
  type SweepStaleSageMirrorsOptions,
  type SweepStaleSageMirrorsResult,
  subscribeVectorMemoryToSage,
  sweepStaleSageMirrors,
  type VectorMemoryMirrorHandle,
  type VectorMemoryMirrorOptions,
} from './sage-event-mirror.js';
export {
  asVectorRecallProvider,
  fuseWithVectorMemory,
  type SageFusionHit,
  type SageFusionOptions,
} from './sage-fusion.js';
export {
  type VectorPortWrappingOptions,
  wrapMemoryPortWithVectorRecall,
} from './sage-port-wrapper.js';
export {
  decideWhetherToSync,
  type FirstBootSageSyncOptions,
  type FirstBootSageSyncResult,
  SAGE_SYNC_MARKER_FILENAME,
  type SageSyncMarker,
  startFirstBootSageSync,
} from './sage-sync.js';
export {
  createSageSurfaceSyncSource,
  type SageSurfaceSyncOptions,
} from './sage-sync-source.js';
export {
  decodeVector,
  encodeVector,
  initVectorSchema,
  lookupEmbeddingCache,
  upsertEmbeddingCache,
  VECTOR_DIMENSIONS_KEY,
  VECTOR_PROVIDER_KEY,
  VECTOR_SCHEMA_VERSION,
} from './schema.js';
export {
  runSearchRace,
  type SearchRaceChannelHit,
  type SearchRaceOptions,
  type SearchRaceResult,
} from './search-race.js';
export {
  fallbackHashingProvider,
  type SageSyncSource,
  VectorMemoryStore,
} from './store.js';
export { createVectorMemoryTools } from './tools.js';
export {
  DEFAULT_VECTOR_DIMENSIONS,
  DEFAULT_VECTOR_DTYPE,
  DEFAULT_VECTOR_MODEL_ID,
  TransformersEmbeddingProvider,
  type TransformersEmbeddingProviderOptions,
} from './transformers-provider.js';
export type {
  SageSyncReport,
  VectorEntry,
  VectorEntryInput,
  VectorEntryWithVector,
  VectorKind,
  VectorMemoryStoreOptions,
  VectorScope,
  VectorSearchHit,
  VectorSearchOptions,
  VectorStoreStats,
} from './types.js';
