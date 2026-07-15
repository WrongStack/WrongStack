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
export { bashTool } from './bash.js';
export { batchToolUseTool } from './batch-tool-use.js';
export * from './browser/index.js';
// builtinTools moved to './builtin.ts' so consumers that only need a subset of
// tools don't transitively import all 30. Use `@wrongstack/tools/builtin`.
export { builtinTools, OPTIONAL_TOOLS, TIER1_TOOLS, TIER2_TOOLS, TIER3_TOOLS } from './builtin.js';
export {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
export type { CircuitSnapshot, CircuitState } from './codebase-index/index.js';
export {
  CircuitOpenError,
  cancelPendingReindexes,
  codebaseIndexStats,
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseStatsTool,
  enqueueReindex,
  getIndexState,
  IndexCircuitBreaker,
  IndexTimeoutError,
  indexCircuitBreaker,
  isIndexableFile,
  isIndexing,
  isIndexReady,
  onIndexStateChange,
  resetIndexCircuitBreaker,
  runStartupIndex,
  searchCodebaseIndex,
  shutdownCodebaseIndexHost,
} from './codebase-index/index.js';
export { designTool } from './design.js';
export { diffTool } from './diff.js';
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
export { editTool } from './edit.js';
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
export { fetchTool } from './fetch.js';
export { formatTool } from './format.js';
export { gitTool } from './git.js';
export { globTool } from './glob.js';
export { grepTool } from './grep.js';
export { installTool } from './install.js';
export { jsonTool } from './json.js';
export { kanbanTool } from './kanban.js';
export * from './languages/index.js';
export { lintTool } from './lint.js';
export { logsTool } from './logs.js';
export { forgetTool, relatedMemoryTool, rememberTool, searchMemoryTool } from './memory.js';
export { createModeTool } from './mode.js';
export { outdatedTool } from './outdated.js';
export { builtinToolsPack } from './pack.js';
export { patchTool } from './patch.js';
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
export { readTool } from './read.js';
export { replaceTool } from './replace.js';
export { scaffoldTool } from './scaffold.js';
export { searchTool } from './search.js';
export {
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
  SESSION_KANBAN_COLUMNS,
} from './session-kanban.js';
export { makeSkillTool } from './skill.js';
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
export { toolSearchTool } from './tool-search.js';
export { toolUseTool } from './tool-use.js';
export { treeTool } from './tree.js';
export { typecheckTool } from './typecheck.js';
export { writeTool } from './write.js';
