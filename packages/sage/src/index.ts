export { verifyMemoryAnchors } from './anchors/verify.js';
export {
  HashingEmbeddingProvider,
  type HashingEmbeddingProviderOptions,
} from './embeddings/hashing.js';
export {
  createProjectSageMemoryPort,
  createSqliteMemoryPort,
  getSageRetrieval,
  getSageService,
  getSageSurface,
  LegacyMemoryPortAdapter,
  SqliteMemoryPort,
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SERVICE_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type SageRetrievalCapability,
  ProjectSageMemoryPort,
  type ProjectSageMemoryPortOptions,
} from './memory-port.js';
export {
  isSageProjectServerAvailable,
  SageProjectServerConnection,
  type SageProjectServerConnectionState,
} from './project-server-client.js';
export {
  resolveProjectSageStorageRoot,
  sageProjectServerEndpoint,
  sageProjectServerKey,
} from './project-server-endpoint.js';
export {
  createSageContextMonitorMiddleware,
  type SageContextMonitorOptions,
} from './middleware/context-monitor.js';
export {
  type ContextMemorySnapshot,
  InjectionTracker,
  type InjectionTrackerOptions,
} from './middleware/injection-tracker.js';
export {
  MemoryInjectorAgent,
  type MemoryInjectorMeasurement,
  type MemoryInjectorPlan,
  type MemoryInjectorPlanInput,
} from './middleware/memory-injector-agent.js';
// Canonical defaults for the SAGE memory injector gates. These are the
// authoritative values: any consumer (TUI, CLI, WebUI) that needs to render
// a fallback proof should import from here so drift between the wrapper and
// the runtime emitter is impossible.
export {
  DEFAULT_MIN_IMPORTANCE,
  DEFAULT_MIN_SCORE,
  MIN_RELATION_STRENGTH,
  createSageToolCallMiddleware,
  type MemoryToolTrigger,
  type SageRetrieverLike,
  type SageToolCallMiddlewareOptions,
} from './middleware/tool-call-memory.js';
export {
  createSageTurnMiddleware,
  overlapCoefficient,
  type SageTurnMiddlewareOptions,
} from './middleware/turn-memory.js';
export {
  ancestorPaths,
  DEFAULT_SAGE_DIR,
  normalizeProjectPath,
  normalizeSlashes,
  resolveSagePaths,
} from './paths.js';
export {
  type FormatMemoryHintsOptions,
  type FormattedMemoryHints,
  formatMemoryHints,
  formatMemoryHintsDetailed,
} from './retrieval/format.js';
export {
  type MemoryQueryRelevance,
  memoryQueryRelevance,
  memoryStructuralRelevance,
} from './retrieval/relevance.js';
export type {
  SageServiceLike,
  SageSurface,
  SearchHit,
  SearchMatchReason,
  SearchOptions,
  SearchQuery,
  SearchRanking,
  SearchResult,
  SearchSuggestionMode,
} from './service-contract.js';
export { isSageService } from './service-guard.js';
export { isSqliteAvailable, SqliteSageStore } from './sqlite-store.js';
export { normalizeTextKey, tokenize } from './store-helpers.js';
export { createSageTools } from './tools/memory-tools.js';
export type { UpdateSageInput } from './types.js';
export * from './types.js';
