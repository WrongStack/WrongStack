export { readTool } from './read.js';
export { writeTool } from './write.js';
export { editTool } from './edit.js';
export { replaceTool } from './replace.js';
export { globTool } from './glob.js';
export { grepTool } from './grep.js';
export { bashTool } from './bash.js';
export {
  resolveSessionShell,
  ensureSessionShell,
  normalizeShell,
  type ResolveSessionShellDeps,
  type EnsureSessionShellOptions,
} from './_session-shell.js';
export type { BashShell } from './_shell-pick.js';
export { execTool } from './exec.js';
export {
  configureExecPolicy,
  resetExecPolicy,
  isExecCommandAllowed,
  getExecAllowlist,
} from './exec.js';
export { fetchTool } from './fetch.js';
export { searchTool } from './search.js';
export { todoTool } from './todo.js';
export { planTool } from './plan.js';
export { gitTool } from './git.js';
export { patchTool } from './patch.js';
export { jsonTool } from './json.js';
export { diffTool } from './diff.js';
export { treeTool } from './tree.js';
export { lintTool } from './lint.js';
export { formatTool } from './format.js';
export { typecheckTool } from './typecheck.js';
export { testTool } from './test.js';
export { installTool } from './install.js';
export { auditTool } from './audit.js';
export { outdatedTool } from './outdated.js';
export { logsTool } from './logs.js';
export { documentTool } from './document.js';
export { scaffoldTool } from './scaffold.js';
export { designTool } from './design.js';
export { toolSearchTool } from './tool-search.js';
export { toolUseTool } from './tool-use.js';
export { batchToolUseTool } from './batch-tool-use.js';
export { toolHelpTool } from './tool-help.js';
export { rememberTool, forgetTool, searchMemoryTool, relatedMemoryTool } from './memory.js';
export { createModeTool } from './mode.js';
export { getProcessRegistry, _resetProcessRegistry, type ProcessRegistryImpl, type KillOpts, type RegistryStats, type TrackedProcess, type BreakerCountdown } from './process-registry.js';
export { CircuitBreaker, type CircuitBreakerSnapshot, type CircuitBreakerConfig } from './circuit-breaker.js';
export {
  getPersistentProcessRegistry,
  resetPersistentProcessRegistry,
  type PersistentProcessEntry,
  type PersistentRegistryData,
} from './process-registry-persistent.js';
export {
  getProcessGuardian,
  startProcessGuardian,
  stopProcessGuardian,
  type ProcessGuardianConfig,
} from './process-guardian.js';
export {
  createGlobalPsSlashCommand,
  formatGlobalStatus,
  formatInstanceList,
  formatInstanceSummary,
  listInstances,
  getInstanceCount,
  type GlobalProcessStatus,
  type InstanceInfo,
  type InstanceListOptions,
} from './ps-slash.js';
export {
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseStatsTool,
  runStartupIndex,
  enqueueReindex,
  isIndexableFile,
  cancelPendingReindexes,
  isIndexReady,
  isIndexing,
  getIndexState,
  onIndexStateChange,
  searchCodebaseIndex,
  codebaseIndexStats,
  shutdownCodebaseIndexHost,
  IndexCircuitBreaker,
  indexCircuitBreaker,
  resetIndexCircuitBreaker,
  CircuitOpenError,
  IndexTimeoutError,
} from './codebase-index/index.js';
export type { CircuitState, CircuitSnapshot } from './codebase-index/index.js';

// builtinTools moved to './builtin.ts' so consumers that only need a subset of
// tools don't transitively import all 30. Use `@wrongstack/tools/builtin`.
export { builtinTools, OPTIONAL_TOOLS, TIER1_TOOLS, TIER2_TOOLS, TIER3_TOOLS } from './builtin.js';
export { builtinToolsPack } from './pack.js';

// Tool icon mapping — shared across all UIs (WebUI, TUI, REPL)
export {
  TOOL_ICON_MAP,
  getToolIcon,
  TOOL_ICON_CONFIG,
  FALLBACK_ICON,
  type ToolIconId,
  type ToolIconConfig,
} from './tool-icon-map.js';