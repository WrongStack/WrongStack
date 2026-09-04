/**
 * @wrongstack/vector-memory — public exports.
 */
export {
  DEFAULT_VECTOR_DIMENSIONS,
  DEFAULT_VECTOR_DTYPE,
  DEFAULT_VECTOR_MODEL_ID,
  TransformersEmbeddingProvider,
  type TransformersEmbeddingProviderOptions,
} from './transformers-provider.js';
export {
  VECTOR_DIMENSIONS_KEY,
  VECTOR_PROVIDER_KEY,
  VECTOR_SCHEMA_VERSION,
  decodeVector,
  encodeVector,
  initVectorSchema,
  lookupEmbeddingCache,
  upsertEmbeddingCache,
} from './schema.js';
export {
  VectorMemoryStore,
  fallbackHashingProvider,
  type SageSyncSource,
} from './store.js';
export {
  createSageSurfaceSyncSource,
  type SageSurfaceSyncOptions,
} from './sage-sync-source.js';
export {
  SAGE_SYNC_MARKER_FILENAME,
  decideWhetherToSync,
  startFirstBootSageSync,
  type FirstBootSageSyncOptions,
  type FirstBootSageSyncResult,
  type SageSyncMarker,
} from './sage-sync.js';
export { createVectorMemoryTools } from './tools.js';
export {
  asVectorRecallProvider,
  fuseWithVectorMemory,
  type SageFusionHit,
  type SageFusionOptions,
} from './sage-fusion.js';
export {
  wrapMemoryPortWithVectorRecall,
  type VectorPortWrappingOptions,
} from './sage-port-wrapper.js';
export {
  DEFAULT_SWEEP_INTERVAL_MS,
  forgetStaleSageMirrors,
  SAGE_SWEEP_MARKER_FILENAME,
  subscribeVectorMemoryToSage,
  sweepStaleSageMirrors,
  type SweepStaleSageMirrorsOptions,
  type SweepStaleSageMirrorsResult,
  type VectorMemoryMirrorHandle,
  type VectorMemoryMirrorOptions,
} from './sage-event-mirror.js';
export {
  runSearchRace,
  type SearchRaceChannelHit,
  type SearchRaceOptions,
  type SearchRaceResult,
} from './search-race.js';
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
export {
  VectorMemoryError,
  VectorMemoryProviderUnavailableError,
} from './errors.js';
