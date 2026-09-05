export { type DangerAssessment, type DangerLevel, detectDanger } from './_danger-detect.js';
export {
  type EnsureSessionShellOptions,
  ensureSessionShell,
  normalizeShell,
  type ResolveSessionShellDeps,
  resolveSessionShell,
} from './_session-shell.js';
export type { BashShell } from './_shell-pick.js';
export { auditTool } from './audit.js';
export {
  bashTool,
  type BashInput,
  type BashOutput,
} from './bash.js';
export { batchToolUseTool } from './batch-tool-use.js';
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
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
export type {
  CircuitSnapshot,
  CircuitState,
  CodeMapGraph,
  DeadCodeScanInput,
  DeadCodeScanOutput,
  DeadFile,
  DeadPackage,
  DeadSymbol,
  GraphEdge,
  GraphNode,
  ProjectIndexDaemonAvailability,
  ProjectIndexServerActivity,
  ProjectIndexServerClientHealth,
  ProjectIndexServerConnectionState,
  ProjectIndexServerConnectionStatus,
  ProjectIndexServerHealth,
} from './codebase-index/index.js';
export {
  clarifyTool,
  type ClarifyQuestionInput,
  type ClarifyOutput,
} from './clarify.js';
export {
  CircuitOpenError,
  cancelPendingReindexes,
  checkCodebaseIndexServerHealth,
  codebaseAstReplaceTool,
  codebaseImpactAnalysisTool,
  codebaseIndexStats,
  codebaseIndexTool,
  codebaseInvariantCheckTool,
  codebaseRepoMapTool,
  codebaseSearchTool,
  codebaseSkeletonTool,
  codebaseStatsTool,
  codebaseTargetedTestTool,
  deadCodeScanTool,
  enqueueReindex,
  ensureCodebaseIndexServer,
  extractDirectorySkeleton,
  extractFileSkeleton,
  generateRepoMap,
  replaceSymbolInFile,
  type FileSkeletonResult,
  type MutateSymbolOptions,
  type MutateSymbolResult,
  type RepoMapOptions,
  type RepoMapResult,
  type SkeletonOptions,
  type SkeletonSymbolRange,
  fileGraphService,
  getIndexState,
  IndexCircuitBreaker,
  IndexTimeoutError,
  indexCircuitBreaker,
  isIndexableFile,
  isIndexing,
  isIndexReady,
  onIndexStateChange,
  packageGraphService,
  resetIndexCircuitBreaker,
  resolveProjectIndexDaemonAvailability,
  runDeadCodeScan,
  runStartupIndex,
  searchCodebaseIndex,
  shutdownCodebaseIndexHost,
  shutdownCodebaseIndexServer,
  symbolGraphService,
} from './codebase-index/index.js';
export { designTool } from './design.js';
export {
  diffTool,
  type DiffInput,
  type DiffOutput,
} from './diff.js';
export { documentTool } from './document.js';
export {
  discoverE2EProjects,
  type E2EExecutionPlan,
  type E2EFramework,
  type E2EPackageManager,
  type E2EPlanOutput,
  type E2EProjectPlan,
  type E2EServerHint,
  e2ePlanTool,
} from './e2e.js';
export {
  editTool,
  type EditInput,
  type EditOutput,
} from './edit.js';
export {
  configureDangerBypass,
  configureExecPolicy,
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
export { fetchTool } from './fetch.js';
export {
  formatTool,
  type FormatContext,
  type FormatInput,
  type FormatOutput,
} from './format.js';
export {
  gitTool,
  type GitInput,
  type GitOutput,
  type GitSubcommand,
} from './git.js';
export {
  globTool,
  type GlobInput,
  type GlobOutput,
} from './glob.js';
export {
  grepTool,
  type GrepInput,
  type GrepOutput,
} from './grep.js';
export {
  installTool,
  type InstallContext,
  type InstallInput,
  type InstallOutput,
} from './install.js';
export { jsonTool } from './json.js';
export { kanbanTool } from './kanban.js';
export {
  kanbanEvidenceKey,
  kanbanEvidencePointer,
  recordKanbanVerificationEvidence,
} from './kanban-evidence-bridge.js';
export * from './languages/index.js';
export { lintTool } from './lint.js';
export { logsTool } from './logs.js';
export { forgetTool, relatedMemoryTool, rememberTool, searchMemoryTool } from './memory.js';
export { createModeTool } from './mode.js';
export { nextStepsTool } from './next-steps-tool.js';
export { outdatedTool } from './outdated.js';
export { builtinToolsPack } from './pack.js';
export {
  patchTool,
  type PatchInput,
  type PatchOutput,
} from './patch.js';
export { planTool } from './plan.js';
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
export { pwshTool, PWSH_TOOL_DESCRIPTION, type PwshInput, type PwshOutput } from './pwsh.js';
export {
  readTool,
  type ReadInput,
  type ReadOutput,
  type SymbolEntry,
} from './read.js';
export {
  replaceTool,
  type ReplaceInput,
  type ReplaceOutput,
} from './replace.js';
export { scaffoldTool } from './scaffold.js';
export {
  searchTool,
  type CacheEntry as SearchCacheEntry,
  type SearchInput,
  type SearchOutput,
  type SearchResult,
} from './search.js';
export {
  analyzeSecurityAndPerformance,
  securityAstScanTool,
  type SecurityFinding,
  type SecurityScanInput,
  type SecurityScanOutput,
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
export { makeSkillTool } from './skill.js';
export { taskTool } from './task.js';
export { testTool } from './test.js';
export { todoTool } from './todo.js';
export { toolHelpTool } from './tool-help.js';
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
  toolSearchTool,
  type ToolSearchInput,
  type ToolSearchOutput,
} from './tool-search.js';
export {
  type RegisterBuiltinToolTierOptions,
  registerBuiltinToolTier,
  selectBuiltinToolsForTier,
} from './tool-tier.js';
export { toolUseTool } from './tool-use.js';
export { treeTool } from './tree.js';
export {
  typecheckTool,
  type TypecheckInput,
  type TypecheckOutput,
} from './typecheck.js';
export {
  writeTool,
  type WriteInput,
  type WriteOutput,
} from './write.js';
