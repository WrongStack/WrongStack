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
} from './schema.js';
export {
  VectorMemoryStore,
  fallbackHashingProvider,
  type SageSyncSource,
} from './store.js';
export { createVectorMemoryTools } from './tools.js';
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
