import type { AgentPipelines, FallbackProfileManager } from '@wrongstack/core/agent';
import type { BrainArbiter, ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { HookRunner } from '@wrongstack/core/hooks';
import type { Container, EventBus } from '@wrongstack/core/kernel';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type {
  ConfigStore,
  ModelsRegistry,
  Renderer,
  SecretScrubber,
  SessionWriter,
  SkillLoader,
  SystemPromptBuilder,
  TokenCounter,
} from '@wrongstack/core/types';

export interface MultiAgentDeps {
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  configStore: ConfigStore;
  /**
   * Models catalog used to resolve a subagent provider's real context
   * window. Without it, an `openai-compatible` subagent falls back to the
   * 32k family default. Optional so callers/tests that do not wire it still
   * build providers.
   */
  modelsRegistry?: ModelsRegistry | undefined;
  events: EventBus;
  systemPromptBuilder: SystemPromptBuilder;
  session: SessionWriter;
  tokenCounter: TokenCounter;
  projectRoot: string;
  cwd: string;
  secretScrubber: SecretScrubber;
  /** Loader used to resolve the roster's per-role skill names. */
  skillLoader?: SkillLoader | undefined;
  renderer?: Renderer | undefined;
  /** Shared live fallback profile manager from the runtime container. */
  fallbackProfileManager: FallbackProfileManager;
  /**
   * Optional trusted control-plane hook installed on every in-process
   * subagent pipeline. This is host wiring, never a model-visible capability.
   */
  installToolBoundary?: ((pipelines: AgentPipelines) => void) | undefined;
  /**
   * Optional hook runner applied to every spawned subagent's ToolExecutor.
   * The CLI wires a dedicated WrongTrace-only runner here so worker edits
   * pass the same lock gate as the leader. Deliberately NOT the leader's
   * own HookRegistry: shell hooks from `config.hooks` are a leader-session
   * automation surface and must not silently replay on workers.
   */
  hookRunner?: HookRunner | undefined;
}

/**
 * Per-session options for the multi-agent host. Director Mode is always
 * active — all lifecycle, manifest writing, and FleetBus features are
 * available without a promotion flag.
 */
export interface MultiAgentHostOptions {
  /** Absolute file path the director writes its fleet manifest to. */
  manifestPath?: string | undefined;
  /** Absolute path to the fleet's shared scratchpad directory. */
  sharedScratchpadPath?: string | undefined;
  /** Absolute path to the directory under which per-subagent JSONL transcripts land. */
  sessionsRoot?: string | undefined;
  /** Director run id for namespacing per-subagent JSONLs. */
  directorRunId?: string | undefined;
  /** Base directory for fleet artifacts. */
  fleetRoot?: string | undefined;
  /** Absolute path the director writes its live state checkpoint to. */
  stateCheckpointPath?: string | undefined;
  /** Fleet-wide cost ceiling for the director. */
  directorBudget?: {
    maxCostUsd?: number | undefined;
    maxTokens?: number | undefined;
  };
  /** Lifetime spawn cap for this Director. CLI default: 64. */
  maxSpawns?: number | undefined;
  /**
   * Winning configuration sources for concurrency / lifetime spawn ceilings
   * (issue #323). Surfaced in `/fleet status` and WebUI budget views.
   */
  budgetSources?:
    | {
        maxConcurrent?: import('./budget-source.js').FleetBudgetSource | undefined;
        maxSpawns?: import('./budget-source.js').FleetBudgetSource | undefined;
      }
    | undefined;
  /** Maximum auto-extensions per subagent per budget kind. */
  maxBudgetExtensions?: number | undefined;
  /** Optional global Brain arbiter for director-level policy decisions. */
  brain?: BrainArbiter | undefined;
  /** Maximum number of subagent tasks that may run concurrently. */
  maxConcurrent?: number | undefined;
  /** Maximum time a spawned/between-task subagent may remain idle. */
  subagentIdleTimeoutMs?: number | undefined;
  /** Retire a completed one-shot subagent immediately when it stays idle. */
  retireSubagentOnTaskComplete?: boolean | undefined;
  /** Live max context window for the leader model. */
  getLeaderMaxContext?: (() => number) | undefined;
  /** Debounce window for state-checkpoint writes in milliseconds. */
  checkpointDebounceMs?: number | undefined;
  /** Session writer the director forwards task lifecycle events to. */
  sessionWriter?: SessionWriter | undefined;
  /** Root session trace ID for correlating subagent storage events. */
  traceId?: string | undefined;
  /** Optional AgentMonitorService for tracking subagent conversations. */
  agentMonitor?: import('@wrongstack/core/coordination').AgentMonitorService | undefined;
  /** Called when the host auto-starts the Shadow Agent. */
  onShadowAgentStarted?: ((subagentId: string) => void) | undefined;
  /** Called when the tracked Shadow Agent stops. */
  onShadowAgentStopped?: ((subagentId: string) => void) | undefined;
  /** Resolved shared-mailbox project directory. */
  mailboxProjectDir?: string | undefined;
  /** Mailbox id of this session's leader, for task-result report-back. */
  getLeaderMailboxId?: (() => string | undefined) | undefined;
  /** Live getter for the leader's current mode id. */
  getLeaderMode?: (() => string | undefined) | undefined;
  /** Shared provider/model status tracker. */
  statusTracker?: ProviderModelStatusTracker | undefined;
}
