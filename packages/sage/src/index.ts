export { verifyMemoryAnchors } from './anchors/verify.js';
export {
  DEFAULT_GLOSSARY_ENTRY_CHARS,
  DEFAULT_MAX_GLOSSARY_ENTRIES,
  DOMAIN_TERM_LOOKUP_TAG,
  DOMAIN_TERMS_FILENAME,
  type DomainTermGitExec,
  type ExtractedTerm,
  type ExtractFromCommitsOptions,
  type ExtractFromConversationOptions,
  normalizeTerm,
  type PersistOptions,
  type PersistOutcome,
  type PersistReport,
  type PersistViaAndMirrorOptions,
  type PersistViaAndMirrorReport,
  SageDomainTermExtractor,
} from './domain-term-extractor.js';
export {
  HashingEmbeddingProvider,
  type HashingEmbeddingProviderOptions,
} from './embeddings/hashing.js';
export { cosineSimilarity } from './embeddings/provider.js';
export type { EmbeddingProvider } from './embeddings/provider.js';
export {
  createProjectSageMemoryPort,
  createSqliteMemoryPort,
  getSageRetrieval,
  getSageService,
  getSageSurface,
  LegacyMemoryPortAdapter,
  ProjectSageMemoryPort,
  type ProjectSageMemoryPortOptions,
  SAGE_RETRIEVAL_CAPABILITY,
  SAGE_SERVICE_CAPABILITY,
  SAGE_SURFACE_CAPABILITY,
  type SageRetrievalCapability,
  SqliteMemoryPort,
} from './memory-port.js';
export {
  createSageContextMonitorMiddleware,
  type SageContextMonitorOptions,
} from './middleware/context-monitor.js';
export {
  createSageDomainTermExtractorMiddleware,
  type SageDomainTermExtractorMiddlewareOptions,
} from './middleware/domain-term-extractor-middleware.js';
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
export {
  type SubscribeSessionEndCommitExtractorOptions,
  subscribeSessionEndCommitExtractor,
} from './middleware/session-end-commit-extractor.js';
// Canonical defaults for the SAGE memory injector gates. These are the
// authoritative values: any consumer (TUI, CLI, WebUI) that needs to render
// a fallback proof should import from here so drift between the wrapper and
// the runtime emitter is impossible.
export {
  createSageToolCallMiddleware,
  DEFAULT_MIN_IMPORTANCE,
  DEFAULT_MIN_SCORE,
  type MemoryToolTrigger,
  MIN_RELATION_STRENGTH,
  type SageRetrieverLike,
  type SageToolCallMiddlewareOptions,
} from './middleware/tool-call-memory.js';
export {
  createSageOutcomeCaptureMiddleware,
  type SageOutcomeCaptureOptions,
} from './middleware/outcome-capture.js';
export {
  createSagePathRemapMiddleware,
  type SagePathRemapOptions,
} from './middleware/path-remap.js';
export {
  memoryNeedsPathRemap,
  memoryNeedsSymbolRemap,
  normalizeRelPath,
  parseRenameCommand,
  readIdentifierAt,
  remapAnchors,
  remapSymbolAnchors,
  toProjectRelative,
} from './shared/path-remap.js';
export {
  fileTriageProposals,
  type ProposalFileResult,
} from './shared/file-proposals.js';
export { hybridRerankMemories } from './retrieval/hybrid-rerank.js';
export { isSageVisibleForSearch } from './retrieval/visibility.js';
export {
  augmentLexicalWithVectorRecall,
  type VectorAugmentHit,
  type VectorAugmentOptions,
  type VectorRecallProvider,
} from './retrieval/vector-augment.js';
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
  isSageProjectServerAvailable,
  SageProjectServerConnection,
  type SageProjectServerConnectionState,
} from './project-server-client.js';
export {
  resolveProjectSageStorageRoot,
  sageProjectServerEndpoint,
  sageProjectServerKey,
  sageProjectServerMetadataPath,
} from './project-server-endpoint.js';
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
export {
  AUTO_HYGIENE_INTERVAL_MS,
  _resetAutoHygieneThrottleForTesting,
  sageHygieneOptionsFromConfig,
  setupSage,
  type SageHostWiringDeps,
} from './host-wiring.js';
export {
  filterProposalsAgainstPendingTargets,
  type PendingCandidateTarget,
} from './shared/candidate-dedupe.js';
export { createSageTools } from './tools/memory-tools.js';
export {
  type AutoApplyAction,
  computeValueScore,
  computeValueScores,
  type DispatchResult,
  detectMerges,
  dispatchAction,
  dispatchBatch,
  evaluateBatch,
  evaluateMemory,
  type LlmEvaluation,
  type LlmEvaluatorOptions,
  type LlmTriageResult,
  type MemoryCluster,
  type MemoryFieldUpdate,
  type MergeAction,
  type MergeCandidate,
  type MergeDetectionResult,
  type MergePairResult,
  type MergeVerdict,
  type OverlapProposal,
  type PreFilterResult,
  type PreFilterVerdict,
  preFilter,
  preFilterBatch,
  type TriageAction,
  type TriageProposal,
  type ValueBand,
  type ValueScoreBreakdown,
} from './triage/index.js';
export type { LlmCallFn } from './triage/llm-evaluator.js';
export {
  formatTriageReport,
  type RunTriageOptions,
  runTriage,
  type TriageReport,
} from './triage/orchestrator.js';
export type { UpdateSageInput } from './types.js';
export * from './types.js';
