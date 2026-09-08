export { mapWithConcurrency } from './_concurrency.js';
export {
  type DangerAssessment,
  type DangerLevel,
  type DangerRule,
  detectDanger,
} from './_danger-detect.js';
export {
  type CompileFail,
  type CompileResult,
  capSubject,
  compileUserRegex,
  MAX_SUBJECT_LEN,
} from './_regex.js';
export {
  type EnsureSessionShellOptions,
  ensureSessionShell,
  normalizeShell,
  type ResolveSessionShellDeps,
  resolveSessionShell,
} from './_session-shell.js';
export type { BashShell } from './_shell-pick.js';
export {
  checkSyntax,
  type SyntaxCheckResult,
} from './_syntax-check.js';
export {
  type AuditContext,
  type AuditInput,
  type AuditOutput,
  type AuditVulnerability,
  auditTool,
} from './audit.js';
export {
  type AutoProceedLoopGuard,
  createAutoProceedLoopGuard,
  GROUNDED_NO_PROGRESS_STEER,
  type GroundedRepetitionAction,
  type GroundedRepetitionSignal,
  type LoopGuardOptions,
  normalizeForRepetition,
  type RepetitionSignal,
} from './auto-proceed-loop-guard.js';
export {
  type BashInput,
  type BashOutput,
  bashTool,
} from './bash.js';
export {
  checkAndBlockKillCommand,
  type KillCheckResult,
  type KillCommand,
} from './bash-kill-guard.js';
export * from './browser/index.js';
// builtinTools moved to './builtin.ts' so consumers that only need a subset of
// tools don't transitively import all 30. Use `@wrongstack/tools/builtin`.
export {
  builtinTools,
  OFF_ONLY_TOOLS,
  OPTIONAL_TOOLS,
  TIER1_TOOLS,
  TIER2_TOOLS,
  TIER3_TOOLS,
} from './builtin.js';
export {
  type BreakerState,
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
export {
  type ClarifyAnswerItem,
  type ClarifyInput,
  type ClarifyOutput,
  type ClarifyQuestionInput,
  type ClarifyQuestionItem,
  clarifyTool,
} from './clarify.js';
export type {
  CircuitSnapshot,
  CircuitState,
  CodebaseAstReplaceInput,
  CodebaseAstReplaceOutput,
  CodebaseImpactAnalysisInput,
  CodebaseImpactAnalysisOutput,
  CodebaseIncomingCallsInput,
  CodebaseIncomingCallsOutput,
  CodebaseIndexInput,
  CodebaseIndexOutput,
  CodebaseInvariantCheckInput,
  CodebaseInvariantCheckOutput,
  CodebaseOutgoingCallsInput,
  CodebaseOutgoingCallsOutput,
  CodebaseRepoMapInput,
  CodebaseRepoMapOutput,
  CodebaseSearchInput,
  CodebaseSearchOutput,
  CodebaseSkeletonInput,
  CodebaseSkeletonOutput,
  CodebaseStatsInput,
  CodebaseStatsOutput,
  CodebaseTargetedTestInput,
  CodebaseTargetedTestOutput,
  CodeMapGraph,
  DeadCodeScanInput,
  DeadCodeScanOutput,
  DeadFile,
  DeadPackage,
  DeadSymbol,
  GraphEdge,
  GraphNode,
  ImpactAnalysisInput,
  ImpactAnalysisOutput,
  ImpactCallSite,
  IncomingCallsInput,
  IncomingCallsOutput,
  OutgoingCallsInput,
  OutgoingCallsOutput,
  ProjectIndexDaemonAvailability,
  ProjectIndexServerActivity,
  ProjectIndexServerClientHealth,
  ProjectIndexServerConnectionState,
  ProjectIndexServerConnectionStatus,
  ProjectIndexServerHealth,
  TargetedTestInput,
  TargetedTestOutput,
} from './codebase-index/index.js';
export {
  ATLAS_DIR,
  // Codebase Atlas: the centrality, retrieval, projection, concept and
  // embedding layers over the structural index.
  type AtlasBrief,
  type AtlasBriefIndexMissing,
  type AtlasFreshness,
  type AtlasIndexMissing,
  buildProjectAtlasBrief,
  CircuitOpenError,
  CONCEPT_RELATIONS,
  type ConceptIndexMissing,
  type ContextResult,
  cancelPendingReindexes,
  checkCodebaseIndexServerHealth,
  checkProjectAtlasFreshness,
  codebaseAstReplaceTool,
  codebaseContextTool,
  codebaseImpactAnalysisTool,
  codebaseIncomingCallsTool,
  codebaseIndexStats,
  codebaseIndexTool,
  codebaseInvariantCheckTool,
  codebaseOutgoingCallsTool,
  codebaseRepoMapTool,
  codebaseSearchTool,
  codebaseSkeletonTool,
  codebaseStatsTool,
  codebaseTargetedTestTool,
  deadCodeScanTool,
  type EmbeddingPort,
  type EmbedIndexMissing,
  type EmbedResult,
  type EnrichResult,
  embedProjectFiles,
  enqueueReindex,
  enrichProjectConcepts,
  ensureCodebaseIndexServer,
  exportProjectAtlasHtml,
  extractDirectorySkeleton,
  extractFileSkeleton,
  type FileSkeletonResult,
  fileGraphService,
  generateRepoMap,
  getIndexState,
  IndexCircuitBreaker,
  IndexTimeoutError,
  indexCircuitBreaker,
  isIndexableFile,
  isIndexing,
  isIndexReady,
  MAX_CRUX_LINES,
  MAX_REPORTED_DRIFT,
  type MutateSymbolOptions,
  type MutateSymbolResult,
  onIndexStateChange,
  packageGraphService,
  type RepoMapOptions,
  type RepoMapResult,
  replaceSymbolInFile,
  resetIndexCircuitBreaker,
  resolveProjectIndexDaemonAvailability,
  runDeadCodeScan,
  runStartupIndex,
  type SkeletonOptions,
  type SkeletonSymbolRange,
  type SummarizeFileInput,
  type SummarizeFileResult,
  type SummarizerPort,
  type SummarizeSubsystemInput,
  type SummarizeSubsystemResult,
  searchCodebaseIndex,
  setContextQueryEmbedder,
  shutdownCodebaseIndexHost,
  shutdownCodebaseIndexServer,
  symbolGraphService,
  writeProjectAtlas,
} from './codebase-index/index.js';
export {
  type DesignInput,
  type DesignOutput,
  designTool,
} from './design.js';
export {
  type DiffInput,
  type DiffMode,
  type DiffOutput,
  diffTool,
} from './diff.js';
export {
  discoverE2EProjects,
  type E2EExecutionPlan,
  type E2EFramework,
  type E2EPackageManager,
  type E2EPlanInput,
  type E2EPlanOutput,
  type E2EProjectPlan,
  type E2EServerHint,
  e2ePlanTool,
} from './e2e.js';
export {
  type EditInput,
  type EditOutput,
  editTool,
  type MatchTier,
} from './edit.js';
export {
  configureDangerBypass,
  configureExecPolicy,
  type ExecInput,
  type ExecOutput,
  execTool,
  getDangerBypass,
  getExecAllowlist,
  isExecCommandAllowed,
  resetDangerBypass,
  resetExecPolicy,
} from './exec.js';
export {
  checkExecKillCommand,
  type ExecKillCheckResult,
} from './exec-kill-guard.js';
export {
  type FetchFormat,
  type FetchInput,
  type FetchOutput,
  fetchTool,
} from './fetch.js';
export {
  type FormatContext,
  type FormatFixer,
  type FormatInput,
  type FormatOutput,
  formatTool,
} from './format.js';
export {
  type GitInput,
  type GitOutput,
  type GitSubcommand,
  gitTool,
} from './git.js';
export {
  type GlobInput,
  type GlobOutput,
  globTool,
} from './glob.js';
export {
  type GrepBackend,
  type GrepEngine,
  type GrepInput,
  type GrepOutput,
  type GrepOutputMode,
  grepTool,
} from './grep.js';
export {
  type InstallContext,
  type InstallInput,
  type InstallOutput,
  type InstallSaveType,
  installTool,
} from './install.js';
export {
  type JsonAction,
  type JsonInput,
  type JsonOutput,
  jsonTool,
} from './json.js';
export {
  type KanbanAction,
  type KanbanContext,
  type KanbanToolInput,
  type KanbanToolOutput,
  kanbanTool,
} from './kanban.js';
export {
  kanbanEvidenceKey,
  kanbanEvidencePointer,
  recordKanbanVerificationEvidence,
} from './kanban-evidence-bridge.js';
export * from './languages/index.js';
export {
  type LintContext,
  type LinterName,
  type LintInput,
  type LintOutput,
  lintTool,
} from './lint.js';
export {
  type LogEntry,
  type LogsInput,
  type LogsOutput,
  logsTool,
} from './logs.js';
export {
  type ForgetInput,
  type ForgetOutput,
  forgetTool,
  type RelatedMemoryInput,
  type RememberInput,
  type RememberOutput,
  relatedMemoryTool,
  rememberTool,
  type SearchMemoryInput,
  type SearchMemoryOutput,
  searchMemoryTool,
} from './memory.js';
export {
  createModeTool,
  type ModeFamily,
  type ModeInput,
  type ModeOutput,
} from './mode.js';
export {
  type ParsedNextStep,
  type ParseNextStepsOptions,
  type ParseNextStepsResult,
  parseNextSteps,
  stripNextSteps,
} from './next-steps.js';
export {
  type NextStepsInput,
  type NextStepsOutput,
  nextStepsTool,
} from './next-steps-tool.js';
export {
  type OutdatedContext,
  type OutdatedInput,
  type OutdatedOutput,
  type OutdatedPackage,
  outdatedTool,
} from './outdated.js';
export { builtinToolsPack } from './pack.js';
export {
  type PatchInput,
  type PatchOutput,
  patchTool,
} from './patch.js';
export {
  type PlanAction,
  type PlanInput,
  type PlanOutput,
  planTool,
} from './plan.js';
export {
  getProcessGuardian,
  type ProcessGuardianConfig,
  startProcessGuardian,
  stopProcessGuardian,
} from './process-guardian.js';
export {
  _resetProcessRegistry,
  type BreakerCountdown,
  getProcessRegistry,
  type KillOpts,
  type ProcessRegistryImpl,
  type RegistryStats,
  type TrackedProcess,
} from './process-registry.js';
export {
  getPersistentProcessRegistry,
  type PersistentProcessEntry,
  type PersistentRegistryData,
  resetPersistentProcessRegistry,
} from './process-registry-persistent.js';
export {
  createGlobalPsSlashCommand,
  formatGlobalStatus,
  formatInstanceList,
  formatInstanceSummary,
  type GlobalProcessStatus,
  getInstanceCount,
  type InstanceInfo,
  type InstanceListOptions,
  listInstances,
} from './ps-slash.js';
export {
  PWSH_TOOL_DESCRIPTION,
  PWSH_TOOL_USAGE_HINT,
  type PwshInput,
  type PwshOutput,
  pwshTool,
} from './pwsh.js';
export {
  type ReadInput,
  type ReadMode,
  type ReadOutput,
  readTool,
  type SymbolEntry,
} from './read.js';
export {
  type ReadUrlContentInput,
  type ReadUrlContentOutput,
  readUrlContentTool,
} from './read-url-content.js';
export {
  type ReplaceInput,
  type ReplaceOutput,
  replaceTool,
} from './replace.js';
export {
  type CacheEntry as SearchCacheEntry,
  type SearchInput,
  type SearchOutput,
  type SearchResult,
  searchTool,
} from './search.js';
export {
  analyzeSecurityAndPerformance,
  type SecurityFinding,
  type SecurityScanInput,
  type SecurityScanOutput,
  securityAstScanTool,
} from './security-ast-scan-tool.js';
export {
  applySessionKanbanBoardToTodos,
  applySessionKanbanTaskToSource,
  attachSessionKanbanMirror,
  ensureSessionKanbanBoard,
  hydrateSessionKanban,
  mirrorSessionPlanToKanban,
  mirrorSessionTasksToKanban,
  mirrorSessionTodosToKanban,
  projectSessionPlanToKanban,
  projectSessionTasksToKanban,
  projectSessionTodosToKanban,
  rebindSessionKanbanTask,
  SESSION_KANBAN_COLUMNS,
} from './session-kanban.js';
export {
  type LoadedResource,
  makeSkillTool,
  type SkillResource,
  type SkillToolInput,
  type SkillToolOutput,
} from './skill.js';
export {
  type TaskAction,
  type TaskAdditionItem,
  type TaskInput,
  type TaskOutput,
  type TaskReplacementItem,
  taskTool,
} from './task.js';
export {
  type TestContext,
  type TestInput,
  type TestOutput,
  type TestRunnerName,
  testTool,
} from './test.js';
export {
  type TodoInput,
  type TodoKanbanBinding,
  type TodoOutput,
  todoTool,
} from './todo.js';
export {
  computeLineDiff,
  DIFF_MAX_LINES,
  type DiffRow,
  type DiffRowKind,
  diffFromToolInput,
  type ToolDiff,
} from './tool-diff.js';
// Tool icon mapping — shared across all UIs (WebUI, TUI, REPL)
export {
  FALLBACK_ICON,
  getToolIcon,
  TOOL_ICON_CONFIG,
  TOOL_ICON_MAP,
  type ToolIconConfig,
  type ToolIconId,
} from './tool-icon-map.js';
export {
  FALLBACK_HEAD_FIELDS,
  SUMMARIZE_TOOL_INPUT_BROWSER_SRC,
  summarizeToolInput,
} from './tool-summary.js';
export {
  type RegisterBuiltinToolTierOptions,
  registerBuiltinToolTier,
  selectBuiltinToolsForTier,
} from './tool-tier.js';
export {
  DEFAULT_MAX_TREE_ENTRIES,
  MAX_TREE_OUTPUT_BYTES,
  type TreeContext,
  type TreeInput,
  type TreeOutput,
  treeTool,
} from './tree.js';
export {
  type TypecheckContext,
  type TypecheckInput,
  type TypecheckOutput,
  typecheckTool,
} from './typecheck.js';
export {
  type WriteInput,
  type WriteOutput,
  writeTool,
} from './write.js';
