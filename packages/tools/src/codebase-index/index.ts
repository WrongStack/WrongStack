/**
 * @wrongstack/tools – Codebase Index
 *
 * Three tools for building and querying a symbol index:
 *
 *   `codebase-index`  — run the indexer (full or incremental)
 *   `codebase-search` — BM25-ranked symbol search
 *   `codebase-stats`  — index health and statistics
 *
 * Storage: `~/.wrongstack/projects/<hash>/codebase-index/index.db`
 *          (outside the repo — no gitignore needed)
 * Parser:  TS Compiler API + native Go/Python/Rust helpers + universal regex
 *          fallback so every mapped language always enters the index
 * Ranking: Okapi BM25 / FTS5 (k1=1.5, b=0.75)
 */

export {
  type InvariantEvaluationResult,
  type InvariantRuleId,
  type InvariantViolation,
  type ModuleContract,
  PolyglotInvariantEngine,
  polyglotInvariantEngine,
} from './ast-invariant-engine.js';
export {
  type MutateSymbolOptions,
  type MutateSymbolResult,
  replaceSymbolInFile,
} from './ast-symbol-mutator.js';
export {
  cancelPendingReindexes,
  checkCodebaseIndexServerHealth,
  codebaseIndexStats,
  enqueueReindex,
  ensureCodebaseIndexServer,
  fileGraphService,
  getIndexState,
  incomingCallsService,
  isIndexableFile,
  isIndexing,
  isIndexReady,
  onIndexStateChange,
  outgoingCallsService,
  packageGraphService,
  runStartupIndex,
  searchCodebaseIndex,
  shutdownCodebaseIndexHost,
  shutdownCodebaseIndexServer,
  symbolGraphService,
} from './background-indexer.js';
export {
  buildBm25Index,
  buildIndexableText,
  tokenise,
} from './bm25.js';
export {
  getCodebaseIndexPerfSnapshot,
  resetCodebaseIndexPerfMetrics,
  type CodebaseIndexPerfSnapshot,
} from './perf-metrics.js';
export type { CircuitSnapshot, CircuitState } from './circuit-breaker.js';
// Circuit breaker guarding every index run (startup, incremental, manual).
// `resetIndexCircuitBreaker` is the manual-recovery hook for /codebase-reindex.
export {
  CircuitOpenError,
  IndexCircuitBreaker,
  IndexTimeoutError,
  indexCircuitBreaker,
  resetIndexCircuitBreaker,
} from './circuit-breaker.js';
export {
  type CodebaseAstReplaceInput,
  type CodebaseAstReplaceOutput,
  codebaseAstReplaceTool,
} from './codebase-ast-replace-tool.js';
export {
  type CodebaseImpactAnalysisInput,
  type CodebaseImpactAnalysisOutput,
  codebaseImpactAnalysisTool,
  type ImpactAnalysisInput,
  type ImpactAnalysisOutput,
  type ImpactCallSite,
} from './codebase-impact-analysis-tool.js';
export {
  type CodebaseIncomingCallsInput,
  type CodebaseIncomingCallsOutput,
  codebaseIncomingCallsTool,
  type IncomingCallsInput,
  type IncomingCallsOutput,
} from './codebase-incoming-calls-tool.js';
export {
  type CodebaseIndexInput,
  type CodebaseIndexOutput,
  codebaseIndexTool,
} from './codebase-index-tool.js';
export {
  type CodebaseInvariantCheckInput,
  type CodebaseInvariantCheckOutput,
  codebaseInvariantCheckTool,
} from './codebase-invariant-check-tool.js';
export {
  type CodebaseOutgoingCallsInput,
  type CodebaseOutgoingCallsOutput,
  codebaseOutgoingCallsTool,
  type OutgoingCallsInput,
  type OutgoingCallsOutput,
} from './codebase-outgoing-calls-tool.js';
export {
  type CodebaseRepoMapInput,
  type CodebaseRepoMapOutput,
  codebaseRepoMapTool,
} from './codebase-repo-map-tool.js';
export {
  type CodebaseSearchInput,
  type CodebaseSearchOutput,
  codebaseSearchTool,
} from './codebase-search-tool.js';
export {
  type CodebaseSkeletonInput,
  type CodebaseSkeletonOutput,
  codebaseSkeletonTool,
} from './codebase-skeleton-tool.js';
export {
  type CodebaseStatsInput,
  type CodebaseStatsOutput,
  codebaseStatsTool,
} from './codebase-stats-tool.js';
export {
  type CodebaseTargetedTestInput,
  type CodebaseTargetedTestOutput,
  codebaseTargetedTestTool,
  type TargetedTestInput,
  type TargetedTestOutput,
} from './codebase-targeted-test-tool.js';
export type {
  DeadCodeScanInput,
  DeadCodeScanOutput,
  DeadFile,
  DeadPackage,
  DeadSymbol,
} from './dead-code-scan.js';
export { deadCodeScanTool, runDeadCodeScan } from './dead-code-scan.js';
// Project-root .gitignore matcher. Re-exported here so non-indexer
// consumers (e.g. `@wrongstack/webui-server`'s file tree builder) can
// import it from the submodule barrel without reaching into the deep
// `./gitignore.js` path — that path has runtime files but no colocated
// `.d.ts` at every resolution, which silently breaks `tsc --noEmit`.
export {
  compileGitignore,
  type IgnoreMatcher,
  loadGitignoreMatcher,
} from './gitignore.js';
// Indexer entry point + background coordinator (used by CLI auto-index wiring
// and the file-watcher plugin's autoIndex path).
export { runIndexer } from './indexer.js';
export { detectLang, INDEXABLE_EXTENSIONS, isIndexablePath } from './languages.js';
export {
  internalKindToLspKind,
  lspKindToInternalKind,
} from './lsp-kind.js';
export type {
  ProjectIndexServerClientHealth,
  ProjectIndexServerConnectionState,
  ProjectIndexServerConnectionStatus,
} from './project-server-client.js';
export {
  type ProjectIndexDaemonAvailability,
  resolveProjectIndexDaemonAvailability,
} from './project-server-client.js';
// Endpoint derivation is pure and side-effect free. Exported so daemon
// inventory surfaces (`wstack doctor --daemons`) can locate this daemon
// without importing the daemon entry itself, which would start one.
export {
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from './project-server-endpoint.js';
export type {
  ProjectIndexServerActivity,
  ProjectIndexServerHealth,
} from './project-server-protocol.js';
export {
  generateRepoMap,
  type RepoMapOptions,
  type RepoMapResult,
} from './repo-map.js';
// Re-export shared types
export type {
  CallSite,
  CodeMapGraph,
  FileMeta,
  FileSymbols,
  GraphEdge,
  GraphNode,
  IndexResult,
  IndexStats,
  SearchResult,
  Symbol,
  SymbolKind,
  SymbolLang,
} from './schema.js';
export { SCHEMA_VERSION } from './schema.js';
export {
  extractDirectorySkeleton,
  extractFileSkeleton,
  type FileSkeletonResult,
  type SkeletonOptions,
  type SkeletonSymbolRange,
} from './skeleton-extractor.js';
// Re-export shared internal helpers so external consumers (e.g. plug-lsp)
// can use them without importing from implementation detail files.
export { codebaseIndexDirOverride, IndexStore, resolveIndexDir } from './writer.js';

// ─── Codebase Atlas: centrality, retrieval, projection, concepts, vectors ────
// Everything below is additive over the structural index. Each layer degrades
// to absence rather than to a guess: no rank pass means no ranks, not a
// filename heuristic dressed up as centrality.

export {
  type AtlasBrief,
  type AtlasBriefHub,
  type AtlasBriefIndexMissing,
  type AtlasBriefPackage,
  type AtlasBriefSubsystem,
  BRIEF_HUB_LIMIT,
  BRIEF_PACKAGE_LIMIT,
  BRIEF_SUBSYSTEM_LIMIT,
  buildAtlasBrief,
  buildProjectAtlasBrief,
} from './atlas-brief.js';
export {
  type AtlasExportOptions,
  EXPORT_FILE_LIMIT,
  EXPORT_PACKAGE_LIMIT,
  renderAtlasHtml,
} from './atlas-export.js';
export {
  ATLAS_DIR,
  ATLAS_FILE_LIMIT,
  ATLAS_JSON,
  ATLAS_MANIFEST,
  ATLAS_MARKDOWN,
  ATLAS_SCHEMA,
  type AtlasDocument,
  type AtlasEdge,
  type AtlasFile,
  type AtlasFreshness,
  type AtlasIndexMissing,
  type AtlasManifest,
  type AtlasPackage,
  type AtlasProjection,
  type AtlasSymbol,
  buildAtlas,
  checkAtlasFreshness,
  checkProjectAtlasFreshness,
  exportProjectAtlasHtml,
  MAX_REPORTED_DRIFT,
  type WrittenAtlas,
  writeAtlas,
  writeProjectAtlas,
} from './atlas-projection.js';
export {
  type CodebaseContextInput,
  type CodebaseContextOutput,
  codebaseContextTool,
  setContextQueryEmbedder,
} from './codebase-context-tool.js';
export {
  type ConceptIndexMissing,
  DEFAULT_CONCURRENCY,
  type EnrichOptions,
  type EnrichResult,
  enrichConcepts,
  enrichProjectConcepts,
  MAX_CRUX_LINES,
  MAX_SOURCE_CHARS,
  MAX_SUMMARY_CHARS,
  type SummarizeFileInput,
  type SummarizeFileResult,
  type SummarizerPort,
  type SummarizeSubsystemInput,
  type SummarizeSubsystemResult,
} from './concept-enrichment.js';
export {
  type ContextEntry,
  type ContextOptions,
  type ContextResult,
  type ContextSymbol,
  DEFAULT_LIMIT,
  DEFAULT_SYMBOLS_PER_FILE,
  retrieveContext,
  SEED_LIMIT,
} from './context-retrieval.js';
export {
  DEFAULT_BATCH_SIZE,
  type EmbeddingPort,
  type EmbedIndexMissing,
  type EmbedOptions,
  type EmbedResult,
  embedFiles,
  embedProjectFiles,
  MAX_EMBED_CHARS,
} from './embedding-pass.js';
export {
  clearWiringSnapshot,
  getWiringSnapshot,
  type WiringSnapshot,
} from './graph-adjacency-cache.js';
export {
  aggregateFileRank,
  buildWiringGraph,
  CONTRADICTED_VISIBILITY_WEIGHT,
  DEFAULT_ITERATIONS,
  DEFAULT_RESTART,
  type FileRankRow,
  type PageRankOptions,
  pageRank,
  type ResolvedRefEdge,
  type SymbolRankRow,
  toSymbolRankRows,
  UNVERIFIED_VISIBILITY_WEIGHT,
  type WiringGraph,
  type WiringGraphOptions,
} from './graph-rank.js';
export {
  RANK_REFRESH_FILE_THRESHOLD,
  RANK_VERSION,
  RANK_VERSION_KEY,
  type RankPassResult,
  runGraphRankPass,
  shouldRefreshRanks,
} from './graph-rank-pass.js';
export {
  CONCEPT_RELATIONS,
  type ConceptCoverage,
  type ConceptEdge,
  type ConceptRelation,
  type ConceptState,
  type FileConcept,
  isConceptRelation,
  type Subsystem,
} from './writer-concepts.js';
export { decorateGraphNodes } from './writer-graph-decorate.js';
export type { RankedFileRow } from './writer-rank.js';
export {
  FILE_VECTOR_PROVIDER_KEY,
  type FileVectorRow,
  type FileVectorState,
  type VectorHit,
} from './writer-vectors.js';
