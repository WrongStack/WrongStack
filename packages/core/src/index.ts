export * from './kernel/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export * from './defaults/index.js';
export * from './skills/index.js';
export * from './storage/index.js';
export * from './security-scanner/index.js';
export {
  FleetManager,
  type FleetManagerOptions,
} from './coordination/fleet-manager.js';
export { createMcpControlTool, type MCPRegistryHandle } from './tools/mcp-control.js';
// Re-export safeParse explicitly at the top-level export for consumers
// who import from '@wrongstack/core' directly (e.g. providers package).
export { safeParse, safeStringify, sanitizeJsonString } from './utils/safe-json.js';
export {
  Agent,
  type RunResult,
  type AgentInit,
  type AgentInput,
  type AgentPipelines,
  type UserInputPayload,
  createDefaultPipelines,
  DEFAULT_MAX_ITERATIONS,
} from './core/agent.js';
export {
  parseContinueDirective,
  type ContinueDirective,
  makeContinueToNextIterationTool,
} from './core/continue-to-next-iteration.js';
export {
  setBtwNote,
  consumeBtwNotes,
  pendingBtwCount,
  buildBtwBlock,
} from './core/btw.js';
export { Context, type ContextInit, type RunOptions, type TodoItem } from './core/context.js';
export { extractRunEnv, type RunEnv } from './core/run-env.js';
export {
  ConversationState,
  wrapAsState,
  type ReadonlyConversationState,
  type StateChange,
  type StateChangeHandler,
} from './core/conversation-state.js';
export {
  InputBuilder,
  type InputBuilderOptions,
  type InputBuilderEvent,
} from './core/input-builder.js';
export {
  DefaultSystemPromptBuilder,
  LAYER_1_IDENTITY,
  type DefaultSystemPromptBuilderOptions,
} from './core/system-prompt-builder.js';
export { ToolRegistry } from './registry/tool-registry.js';
export type { ToolWrapper } from './registry/tool-registry.js';
export { ProviderRegistry, type ProviderFactory } from './registry/provider-registry.js';
export {
  SlashCommandRegistry,
  type SlashCommand,
} from './registry/slash-command-registry.js';
export { DefaultPluginAPI, type PluginAPIInit } from './plugin/api.js';
export {
  loadPlugins,
  unloadPlugins,
  KERNEL_API_VERSION,
  type LoadPluginsOptions,
} from './plugin/loader.js';

// Extension API
export {
  ExtensionRegistry,
  type AgentExtension,
  type BeforeRunHook,
  type AfterRunHook,
  type BeforeIterationHook,
  type AfterIterationHook,
  type OnErrorHook,
  type ProviderRunnerWrapper,
  type BeforeToolExecutionHook,
  type AfterToolExecutionHook,
} from './extension/index.js';

// Explicit type re-exports needed because tsup DTS deduplication drops types
// that are reachable through both types/ and defaults/ export chains.
// Consumers (e.g. @wrongstack/providers) import these directly from '@wrongstack/core'.
export type {
  ModelsRegistry,
  ResolvedProvider,
  ResolvedModel,
  WireFamily,
  ModelsDevPayload,
  ModelsDevProvider,
} from './types/models-registry.js';
export type { Logger, LogLevel } from './types/logger.js';
export type { TokenCounter } from './types/token-counter.js';
export type { ProviderRunner, RunProviderOptions } from './types/provider-runner.js';
export type { SecretVault } from './types/secret-vault.js';
export type { Compactor, CompactReport } from './types/compactor.js';
export { DefaultSecretScrubber } from './security/secret-scrubber.js';
export type { SecretScrubber } from './types/secret-scrubber.js';
export {
  HybridCompactor,
  IntelligentCompactor,
  SelectiveCompactor,
  AutoCompactionMiddleware,
  type CompactorOptions,
  type IntelligentCompactorOptions,
  type SelectiveCompactorOptions,
} from './defaults/index.js';
export {
  CONTEXT_WINDOW_MODES,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  formatContextWindowModeList,
  getContextWindowMode,
  isContextWindowModeId,
  listContextWindowModes,
  resolveContextWindowPolicy,
  type ContextWindowAggressiveOn,
  type ContextWindowConfigLike,
  type ContextWindowMode,
  type ContextWindowModeId,
  type ContextWindowPolicy,
  type ContextWindowThresholds,
} from './types/context-window.js';

// ─── AutoPhase — Otonom faz tabanlı iş akışı ────────────────────────────────
export {
  AutoPhaseRunner,
  createAutoPhaseFromTaskGraph,
  AutoPhasePlanner,
  PhaseOrchestrator,
  PhaseGraphBuilder,
  PhaseStore,
  CheckpointManager,
  type AutoPhasePlannerOptions,
  type AutoPhasePlanResult,
  type AutoPhaseRunnerOptions,
  type PhaseOrchestratorOptions,
  type PhaseGraphBuilderOptions,
  type PhaseStoreOptions,
  type CheckpointManagerOptions,
  type Checkpoint,
  type PhaseTemplate,
  type PhaseGraph,
  type PhaseNode,
  type PhaseStatus,
  type PhaseProgress,
  type PhaseEventMap,
  type PhaseEventName,
  type PhaseExecutionContext,
  type AutoPhaseOptions,
  type PhaseFilter,
  type PhaseSort,
} from './autophase/index.js';
