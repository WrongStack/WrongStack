/**
 * execute-deps — Focused sub-interfaces for the execute() dispatch.
 *
 * Replaces the monolithic ExecutionDeps (~80 fields) with composed
 * sub-interfaces so each concern is testable and extendable in
 * isolation. The top-level ExecuteDeps is the union of all sub-types.
 *
 * Step 1 of the cli-main/ExecutionDeps refactor plan:
 *   docs/plans/cli-main-executiondeps-refactor.md
 */

import type {
  Agent,
  AttachmentStore,
  AutonomyStage,
  BrainArbiter,
  BrainAutoRisk,
  Config,
  ConfigStore,
  Context,
  Director,
  EventBus,
  GlobalMailbox,
  JournalEntry,
  MemoryStore,
  Message,
  ModelsRegistry,
  ModeStore,
  ProviderConfig,
  RecoveryLock,
  ResolvedProvider,
  SessionStore,
  SessionWriter,
  SlashCommandRegistry,
  SkillLoader,
  PromptLoader,
  TokenCounter,
  WstackPaths,
  QueueStore,
  AgentFactory,
} from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { SddRunControl, SddLifecycleResult } from '@wrongstack/sdd';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import type { SessionStats } from './session-stats.js';
import type { StatuslineConfigKey } from './slash-commands/statusline.js';
import type { AutonomyMode } from './slash-commands/autonomy.js';
import type { LiveSettingsInput } from './execution.js';

// ─── Shared picker types (duplicated from execution.ts to break the import cycle) ───

export interface PluginPickerItem {
  name: string;
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  lockable?: boolean | undefined;
}

export interface McpPickerItem {
  name: string;
  enabled: boolean;
  status: string;
  transport: string;
  description?: string | undefined;
  toolCount: number;
  lazy?: boolean | undefined;
}

export interface ToolPickerItem {
  name: string;
  owner: string;
  category: string;
  enabled: boolean;
  mutating: boolean;
  permission: string;
  descMode: 'extend' | 'simple';
  description: string;
}

export interface BrainData {
  riskLevel: 'off' | 'low' | 'medium' | 'high' | 'all';
  log: Array<{ kind: string; question: string; outcome: string; age: string }>;
}

export interface BrainLogEntry {
  at: number;
  kind: string;
  question: string;
  outcome: string;
}

export interface RestoredToolCall {
  name: string;
  id: string;
  durationMs: number;
  ok: boolean;
  outputBytes?: number | undefined;
  outputTokens?: number | undefined;
  outputLines?: number | undefined;
}

// ─── Sub-interfaces ───────────────────────────────────────────────

/** Always-required runtime essentials. */
export interface CoreDeps {
  agent: Agent;
  events: EventBus;
  config: Config;
  configStore: ConfigStore;
  wpaths: WstackPaths;
  projectRoot: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  slashRegistry: SlashCommandRegistry;
  tokenCounter: TokenCounter;
  recoveryLock: RecoveryLock;
}

/** Session + state stores. */
export interface SessionDeps {
  session: SessionWriter;
  context: Context;
  attachments: AttachmentStore;
  queueStore: QueueStore;
  sessionStore?: SessionStore | undefined;
  memoryStore?: MemoryStore | undefined;
  modeStore?: ModeStore | undefined;
  mcpRegistry: MCPRegistry;
  mailbox: GlobalMailbox;
  detachTodosCheckpoint?: (() => void | Promise<void>) | undefined;
  restoredMessages?: Message[] | undefined;
  restoredToolCalls?: RestoredToolCall[] | undefined;
  needsSetup?: boolean | undefined;
}

/** Provider/model registry, selection and switching. */
export interface ProviderDeps {
  modelsRegistry: ModelsRegistry;
  savedProviderCfg: ProviderConfig | undefined;
  resolvedProvider: ResolvedProvider | undefined;
  getPickableProviders: () => Promise<Array<{ id: string; family: string; models: string[] }>>;
  switchProviderAndModel: (
    providerId: string,
    modelId: string,
  ) => string | null | Promise<string | null>;
  onModelContextResolved?:
    | ((providerId: string, modelId: string, maxContext: number) => void)
    | undefined;
  /** Per-task agent factory for the CLI-hosted WebUI's SDD wizard. */
  sddSubagentFactory?: AgentFactory | undefined;
}

/** I/O surface components. */
export interface UiDeps {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  stats: SessionStats;
  effectiveMaxContext: number;
  getEffectiveMaxContext?: (() => number | undefined) | undefined;
  skillLoader?: SkillLoader | undefined;
  promptLoader?: PromptLoader | undefined;
  modeId?: string | undefined;
}

/** Director, multi-agent, and fleet-related state. */
export interface FleetDeps {
  director: Director | null;
  getDirector?: (() => Director | null) | undefined;
  coordinatorController?: Record<string, unknown> | undefined;
  fleetRoster?: Record<string, { name: string }> | undefined;
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
    mode: import('@wrongstack/core').FleetChatVerbosity;
    setMode: (mode: import('@wrongstack/core').FleetChatVerbosity) => void;
  } | undefined;
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  } | undefined;
  /**
   * Read-only view of per-subagent transcripts (AgentMonitorService
   * satisfies this structurally). Threaded into the TUI so the F3 agents
   * monitor can render the selected agent's full transcript.
   */
  agentTranscripts?: {
    getTranscript(subagentId: string, limit?: number): import('@wrongstack/core/coordination').AgentTimelineEntry[];
  } | undefined;
  authHost?: import('@wrongstack/tui').AuthPanelHost | undefined;
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
}

/** Shared mutable controllers for YOLO, autonomy, interrupt, etc. */
export interface ControllerDeps {
  interruptController?: {
    abortLeader: () => boolean;
  } | undefined;
  enhanceController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  getEnhancerReasoning?: (() => import('@wrongstack/core').ReasoningRequest | undefined) | undefined;
  /** Build an ephemeral Provider for retrying a failed refinement on another model (no session switch). */
  buildEnhancerProvider?:
    | ((providerId: string, modelId: string) => Promise<import('@wrongstack/core').Provider | undefined>)
    | undefined;
  /** Resolve the one-key "retry with another model" fallback ref for refinement failures. */
  getEnhanceFallbackRef?: (() => string | undefined) | undefined;
  statuslineHiddenItems: StatuslineConfigKey[];
  setStatuslineHiddenItems: (items: StatuslineConfigKey[]) => void;
  saveStatuslineHiddenItems: (items: StatuslineConfigKey[]) => Promise<void>;
  getYolo?: (() => boolean) | undefined;
  onYolo?: ((setTo?: boolean) => boolean) | undefined;
  getAutonomy?: (() => AutonomyMode) | undefined;
  onAutonomy?: ((mode: AutonomyMode) => void) | undefined;
  getNextPredict?: (() => boolean) | undefined;
  applyLiveSettings?: ((s: LiveSettingsInput) => void) | undefined;
  onCountdownTick?: ((remainingSeconds: number) => boolean | void) | undefined;
}

/** Plugin, MCP, tool, brain picker callbacks. */
export interface PickerDeps {
  getPluginItems?: (() => PluginPickerItem[]) | undefined;
  onPluginToggle?:
    | ((name: string) => Promise<{
        items: PluginPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  getMcpServers?: (() => McpPickerItem[]) | undefined;
  onMcpToggle?:
    | ((name: string) => Promise<{
        items: McpPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  onMcpRestart?:
    | ((name: string) => Promise<{
        items: McpPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  getToolsItems?: (() => ToolPickerItem[]) | undefined;
  onToolToggle?:
    | ((name: string) => Promise<{
        items: ToolPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  getBrainData?:
    | (() => BrainData)
    | undefined;
  onBrainRiskLevel?:
    | ((level: 'off' | 'low' | 'medium' | 'high' | 'all') => string | undefined)
    | undefined;
  getBrainLog?:
    | (() => BrainLogEntry[])
    | undefined;
  brain?: BrainArbiter | undefined;
  brainSettings?:
    | {
        maxAutoRisk: BrainAutoRisk;
        mode?: import('@wrongstack/core').BrainEscalationMode | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
      }
    | undefined;
  /** Live-editable Brain config owner (WebUI brain.config.* + TUI panel setters). */
  brainRuntime?: import('@wrongstack/core').BrainRuntime | undefined;
  getShadowData?:
    | (() => { activeId: string | null; running: boolean; model: string; intervalMs: number })
    | undefined;
  onShadowStart?: (() => Promise<string | undefined>) | undefined;
  onShadowStop?: (() => Promise<string | undefined>) | undefined;
}

/** Eternal/SDD/autonomy lifecycle callbacks. */
export interface LifecycleDeps {
  getSuggestions?: (() => string[]) | undefined;
  getAutoSuggestions?: (() => string[]) | undefined;
  onSuggestionsParsed?: ((suggestions: string[] | null) => void) | undefined;
  autonomyNextPrompt?: string | undefined;
  autoProceedDelayMs?: number | undefined;
  autoProceedMaxIterations?: number | undefined;
  onValidateAutoProceed?:
    | ((suggestion: string, lastOutput: string) => Promise<boolean>)
    | undefined;
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  getSddRun?: (() => SddRunControl | null) | undefined;
  onSddLifecycle?:
    | ((
        op: 'cleanup_worktrees' | 'rollback' | 'destroy',
        opts?: { revertMerged?: boolean },
      ) => Promise<SddLifecycleResult>)
    | undefined;
  subscribeEternalIteration?:
    | ((fn: (entry: JournalEntry) => void) => () => void)
    | undefined;
  subscribeEternalStage?:
    | ((fn: (stage: AutonomyStage) => void) => () => void)
    | undefined;
  onDestroy?: (() => void) | undefined;
  onCoordinatorStop?: (() => void) | undefined;
}

// ─── Composed top-level type ──────────────────────────────────────

export interface ExecuteDeps {
  core: CoreDeps;
  session: SessionDeps;
  provider: ProviderDeps;
  ui: UiDeps;
  fleet: FleetDeps;
  controllers: ControllerDeps;
  picker?: PickerDeps | undefined;
  lifecycles?: LifecycleDeps | undefined;
}
