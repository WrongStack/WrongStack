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
  resolveProjectIndexDaemonAvailability,
  type ProjectIndexDaemonAvailability,
} from './project-server-client.js';
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
export { codebaseAstReplaceTool } from './codebase-ast-replace-tool.js';
export { codebaseInvariantCheckTool } from './codebase-invariant-check-tool.js';
export {
  replaceSymbolInFile,
  type MutateSymbolOptions,
  type MutateSymbolResult,
} from './ast-symbol-mutator.js';
export { codebaseImpactAnalysisTool } from './codebase-impact-analysis-tool.js';
export { codebaseIncomingCallsTool } from './codebase-incoming-calls-tool.js';
export { codebaseIndexTool } from './codebase-index-tool.js';
export { codebaseOutgoingCallsTool } from './codebase-outgoing-calls-tool.js';
export { codebaseRepoMapTool } from './codebase-repo-map-tool.js';
export { codebaseSearchTool } from './codebase-search-tool.js';
export { codebaseSkeletonTool } from './codebase-skeleton-tool.js';
export { codebaseStatsTool } from './codebase-stats-tool.js';
export { codebaseTargetedTestTool } from './codebase-targeted-test-tool.js';
export {
  generateRepoMap,
  type RepoMapOptions,
  type RepoMapResult,
} from './repo-map.js';
export {
  extractDirectorySkeleton,
  extractFileSkeleton,
  type FileSkeletonResult,
  type SkeletonOptions,
  type SkeletonSymbolRange,
} from './skeleton-extractor.js';
export { deadCodeScanTool, runDeadCodeScan } from './dead-code-scan.js';
export type {
  DeadCodeScanInput,
  DeadCodeScanOutput,
  DeadFile,
  DeadPackage,
  DeadSymbol,
} from './dead-code-scan.js';
// Indexer entry point + background coordinator (used by CLI auto-index wiring
// and the file-watcher plugin's autoIndex path).
export { runIndexer } from './indexer.js';
// Project-root .gitignore matcher. Re-exported here so non-indexer
// consumers (e.g. `@wrongstack/webui-server`'s file tree builder) can
// import it from the submodule barrel without reaching into the deep
// `./gitignore.js` path — that path has runtime files but no colocated
// `.d.ts` at every resolution, which silently breaks `tsc --noEmit`.
export {
  compileGitignore,
  loadGitignoreMatcher,
  type IgnoreMatcher,
} from './gitignore.js';
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
export type {
  ProjectIndexServerActivity,
  ProjectIndexServerHealth,
} from './project-server-protocol.js';

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
// Endpoint derivation is pure and side-effect free. Exported so daemon
// inventory surfaces (`wstack doctor --daemons`) can locate this daemon
// without importing the daemon entry itself, which would start one.
export {
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from './project-server-endpoint.js';
export { SCHEMA_VERSION } from './schema.js';
// Re-export shared internal helpers so external consumers (e.g. plug-lsp)
// can use them without importing from implementation detail files.
export { codebaseIndexDirOverride, IndexStore, resolveIndexDir } from './writer.js';
export {
  PolyglotInvariantEngine,
  polyglotInvariantEngine,
  type InvariantEvaluationResult,
  type InvariantRuleId,
  type InvariantViolation,
  type ModuleContract,
} from './ast-invariant-engine.js';
