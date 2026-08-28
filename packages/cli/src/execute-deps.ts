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

import type { Agent, Context } from '@wrongstack/core/agent';
import type {
  AgentFactory,
  BrainArbiter,
  Director,
  RemoteMailbox,
} from '@wrongstack/core/coordination';
import type { BrainAutoRisk } from '@wrongstack/core/execution';
import type { JournalEntry } from '@wrongstack/core/goal';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { QueueStore } from '@wrongstack/core/storage';
import type {
  AttachmentStore,
  AutonomyStage,
  Config,
  ConfigStore,
  MemoryPort,
  Message,
  ModelsRegistry,
  ModeStore,
  PromptLoader,
  ProviderConfig,
  ResolvedProvider,
  SessionEvent,
  SessionStore,
  SessionWriter,
  SkillLoader,
  TokenCounter,
} from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { SddLifecycleResult, SddRunControl } from '@wrongstack/sdd';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import type { WebuiSessionChildOptions } from './boot/webui-session-child.js';
import type { ReadlineInputReader } from './input-reader.js';
import type { LiveSettingsInput } from './live-settings-input.js';
import type { TerminalRenderer } from './renderer.js';
import type { AutonomyMode } from './services/autonomy-mode.js';
import type { StatuslineConfigKey } from './services/statusline-config.js';
import type { SessionStats } from './session-stats.js';
import type { UpdateInfo } from './update-check.js';

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
  exposure: 'direct' | 'lazy' | 'disabled';
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
interface CoreDeps {
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
  /**
   * Forward-declared session ref owned by the host (cli-main). When an
   * in-process `/resume` swaps the agent's active writer, the resume
   * handler repoints `sessionRef.current` so provider-side
   * `getSessionId: () => sessionRef.current?.id` callbacks and the
   * record-mode `bindReplayToContainer` binding follow the resumed
   * session instead of staying pinned to the boot session.
   *
   * Optional: hosts that don't need post-resume propagation (or tests
   * that predate the refactor) can omit it; provider calls then stay
   * pinned to the boot session — same behavior as before this existed.
   */
  sessionRef?: { current: import('@wrongstack/core/types').SessionWriter | undefined } | undefined;
  /** Atomically move this process's SessionRegistry ownership after explicit resume. */
  activateSessionIdentity?:
    | ((
        sessionId: string,
        target?: import('./wiring/session-registry.js').SessionIdentityTarget,
      ) => Promise<void>)
    | undefined;
  /**
   * Resolved preflight update-check info (current/latest/outdated/checkFailed).
   * Optional — when omitted, the TUI banner simply omits the "(update
   * available)" indicator. The CLI's preflight phase is the source of
   * truth and already calls {@link checkForUpdate} once before this value
   * is consumed; the TUI reuses the result without making a second request.
   */
  updateInfo?: UpdateInfo | undefined;
  /** Internal one-session WebUI child launch metadata, when --webui-session-child is active. */
  webuiSessionChild?: WebuiSessionChildOptions | undefined;
}

/** Session + state stores. */
interface SessionDeps {
  session: SessionWriter;
  context: Context;
  attachments: AttachmentStore;
  queueStore: QueueStore;
  sessionStore?: SessionStore | undefined;
  memoryStore?: MemoryPort | undefined;
  /** Optional vector-memory store (additional to SAGE). When omitted, the
   *  embedded WebUI's `/api/vector-memory/*` routes default to disabled. */
  vectorMemoryStore?: VectorMemoryStore | undefined;
  /** Model cache directory for the vector-memory provider (shared with the
   *  CLI's on-disk transformers cache so a future cleanup never sweeps it). */
  vectorMemoryModelCacheDir?: string | undefined;
  modeStore?: ModeStore | undefined;
  mcpRegistry: MCPRegistry;
  mailbox: RemoteMailbox;
  detachTodosCheckpoint?: (() => void | Promise<void>) | undefined;
  rebindTodosCheckpoint?:
    | ((sessionId: string, sessionsDir?: string) => void | Promise<void>)
    | undefined;
  restoredMessages?: Message[] | undefined;
  restoredToolCalls?: RestoredToolCall[] | undefined;
  /** Raw prior-session JSONL events — feeds the canonical resume renderer so
   *  boot `--resume` shows tool I/O + interleaved audit markers. */
  restoredEvents?: SessionEvent[] | undefined;
  needsSetup?: boolean | undefined;
}

/** Provider/model registry, selection and switching. */
interface ProviderDeps {
  statusTracker?: import('@wrongstack/core/coordination').ProviderModelStatusTracker | undefined;
  modelsRegistry: ModelsRegistry;
  savedProviderCfg: ProviderConfig | undefined;
  resolvedProvider: ResolvedProvider | undefined;
  getPickableProviders: () => Promise<
    Array<{
      id: string;
      family: string;
      models: string[];
      modelDetails?:
        | Record<
            string,
            {
              name?: string | undefined;
              description?: string | undefined;
              tools?: boolean | undefined;
              vision?: boolean | undefined;
              reasoning?: boolean | undefined;
              maxContext?: number | undefined;
              maxOutput?: number | undefined;
              inputCost?: number | undefined;
              outputCost?: number | undefined;
              cacheReadCost?: number | undefined;
              knowledge?: string | undefined;
              releaseDate?: string | undefined;
            }
          >
        | undefined;
    }>
  >;
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
interface UiDeps {
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  /** Mutable bridge replaced by the TUI while Ink owns stdin. */
  secretInputController: {
    readSecret(prompt: string): Promise<string>;
    readText(prompt: string): Promise<string>;
  };
  stats: SessionStats;
  effectiveMaxContext: number;
  getEffectiveMaxContext?: (() => number | undefined) | undefined;
  skillLoader?: SkillLoader | undefined;
  promptLoader?: PromptLoader | undefined;
  modeId?: string | undefined;
}

/** Director, multi-agent, and fleet-related state. */
interface FleetDeps {
  director: Director | null;
  getDirector?: (() => Director | null) | undefined;
  /**
   * Drop the host-side helpers pinned to a conversation whose tab closed —
   * its explore companion and its shadow-review bookkeeping. Not a fleet
   * teardown: a background run outlives the tab that started it (that is
   * `stopSessionFleet`, on Stop). Absent for hosts with one conversation,
   * where nothing is ever released before `dispose()`.
   */
  releaseSessionHelpers?: ((sessionId: string) => void) | undefined;
  coordinatorController?: Record<string, unknown> | undefined;
  fleetRoster?: Record<string, { name: string }> | undefined;
  fleetStreamController?:
    | {
        mode: import('@wrongstack/core/types').FleetChatVerbosity;
        setMode: (mode: import('@wrongstack/core/types').FleetChatVerbosity) => void;
      }
    | undefined;
  agentsMonitorController?:
    | {
        visible: boolean;
        setVisible: (visible: boolean) => void;
      }
    | undefined;
  /**
   * Read-only view of per-subagent transcripts (AgentMonitorService
   * satisfies this structurally). Threaded into the TUI so the F3 agents
   * monitor can render the selected agent's full transcript.
   */
  agentTranscripts?:
    | {
        getTranscript(
          subagentId: string,
          limit?: number,
        ): import('@wrongstack/core/coordination').AgentTimelineEntry[];
        getAllSessions(): import('@wrongstack/core/coordination').AgentVirtualSession[];
        /** Ring + on-disk transcripts, for surfaces that survive a process restart. */
        loadSessionsFromDisk(): Promise<
          import('@wrongstack/core/coordination').AgentVirtualSession[]
        >;
      }
    | undefined;
  authHost?: import('@wrongstack/tui').AuthPanelHost | undefined;
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
}

/** Shared mutable controllers for YOLO, autonomy, interrupt, etc. */
export interface ControllerDeps {
  interruptController?:
    | {
        abortLeader: () => boolean;
      }
    | undefined;
  enhanceController?:
    | {
        enabled: boolean;
        setEnabled: (enabled: boolean) => void;
      }
    | undefined;
  getEnhancerReasoning?:
    | ((
        providerId?: string,
        modelId?: string,
      ) =>
        | import('@wrongstack/core/types').ReasoningRequest
        | undefined
        | Promise<import('@wrongstack/core/types').ReasoningRequest | undefined>)
    | undefined;
  /**
   * Reasoning-effort levels the ACTIVE model documents (models.dev
   * reasoningConfig), resolved synchronously for the /settings picker.
   * Undefined = vocabulary undocumented; the picker then cycles the full
   * canonical set. Mirrors getEnhancerReasoning's active-model fast path
   * (same freshness contract: tracks model switches via the builder).
   */
  getActiveModelReasoningEffortLevels?: (() => string[] | undefined) | undefined;
  /** Build an ephemeral Provider for retrying a failed refinement on another model (no session switch). */
  buildEnhancerProvider?:
    | ((
        providerId: string,
        modelId: string,
      ) => Promise<import('@wrongstack/core/types').Provider | undefined>)
    | undefined;
  /** Resolve the one-key "retry with another model" fallback ref for refinement failures. */
  getEnhanceFallbackRef?: (() => string | undefined) | undefined;
  /** Resolve the dedicated refiner target for the initial refinement attempt. */
  getConfiguredRefinerRef?: (() => string | undefined) | undefined;
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
  getBrainData?: (() => BrainData) | undefined;
  onBrainRiskLevel?:
    | ((level: 'off' | 'low' | 'medium' | 'high' | 'all') => string | undefined)
    | undefined;
  getBrainLog?: (() => BrainLogEntry[]) | undefined;
  brain?: BrainArbiter | undefined;
  brainSettings?:
    | {
        maxAutoRisk: BrainAutoRisk;
        mode?: import('@wrongstack/core/coordination').BrainEscalationMode | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
      }
    | undefined;
  /** Live-editable Brain config owner (WebUI brain.config.* + TUI panel setters). */
  brainRuntime?: import('@wrongstack/core/execution').BrainRuntime | undefined;
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
  getEternalEngine?:
    | (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null)
    | undefined;
  getParallelEngine?:
    | (() => import('@wrongstack/core/execution').ParallelEternalEngine | null)
    | undefined;
  getSddRun?: (() => SddRunControl | null) | undefined;
  onSddLifecycle?:
    | ((
        op: 'cleanup_worktrees' | 'rollback' | 'destroy',
        opts?: { revertMerged?: boolean },
      ) => Promise<SddLifecycleResult>)
    | undefined;
  subscribeEternalIteration?: ((fn: (entry: JournalEntry) => void) => () => void) | undefined;
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
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
